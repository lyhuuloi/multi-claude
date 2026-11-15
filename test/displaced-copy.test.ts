import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync,
  symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { healthFixture } from './health-support.js';
import { catalog, repo, save } from './support.js';
import { ApplicationVault } from '../src/application-vault.js';
import { CatalogSession } from '../src/profile-actions.js';
import { treeManifest } from '../src/private-io.js';
import { Exit, Problem } from '../src/outcomes.js';
import { verifyRoot } from '../src/profile-catalog.js';

const text = (path: string) => readFileSync(path, 'utf8');
type Fixture = ReturnType<typeof healthFixture>;
const commands = ['open-profile', '_dock-entry', 'repair', 'doctor --apply'] as const;
function invoke(f: Fixture, command: typeof commands[number]) {
  return command === '_dock-entry'
    ? f.invoke([command, f.profile().id, join(f.control, 'catalog.json')], null)
    : command === 'doctor --apply' ? f.invoke(['doctor', '--apply'], [])
      : f.invoke([command, 'studio'], command === 'repair' ? ['n'] : null);
}
function replace(f: Fixture) {
  const application = f.application();
  renameSync(application, join(f.home, 'original-Claude.app'));
  cpSync(f.source, application, { recursive: true });
  f.put(join(application, 'replacement-note'), 'external updater contents');
  // Even a newer or unknown external copy must be restaged, never adopted.
  f.put(join(application, 'Contents/Info.plist'), '99.0.0');
  return lstatSync(application).ino;
}
function archives(f: Fixture) {
  const recovery = join(f.control, 'recovery');
  return readdirSync(recovery).filter(name => name.startsWith('displaced-'))
    .map(name => join(recovery, name, 'Claude.app'));
}
function vault(f: Fixture) {
  return new ApplicationVault(f.control, f.io, f.desktop, new CatalogSession(f.io, f.control),
    f.profile(), async () => {}, () => {});
}

for (const command of commands) {
  test(`displaced copy: ${command} preserves the replacement and commits a fresh paired copy`, async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const before = catalog(f);
    const prior = f.profile().rootEvidence.find(root => root.role === 'copy')!;
    const inode = replace(f);
    const result = await invoke(f, command);
    assert.equal(result.code, 0, result.text);
    const evidence = f.profile().rootEvidence.find(root => root.role === 'copy')!;
    assert.notEqual(evidence.inode, prior.inode);
    assert.notEqual(evidence.inode, String(inode));
    assert.notEqual(evidence.nonce, prior.nonce);
    verifyRoot(evidence, f.io);
    assert.ok(catalog(f).serial > before.serial);
    assert.equal(text(join(f.application(), 'Contents/Info.plist')), '4.29.0');
    assert.equal(existsSync(join(f.application(), 'replacement-note')), false);
    const [archive] = archives(f);
    assert.ok(archive);
    assert.equal(archives(f).length, 1);
    assert.equal(lstatSync(archive).ino, inode);
    assert.equal(lstatSync(dirname(archive)).mode & 0o777, 0o700);
    assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
    assert.ok(result.text.includes(archive), result.text);
    assert.match(result.text, /removed after review/);
    assert.deepEqual(catalog(f).recoveryClaims, []);
    assert.equal(existsSync(join(dirname(f.application()), 'refresh.json')), false);
    const repeat = await invoke(f, command);
    assert.equal(repeat.code, 0, repeat.text);
    assert.deepEqual(archives(f), [archive]);
    assert.equal(f.profile().rootEvidence.find(root => root.role === 'copy')!.nonce, evidence.nonce);
    const doctor = await f.invoke(['doctor'], null);
    assert.ok(doctor.text.includes(archive), doctor.text);
    assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
    if (command === 'repair') {
      assert.equal((await f.invoke(['rename', 'studio', 'work'], ['y'])).code, 0);
      const removed = await f.invoke(['remove', 'work'], ['y', 'y', 'y']);
      assert.equal(removed.code, 0, removed.text);
      assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
    }
  });
}

test('displaced copy: doctor and existing remain read-only and skip copy signature/version/tint', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  replace(f);
  const before = treeManifest(f.control, f.io);
  f.calls.length = 0;
  f.desktop.version = async path => {
    assert.notEqual(path, f.application(), 'Must not inspect external copy versions');
    return '4.29.0';
  };
  await assert.rejects(vault(f).existing(), error => error instanceof Problem && error.kind === 'root-identity');
  const result = await f.invoke(['doctor'], null);
  assert.notEqual(result.code, 0);
  for (const area of ['copy identity', 'copy signature']) {
    assert.match(result.text, new RegExp(area + ': The dedicated copy was replaced outside multi-claude'));
  }
  assert.match(result.text, /repair studio/);
  assert.match(result.text, /Launch the profile/);
  assert.equal(f.calls.some(call => call.kind === 'verify' && call.value === f.application()), false);
  assert.deepEqual(treeManifest(f.control, f.io), before);
});

for (const reason of ['nonce', 'uid', 'symlink', 'desktop', 'parent', 'journal', 'location', 'descendant']) {
  test(`displaced copy: ${reason} stays refused without moving anything at all entry points`, async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const inode = replace(f);
    const application = f.application();
    if (reason === 'nonce') {
      const receipt = join(dirname(application), '.bcm-copy.json');
      f.put(receipt, JSON.stringify({ ...JSON.parse(text(receipt)), nonce: 'wrong' }));
    } else if (reason === 'uid' || reason === 'location') {
      const value = catalog(f);
      const root = value.profiles[0]!.rootEvidence.find(root => root.role === 'copy')!;
      if (reason === 'uid') {
        root.uid++;
      } else {
        root.location = join(f.home, 'original-Claude.app');
      }
      save(f, value);
    } else if (reason === 'symlink') {
      renameSync(application, join(f.home, 'replacement-Claude.app'));
      symlinkSync(join(f.home, 'replacement-Claude.app'), application);
    } else if (reason === 'desktop') {
      const location = f.profile().desktop!.location;
      renameSync(location, location + '-old');
      f.io.directory(location);
    } else if (reason === 'parent') {
      chmodSync(dirname(application), 0o755);
    } else if (reason === 'journal') {
      f.put(join(dirname(application), 'refresh.json'), '{"format":"broken"}');
    } else {
      const digest = f.io.contentDigest.bind(f.io);
      f.io.contentDigest = (path, root) => {
        if (path === join(application, 'replacement-note')) {
          throw new Problem('tree-owner', 'The tree contains a foreign owner.');
        }
        return digest(path, root);
      };
    }
    for (const command of commands) {
      const result = await invoke(f, command);
      assert.notEqual(result.code, 0, command + ': ' + result.text);
      assert.equal(archives(f).length, 0, command + ': ' + result.text);
      assert.equal(lstatSync(application).isSymbolicLink(), reason === 'symlink');
      if (reason !== 'symlink') {
        assert.equal(lstatSync(application).ino, inode);
      }
      assert.equal(text(join(application, 'replacement-note')), 'external updater contents');
    }
  });
}

for (const state of ['Code active', 'Code unknown', 'Desktop live', 'Desktop unknown']) {
  test(`displaced copy: ${state} ${state.startsWith('Code')
    ? 'permits launch restaging but blocks lifecycle changes' : 'refuses before preservation at all entry points'}`, async () => {
    for (const command of commands) {
      const f = healthFixture();
      assert.equal((await f.addPaired()).code, 0);
      const inode = replace(f);
      if (state === 'Code active') {
        f.services.census = async () => ({ available: true, processes: [{
          pid: 9281, uid: f.io.guard.uid, executable: '/usr/local/bin/claude', argv: ['claude'],
          environment: { CLAUDE_CONFIG_DIR: f.profile().code!.location },
        }] });
      } else if (state === 'Code unknown') {
        f.services.census = async () => ({ available: false, processes: [] });
      } else if (state === 'Desktop unknown') {
        f.desktop.census = async () => ({ available: false, processes: [] });
      } else {
        f.setProcesses([{
          pid: 9282, uid: f.io.guard.uid, start: 'start', bundle: f.application(),
          executable: join(f.application(), 'Contents/MacOS/Claude'),
          bundleId: 'com.anthropic.claudefordesktop', data: f.profile().desktop!.location, uncertain: false,
        }]);
      }
      const result = await invoke(f, command);
      if (state.startsWith('Code') && (command === 'open-profile' || command === '_dock-entry')) {
        assert.equal(result.code, 0, command + ': ' + result.text);
        const [archive] = archives(f);
        assert.ok(archive);
        assert.equal(archives(f).length, 1);
        assert.equal(lstatSync(archive).ino, inode);
        assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
        assert.ok(result.text.includes(archive), result.text);
        assert.notEqual(lstatSync(f.application()).ino, inode);
        verifyRoot(f.profile().rootEvidence.find(root => root.role === 'copy')!, f.io);
      } else {
        assert.notEqual(result.code, 0, command + ': ' + result.text);
        assert.equal(lstatSync(f.application()).ino, inode);
        assert.deepEqual(archives(f), []);
      }
    }
  });
}

for (const state of ['active', 'unknown']) {
  test(`ordinary copy refresh: ${state} Code sessions do not block either launch entry point`, async () => {
    for (const command of ['open-profile', '_dock-entry'] as const) {
      const f = healthFixture();
      assert.equal((await f.addPaired()).code, 0);
      const evidence = f.profile().rootEvidence.find(root => root.role === 'copy')!;
      f.services.census = async () => state === 'unknown' ? { available: false, processes: [] }
        : { available: true, processes: [{
          pid: 9281, uid: f.io.guard.uid, executable: '/fixture/vm-helper', argv: ['vm-helper'],
          environment: { CLAUDE_CONFIG_DIR: f.profile().code!.location },
        }] };
      f.put(join(f.source, 'Contents/Info.plist'), '4.30.0');
      const result = await invoke(f, command);
      assert.equal(result.code, 0, result.text);
      assert.equal(text(join(f.application(), 'Contents/Info.plist')), '4.30.0');
      const refreshed = f.profile().rootEvidence.find(root => root.role === 'copy')!;
      assert.notEqual(refreshed.nonce, evidence.nonce);
      verifyRoot(refreshed, f.io);
      assert.deepEqual(archives(f), []);
    }
  });
}

for (const checkpoint of ['copy-displacing', 'copy-displaced', 'copy-staged', 'copy-old-moved',
  'copy-installed', 'copy-committed', 'copy-cleaned']) {
  test(`displaced copy: real process exit at ${checkpoint} restages without restoring or verifying the archive`, async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const inode = replace(f);
    const child = spawnSync(process.execPath, [join(repo, 'dist/test/lifecycle-crash-worker.js'),
      f.home, 'open', checkpoint], { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    assert.equal(child.status, 89, child.stderr);
    const inspect = f.services.identities.inspect;
    f.services.identities.inspect = async pid => pid === child.pid ? { state: 'dead' } : inspect(pid);
    f.desktop.tool = async (_file, args) => {
      assert.equal(args.at(-1)!.includes('/displaced-'), false, 'Archive is preservation only');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await invoke(f, 'open-profile');
    assert.equal(result.code, 0, result.text);
    assert.equal(archives(f).length, 1);
    const archive = archives(f)[0]!;
    assert.equal(lstatSync(archive).ino, inode);
    assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
    verifyRoot(f.profile().rootEvidence.find(root => root.role === 'copy')!, f.io);
    assert.deepEqual(catalog(f).recoveryClaims, []);
    assert.equal(existsSync(join(dirname(f.application()), 'refresh.json')), false);
  });
}

test('displaced copy: a failed rollback retains its journal and never restores or cleans the archive', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const inode = replace(f);
  const journal = join(dirname(f.application()), 'refresh.json');
  let note = '';
  f.desktop.checkpoint = stage => {
    if (stage === 'copy-displaced') {
      const record = JSON.parse(text(journal)) as { operation: string };
      note = join(record.operation, 'concurrent-note');
      f.put(note, 'preserve concurrent recovery material');
      throw new Error('injected failure after preservation');
    }
  };
  const failed = await invoke(f, 'open-profile');
  assert.equal(failed.code, Exit.recovery, failed.text);
  assert.ok(existsSync(journal), 'Failed rollback must retain the refresh binding');
  assert.equal(existsSync(f.application()), false, 'Never restore the displaced copy');
  const [archive] = archives(f);
  assert.ok(archive);
  assert.equal(lstatSync(archive).ino, inode);
  assert.equal(text(join(archive, 'replacement-note')), 'external updater contents');
  assert.equal(text(note), 'preserve concurrent recovery material');
  f.io.remove(note, f.io.snapshot(note)!);
  delete f.desktop.checkpoint;
  const result = await invoke(f, 'open-profile');
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(archives(f), [archive]);
  assert.deepEqual(catalog(f).recoveryClaims, []);
});

test('displaced copy: a second real exit after recovery cleanup still permits ordinary restaging', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const inode = replace(f);
  const dead: string[] = [];
  for (const checkpoint of ['copy-displaced', 'copy-recovered']) {
    const child = spawnSync(process.execPath, [join(repo, 'dist/test/lifecycle-crash-worker.js'),
      f.home, 'open', checkpoint, ...dead], { env: f.env, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
    assert.equal(child.status, 89, child.stderr);
    dead.push(String(child.pid));
    const inspect = f.services.identities.inspect;
    f.services.identities.inspect = async pid => pid === child.pid ? { state: 'dead' } : inspect(pid);
  }
  assert.equal(existsSync(f.application()), false);
  const result = await invoke(f, 'open-profile');
  assert.equal(result.code, 0, result.text);
  assert.equal(archives(f).length, 1);
  assert.equal(lstatSync(archives(f)[0]!).ino, inode);
  assert.deepEqual(catalog(f).recoveryClaims, []);
});

for (const change of ['receipt', 'bundle']) {
  test(`displaced copy: concurrent ${change} substitution is refused immediately before preservation`, async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    let inode = replace(f);
    f.desktop.checkpoint = stage => {
      if (stage !== 'copy-displacing') {
        return;
      }
      if (change === 'receipt') {
        const receipt = join(dirname(f.application()), '.bcm-copy.json');
        f.put(receipt, JSON.stringify({ ...JSON.parse(text(receipt)), nonce: 'concurrent' }));
      } else {
        renameSync(f.application(), join(f.home, 'observed-replacement.app'));
        cpSync(f.source, f.application(), { recursive: true });
        f.put(join(f.application(), 'replacement-note'), 'concurrent replacement');
        inode = lstatSync(f.application()).ino;
      }
    };
    const result = await invoke(f, 'open-profile');
    assert.notEqual(result.code, 0, result.text);
    assert.equal(lstatSync(f.application()).ino, inode);
    assert.equal(text(join(f.application(), 'replacement-note')),
      change === 'receipt' ? 'external updater contents' : 'concurrent replacement');
    for (const archive of archives(f)) {
      assert.equal(existsSync(join(archive, 'replacement-note')), false);
    }
  });
}
