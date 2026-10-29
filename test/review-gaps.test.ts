import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, renameSync, existsSync, readdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lifecycleFixture } from './lifecycle-support.js';
import { healthFixture } from './health-support.js';
import { profileFixture, catalog, installProfile, repo } from './support.js';
import { approveTree } from '../src/approved-tree.js';
import { ChangeRecord } from '../src/change-records.js';
import { CatalogSession } from '../src/profile-actions.js';
import { clearPolicy } from '../src/desktop-policy.js';
import { mapReference } from '../src/reference-mapping.js';
import { shellBody } from '../src/shell-entries.js';

const text = (path: string) => readFileSync(path, 'utf8');

for (const delay of ['source verification', 'Code-first build'] as const) {
  test(`S24 S25 Desktop adoption preserves a substitute during ${delay}`, async () => {
    const f = lifecycleFixture();
    const location = join(f.data, 'studio/desktop');
    f.put(join(location, 'existing'), 'approved user data');
    let swapped = false;
    const swap = () => {
      renameSync(location, location + '-approved');
      f.put(join(location, 'substitute'), 'keep unrelated data');
      swapped = true;
    };
    const tool = f.desktop.tool;
    let verifications = 0;
    f.desktop.tool = async (file, args) => {
      const result = await tool(file, args);
      if (args.at(-1) === f.source && ++verifications === 3 && delay === 'source verification') {
        swap();
      }
      return result;
    };
    f.services.checkpoint = stage => {
      if (delay === 'Code-first build' && stage === 'add-shell' && !swapped) {
        swap();
      }
    };
    const paired = delay === 'Code-first build';
    const answers = paired ? [...f.pairedAnswers, 'y', 'y'] : [...f.desktopAnswers, 'y', 'y'];
    const result = await f.invoke(['add', 'studio', '--target', paired ? 'paired' : 'desktop'], answers);
    assert.ok(swapped, result.text);
    assert.notEqual(result.code, 0, result.text);
    assert.equal(text(join(location, 'substitute')), 'keep unrelated data');
    assert.equal(existsSync(join(location, '.bcm-root.json')), false);
    assert.equal(catalog(f).profiles.some(profile => profile.desktop), false);
    if (paired) {
      assert.ok(catalog(f).profiles[0]!.code);
    }
  });
}

test('S24 S28 extension replacement carries its original approval past the last comparison', async () => {
  let f: ReturnType<typeof lifecycleFixture>;
  let installed = '';
  let swapped = false;
  let armed = false;
  f = lifecycleFixture({ beforeRename: path => {
    if (!armed || swapped || !path.endsWith('/operation.json') || !existsSync(path)) {
      return;
    }
    const record = JSON.parse(text(path));
    if (!record.scope.includes(installed) || record.moves.length) {
      return;
    }
    swapped = true;
    renameSync(installed, installed + '-approved');
    f.put(join(installed, 'unrelated'), 'preserve substituted extension');
  } });
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  for (const label of ['source', 'target']) {
    const root = f.profile(label).desktop!.location;
    const extension = join(root, 'Claude Extensions/safe.extension');
    f.put(join(extension, 'manifest.json'), '{"manifest_version":"0.3","name":"safe.extension","version":"1.0.0"}');
    f.put(join(extension, 'content'), label);
  }
  installed = join(f.profile('target').desktop!.location, 'Claude Extensions/safe.extension');
  armed = true;
  const result = await f.invoke(['copy-setup', 'source', 'target', '--replace-selected'], ['1', '']);
  assert.ok(swapped, result.text);
  assert.notEqual(result.code, 0, result.text);
  assert.equal(text(join(installed, 'unrelated')), 'preserve substituted extension');
  assert.equal(text(join(installed + '-approved', 'content')), 'target');
});

test('S28 S64 policy cleanup never freshly approves an unrelated member introduced after validation', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const location = profile.desktop!.location + '-3p';
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory, profile.id);
  transaction.bind(profile, profile);
  const allow = transaction.allow.bind(transaction);
  let injected = false;
  transaction.allow = path => {
    if (!injected && path.includes('/policy-retired-')) {
      injected = true;
      f.put(join(location, 'unrelated'), 'keep newly introduced member');
    }
    allow(path);
  };
  assert.throws(() => clearPolicy(profile, transaction, f.io), /approved directory changed/);
  assert.ok(injected);
  assert.equal(transaction.rollback(), 0);
  assert.equal(text(join(location, 'unrelated')), 'keep newly introduced member');
  assert.ok(existsSync(join(location, '.bcm-policy.json')));
});

test('S27 S32 shared protection recovery accepts verified current Code guards for participating settings', async () => {
  const f = lifecycleFixture();
  const first = installProfile(f, 'first');
  installProfile(f, 'second');
  const root = first.rootEvidence.find(value => value.role === 'code')!;
  const settings = join(first.code!.location, 'settings.json');
  f.put(settings, '{}');
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory, null);
  transaction.bind(null, null);
  transaction.pinRoot(root.location, root.device, root.inode);
  transaction.allow(settings);
  transaction.write(settings, '{"interrupted":"partial protection write"}');
  const id = transaction.directory.split('/').at(-1)!;
  const result = await f.invoke(['doctor', '--recover', id], ['y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(JSON.parse(text(settings)).interrupted, undefined);
  assert.equal(existsSync(transaction.directory), false);
  assert.deepEqual(catalog(f).recoveryClaims, []);
});

test('S28 S31 a refused final move approval durably clears pre-rename uncertainty', () => {
  const f = profileFixture();
  const from = join(f.home, 'approved');
  const to = join(f.home, 'moved');
  f.io.directory(from);
  f.io.write(join(from, 'original'), 'original', null);
  const approval = approveTree(from, f.io);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [from, to], () => {});
  const recheck = f.io.guard.recheck.bind(f.io.guard);
  let checks = 0;
  f.io.guard.recheck = stamps => {
    recheck(stamps);
    if (stamps === approval.parents && ++checks === 2) {
      f.io.write(join(from, 'concurrent'), 'keep', null);
    }
  };
  assert.throws(() => transaction.moveTree(from, to, true, approval), /approved directory changed/);
  assert.equal(checks, 2);
  assert.equal(JSON.parse(text(join(transaction.directory, 'operation.json'))).moves[0].uncertain, false);
  const recovered = ChangeRecord.loadApplication(f.io, transaction.directory, null,
    path => path.startsWith(f.root + '/'), () => {});
  assert.equal(recovered.rollback(), 0);
  assert.equal(text(join(from, 'concurrent')), 'keep');
  assert.equal(existsSync(to), false);
  assert.equal(existsSync(transaction.directory), false);
});

for (const quote of ["'", '"']) {
  test(`S57 S58 reference parsing preserves the ${quote} quoted-space escape and reports uncertainty`, () => {
    const warnings: string[] = [];
    const value = `cat ${quote}/old/code/a b/../../hooks/start.js${quote}`;
    const result = mapReference(value, true, {
      source: '/old/code', destination: '/new/code', home: '/home/synthetic', required: true,
      warn: message => warnings.push(message),
    });
    assert.equal(result, value);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /ambiguous|escapes/);
    const expanded = 'cat /old/code/$PART/../hooks/start.js';
    assert.equal(mapReference(expanded, true, {
      source: '/old/code', destination: '/new/code', home: '/home/synthetic', required: true,
      warn: message => warnings.push(message),
    }), expanded);
    assert.equal(warnings.length, 2);
  });
}

for (const change of ['clean', 'extra', 'replace', 'link'] as const) {
  test(`S30 S68 install-local cleanup handles ${change} scratch content without recursive deletion`, () => {
    const f = profileFixture();
    const npm = join(f.home, 'fake-npm.cjs');
    const record = join(f.home, 'packing-root');
    const mock = `const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] === 'pack') {
  const root = process.argv.at(-1);
  fs.writeFileSync(${JSON.stringify(record)}, root);
  fs.writeFileSync(path.join(root, 'package.tgz'), 'owned archive');
  if (${JSON.stringify(change)} === 'extra') fs.writeFileSync(path.join(root, 'unexpected'), 'keep');
  process.stdout.write(JSON.stringify([{filename:'package.tgz'}]));
} else {
  const archive = process.argv.at(-1);
  if (${JSON.stringify(change)} === 'replace' || ${JSON.stringify(change)} === 'link') {
    fs.renameSync(archive, archive + '.original');
    if (${JSON.stringify(change)} === 'link') fs.symlinkSync(archive + '.original', archive);
    else fs.writeFileSync(archive, 'unrelated replacement');
  }
}
`;
    f.io.write(npm, mock, null);
    const result = spawnSync(process.execPath, [join(repo, 'dist/scripts/install-local.js')], {
      env: { ...f.env, npm_execpath: npm }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const root = text(record);
    if (change === 'clean') {
      assert.equal(existsSync(root), false);
    } else {
      assert.match(result.stderr, /WARNING/);
      assert.ok(existsSync(root));
      if (change === 'extra') {
        assert.equal(text(join(root, 'unexpected')), 'keep');
        assert.equal(existsSync(join(root, 'package.tgz')), false);
      } else {
        assert.equal(text(join(root, 'package.tgz.original')), 'owned archive');
        assert.ok(readdirSync(root).includes('package.tgz'));
      }
    }
  });
}

test('S07 S45 S49 recovery rejects a working direct-Claude shell entry with inherited overrides', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const profile = f.profile();
  const rc = profile.code!.rc;
  const valid = text(rc);
  const claude = join(f.home, 'fake-claude');
  f.put(claude, '#!/bin/sh\nprintf "%s" "$ANTHROPIC_API_KEY"\n');
  chmodSync(claude, 0o700);
  const direct = `${profile.code!.command}() {\n  '${claude}' "$@"\n}\n`;
  const bypass = valid.replace(shellBody(profile).toString('utf8'), direct);
  assert.notEqual(bypass, valid);
  f.put(rc, bypass);
  const run = spawnSync('/bin/zsh', ['-f', '-c', 'source "$1"; claude-studio', '--', rc], {
    env: { ...f.env, ANTHROPIC_API_KEY: 'inherited-synthetic-value' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'inherited-synthetic-value');
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [rc], session.inventory, profile.id);
  transaction.bind(profile, profile);
  transaction.write(rc, valid);
  const result = await f.invoke(['doctor', '--recover', transaction.directory.split('/').at(-1)!], ['y']);
  assert.notEqual(result.code, 0, result.text);
  assert.match(result.text, /Recovery is incomplete.*Run doctor --apply/);
  assert.equal(text(rc), bypass);
});
