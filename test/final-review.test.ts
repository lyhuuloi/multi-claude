import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, lstatSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lifecycleFixture } from './lifecycle-support.js';
import { healthFixture } from './health-support.js';
import { profileFixture, catalog, repo } from './support.js';
import { approveTree } from '../src/approved-tree.js';
import { ChangeRecord } from '../src/change-records.js';
import { mapReference } from '../src/reference-mapping.js';

const text = (path: string) => readFileSync(path, 'utf8');

for (const root of ['Desktop', 'policy']) {
  for (const delay of ['source verification', 'Code-first build'] as const) {
    test(`S13 S25 absent ${root} roots cannot become adopted during ${delay}`, async () => {
      const f = lifecycleFixture();
      const location = join(f.data, root === 'Desktop' ? 'studio/desktop' : 'studio/desktop-3p');
      let introduced = false;
      const introduce = () => {
        f.put(join(location, 'unapproved'), 'keep unapproved directory');
        introduced = true;
      };
      const tool = f.desktop.tool;
      let verifications = 0;
      f.desktop.tool = async (file, args) => {
        const result = await tool(file, args);
        if (args.at(-1) === f.source && ++verifications === 3 && delay === 'source verification') {
          introduce();
        }
        return result;
      };
      f.services.checkpoint = stage => {
        if (!introduced && delay === 'Code-first build' && stage === 'add-shell') {
          introduce();
        }
      };
      const paired = delay === 'Code-first build';
      const result = await f.invoke(['add', 'studio', '--target', paired ? 'paired' : 'desktop'],
        [...(paired ? f.pairedAnswers : f.desktopAnswers), 'y']);
      assert.ok(introduced, result.text);
      assert.notEqual(result.code, 0, result.text);
      assert.equal(text(join(location, 'unapproved')), 'keep unapproved directory');
      assert.equal(existsSync(join(location, '.bcm-root.json')), false);
      assert.equal(catalog(f).profiles.some(profile => profile.desktop), false);
    });
  }
}

for (const role of ['Code', 'Desktop', 'policy', 'launcher', 'copy']) {
  test(`S13 S25 planned-absent ${role} leaves refuse a late existing directory`, () => {
    const f = profileFixture();
    const target = join(f.home, 'destinations', role);
    f.io.directory(dirname(target));
    const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], () => {});
    const stage = join(transaction.directory, 'source');
    transaction.allow(stage);
    transaction.createStaging(stage);
    f.io.write(join(stage, 'owned'), 'only operation material', null);
    transaction.sealStaging(stage);
    transaction.allow(target);
    const create = transaction.createExclusiveDirectory.bind(transaction);
    let identity = 0;
    transaction.createExclusiveDirectory = path => {
      if (path === target) {
        f.io.directory(target);
        identity = lstatSync(target).ino;
      }
      return create(path);
    };
    assert.throws(() => role === 'Desktop' ? transaction.createExclusiveDirectory(target)
      : transaction.moveTree(stage, target), /planned-absent directory appeared/);
    assert.ok(identity);
    assert.equal(lstatSync(target).ino, identity);
    assert.equal(existsSync(join(target, 'owned')), false);
    assert.equal(transaction.rollback(), 0);
    assert.equal(lstatSync(target).ino, identity);
  });
}

const renameCheckpoints = [
  'rename-moved-code', 'rename-before-desktop', 'rename-moved-desktop', 'rename-before-policy',
  'rename-moved-policy', 'rename-before-launcher', 'rename-moved-launcher', 'rename-moved',
  'rename-shell', 'rename-launcher', 'rename-fences',
];
const removeCheckpoints = [
  'remove-before-copy', 'remove-shell', 'remove-before-code', 'remove-before-desktop', 'remove-staged', 'remove-fences',
];
for (const action of ['rename', 'remove'] as const) {
  for (const checkpoint of action === 'rename' ? renameCheckpoints : removeCheckpoints) {
    test(`S24 S28 S32 ${action} crash recovery restores roots after ${checkpoint}`, async () => {
      const f = healthFixture();
      assert.equal((await f.addPaired()).code, 0);
      const profile = structuredClone(f.profile());
      const codeFile = join(profile.code!.location, 'notes');
      const desktopFile = join(profile.desktop!.location, 'chats');
      f.put(codeFile, 'original Code data');
      f.put(desktopFile, 'original Desktop data');
      const shell = text(profile.code!.rc);
      const child = spawnSync(process.execPath, [join(repo, 'dist/test/lifecycle-crash-worker.js'),
        f.home, action, checkpoint], { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
      assert.equal(child.status, 89, child.stderr);
      const inspect = f.services.identities.inspect;
      f.services.identities.inspect = async pid => pid === child.pid ? { state: 'dead' } : inspect(pid);
      const claims = catalog(f).recoveryClaims;
      assert.equal(claims.length, 1);
      const result = await f.invoke(['doctor', '--recover', claims[0]!.operationId], ['y']);
      assert.equal(result.code, 0, result.text);
      assert.deepEqual(f.profile(), profile);
      assert.equal(text(codeFile), 'original Code data');
      assert.equal(text(desktopFile), 'original Desktop data');
      assert.equal(text(profile.code!.rc), shell);
      assert.equal(existsSync(claims[0]!.location), false);
      assert.deepEqual(catalog(f).recoveryClaims, []);
    });
  }
}

const refused = [
  ['semicolon', '/old/code/a;b/../../plugins/trusted'],
  ['exclusion', '!(/old/code/plugins/trusted)'],
  ['substitution', '/old/code/$(part)/../../plugins/trusted'],
  ['backtick', '/old/code/`part`/../../plugins/trusted'],
  ['star', '/old/code/*/plugins/trusted'],
  ['question', '/old/code/?/plugins/trusted'],
  ['brackets', '/old/code/[ab]/plugins/trusted'],
  ['braces', '/old/code/{a,b}/plugins/trusted'],
  ['parent segment', '/old/code/a/../plugins/trusted'],
  ['current segment', '/old/code/./plugins/trusted'],
];
for (const [kind, value] of refused) {
  test(`S57 S58 reference allowlist preserves and reports ${kind}`, () => {
    for (const command of [false, true]) {
      const warnings: string[] = [];
      const result = mapReference(value!, command, {
        source: '/old/code', destination: '/new/code', home: '/synthetic', required: true,
        warn: message => warnings.push(message),
      });
      assert.equal(result, value);
      assert.equal(warnings.length, 1);
    }
  });
}

test('S57 S58 reference allowlist still rebases a plain valid path', () => {
  for (const command of [false, true]) {
    const mapping = {
      source: '/old/code', destination: '/new/code', home: '/synthetic', required: true,
      warn: () => assert.fail('A plain valid reference must not produce a finding'),
    };
    assert.equal(mapReference('/old/code/plugins/trusted', command, mapping), '/new/code/plugins/trusted');
    assert.equal(mapReference("cat '/old/code/plain file.js'", command, mapping), "cat '/new/code/plain file.js'");
  }
});

test('S24 S28 move publication rechecks its approved source after exclusive destination creation', () => {
  const f = profileFixture();
  const from = join(f.home, 'original');
  const to = join(f.home, 'destination');
  f.io.directory(from);
  f.io.write(join(from, 'owned'), 'original approved content', null);
  const approval = approveTree(from, f.io);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [from, to], () => {});
  const create = transaction.createExclusiveDirectory.bind(transaction);
  transaction.createExclusiveDirectory = path => {
    const result = create(path);
    if (path === to) {
      renameSync(from, from + '-approved');
      f.io.directory(from);
      f.io.write(join(from, 'unapproved'), 'preserve substitute', null);
    }
    return result;
  };
  assert.throws(() => transaction.moveTree(from, to, true, approval), /source tree changed/);
  assert.equal(transaction.rollback(), 0);
  assert.equal(text(join(from, 'unapproved')), 'preserve substitute');
  assert.equal(text(join(from + '-approved', 'owned')), 'original approved content');
  assert.equal(existsSync(to), false);
});
