import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  lstatSync,
  chmodSync,
  symlinkSync,
  linkSync,
  renameSync,
  unlinkSync,
  existsSync,
  realpathSync
} from 'node:fs';
import { join, dirname } from 'node:path';
import { userInfo } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { requireIsolation } from './isolation.js';
import { Exit, Problem, terminalText } from '../src/outcomes.js';
import { LocationGuard, protectedPath, overlaps, refuseOverlap, baselineLocations, } from '../src/location-guard.js';
import { PrivateIO, treeManifest, cleanSealedTree } from '../src/private-io.js';
import {
  emptyCatalog,
  readCatalog,
  validateCatalog,
  writeCatalog,
  recordRoot,
  verifyRoot,
  validateLocations
} from '../src/profile-catalog.js';
import type { Catalog, Profile } from '../src/profile-catalog.js';
import { LeaseManager } from '../src/operation-leases.js';
import type { IdentityService } from '../src/machine-services.js';
import { execute, executableCandidates, systemTools } from '../src/machine-services.js';
import { ChangeRecord } from '../src/change-records.js';
import { Dialogue } from '../src/terminal-dialogue.js';
import { invocation, runFront } from '../src/command-front.js';
const profileRoot = requireIsolation();
const repo = process.env.BCM_TEST_REPO!;
function fixture() {
  const root = realpathSync(mkdtempSync(join(profileRoot, 'case-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const config = join(home, '.config'),
  data = join(home, '.local/share');
  const io = new PrivateIO();
  io.directory(config);
  io.directory(data);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data
  };
  return { root, home, io, control: join(config, 'ben-claude-multi'), env };
}
function sample(f: ReturnType<typeof fixture>, _catalog: Catalog): Profile {
  const id = randomUUID(),
  now = new Date().toISOString();
  return {
    id,
    label: 'studio',
    bornAt: now,
    changedAt: now,
    credentialPolicy: 'subscription',
    desktop: null,
    rootEvidence: [],
    code: {
      location: join(f.home, 'profiles/studio/code'),
      shell: 'zsh',
      rc: join(f.home, '.zshrc'),
      command: 'claude-studio',
      github: null,
      defaultLocation: true,
      defaultCommand: true,
      entryChangedAt: now
    }
  };
}
const kind = (name: string) => (error: unknown) => error instanceof Problem && error.kind === name;
function stamp(path: string): unknown {
  const s = lstatSync(path, { bigint: true });
  return [String(s.ino),
    String(s.mode),
    String(s.mtimeNs),
    s.isDirectory() ? readdirSync(path).sort().map(n => [n, stamp(join(path, n))]) :
    readFileSync(path).toString('base64')];
}
async function front(args: string[], f = fixture()) {
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => {
    text += String(chunk);
  });
  const code = await runFront(args, {
    env: f.env,
    io: f.io,
    input: new PassThrough(),
    output,
    tty: false,
    platform: 'darwin'
  });
  return { code, text };
}
const identity: IdentityService = {
  self: async () => ({ boot: 'fixture-boot', start: 'fixture-start' }),
  inspect: async () => ({ state: 'alive', boot: 'fixture-boot', start: 'fixture-start' })
};
function locks(f: ReturnType<typeof fixture>, service = identity) {
  return new LeaseManager(join(f.control, 'leases'), f.io, service);
}
function operation(f: ReturnType<typeof fixture>, paths: string[], notices: boolean[] = []) {
  return ChangeRecord.begin(f.io, join(f.control, 'recovery'), paths, (_notice, retained) => {
    notices.push(retained);
  });
}
test('S72 suite runs compiled JavaScript inside the temporary profile', () => {
  assert.ok(import.meta.url.endsWith('/dist/test/core.test.js'));
  assert.ok(profileRoot.startsWith('/private/'));
});
test('S72 deliberate outside-profile write is denied by sandbox-exec', {
  skip: process.env.BCM_TEST_BOUNDARY === 'outer-seatbelt' ?
  'Inner boundary not applied in the authorized outer sandbox.'
  : false
}, () => {
  const outside = join(dirname(profileRoot), `bcm-forbidden-${randomUUID()}`);
  assert.throws(() => writeFileSync(outside, 'must be denied'), error => ['EPERM', 'EACCES'].includes((error as
    NodeJS.ErrnoException).code ?? ''));
  assert.equal(existsSync(outside), false);
  const repositoryFile = join(repo, `bcm-forbidden-${randomUUID()}`);
  assert.throws(() => writeFileSync(repositoryFile, 'must be denied'), error =>
    ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''));
  assert.equal(existsSync(repositoryFile), false);
});
test('S69 S72 network access is denied inside the suite', {
  skip: process.env.BCM_TEST_BOUNDARY === 'outer-seatbelt' ?
  'Inner network policy not applied in the authorized outer sandbox.'
  : false
}, () => {
  const probe = spawnSync(process.execPath, ['-e',
    'const n=require("node:net"); const s=n.createServer();' +
    's.on("error",()=>process.exit(0));' +
    's.listen(0,"127.0.0.1",()=>{s.close();process.exit(9)});'],
    { env: process.env, timeout: 3000 });
  assert.equal(probe.status, 0);
});
test('S72 bootstrap rejects the account home even with harness flags', () => {
  assert.throws(() => requireIsolation({ ...process.env, HOME: userInfo().homedir }), /Unsafe test HOME/);
  assert.throws(() => requireIsolation({ ...process.env, HOME: repo }), /escaped/);
});
test('S72 direct compiled suite invocation refuses absent isolation', () => {
  const child = spawnSync(process.execPath, [join(repo, 'dist/test/native.test.js')], {
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
    encoding: 'utf8'
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /declared temporary profile directory/);
});
test('S68 package has only the two permitted development dependencies', () => {
  const p = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(Object.keys(p[field] ?? {}).length, 0);
  }
  assert.deepEqual(Object.keys(p.devDependencies).sort(), ['@types/node', 'typescript']);
  const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/typescript'].version, p.devDependencies.typescript);
  assert.equal(lock.packages['node_modules/@types/node'].version, p.devDependencies['@types/node']);
  for (const field of ['build', 'test', 'test:native', 'install-local']) {
    assert.equal(typeof p.scripts[field],
      'string');
  }
});
test('T001 S69 help and version leave the temporary home unchanged', async () => {
  const f = fixture(),
  before = stamp(f.home);
  for (const args of [[], ['help'], ['--help'], ['version'], ['--version']]) {
    assert.equal((await front(args,
      f)).code, 0);
  }
  assert.deepEqual(stamp(f.home), before);
});
test('T001 compiled executable exposes help and version without writes', () => {
  const f = fixture(),
  before = stamp(f.home);
  for (const arg of ['--help', '--version']) {
    const c = spawnSync(process.execPath, [join(repo, 'dist/src/main.js'), arg], { env: f.env, timeout: 3000 });
    assert.equal(c.status, 0);
  }
  assert.deepEqual(stamp(f.home), before);
});
test('T002 T003 own-key dispatch rejects inherited names and surplus input', async () => {
  for (const args of [['constructor'], ['__proto__'], ['toString'], ['valueOf'], ['list',
    '--force'], ['help', 'extra'], ['status', 'one', 'two'], ['version', '--version']]) {
    assert.equal((await front(args)).code,
      Exit.usage);
  }
});
test('T009 all exit categories are explicit', () => {
  assert.deepEqual(Object.values(Exit), [0, 1, 2, 64, 69, 73, 74, 130]);
});
test('T003 missing Desktop policy display refuses without mutation', async () => {
  const f = fixture(),
  before = stamp(f.home);
  assert.equal((await front(['desktop-updates', 'studio'], f)).code, Exit.usage);
  assert.deepEqual(stamp(f.home), before);
});
test('T004 dialogue refuses non-TTY input immediately', async () => {
  const d = new Dialogue(new PassThrough(), new PassThrough(), false);
  await assert.rejects(d.confirm('Apply?'), kind('input-required'));
  d.close();
});
test('T005 T006 EOF and blank confirmation are refusals', async () => {
  for (const content of ['', '\n', 'no\n']) {
    const input = new PassThrough(),
    output = new PassThrough(),
    d = new Dialogue(input, output, true);
    input.end(content);
    assert.equal(await d.confirm('Remove?'), false);
    d.close();
  }
});
test('T009 numbered choices support explicit multiselect and cancellation', async () => {
  const input = new PassThrough(),
  d = new Dialogue(input, new PassThrough(), true);
  input.end('2,1\n\n');
  assert.deepEqual(await d.choose('Items', ['A', 'B'], true), [1, 0]);
  assert.deepEqual(await d.choose('Items', ['A']), []);
  d.close();
});
test('T008 S23 output strips ANSI, control, bidi and line-breaking input', () => {
  const result = terminalText('\x1b[31msecret\r\n\x00\u202e\u2066x');
  assert.equal(/[\x00-\x1f\u202e\u2066]/.test(result), false);
  assert.ok(!result.includes('[31m'));
});
test('T010 S22 paths refuse relative names and all restricted characters', () => {
  for (const value of ['relative', '/a\n', ...'[](){}\\*?!'.split('').map(x => `/a${x}`)]) {
    assert.throws(() =>
      protectedPath(value), kind('path-syntax'));
  }
});
test('T011 S22 safe Unicode, spaces, quotes and punctuation remain data', () => {
  assert.equal(protectedPath('/private/Équipe/one two/quote\'";:$&'), '/private/Équipe/one two/quote\'";:$&');
});
test('T012 T014 S20 S21 overlap detects ancestry, case, Unicode and Data aliases', () => {
  const f = fixture();
  for (const pair of [[f.home, join(f.home, 'code')], [join(f.home, 'É'), join(f.home,
    'E\u0301')], [join(f.home, 'Alpha'), join(f.home, 'alpha')], ['/Users/demo/data',
      '/System/Volumes/Data/Users/demo/data']]) {
    assert.ok(overlaps(pair[0]!, pair[1]!));
  }
  assert.ok(!overlaps(join(f.home, 'one'), join(f.home, 'one-more')));
});
test('T013 S20 all baseline identity locations are protected', () => {
  const f = fixture();
  for (const location of baselineLocations(f.home)) {
    assert.throws(() => refuseOverlap(join(location,
      'child'), baselineLocations(f.home)), kind('overlap'));
  }
});
test('T012 S20 catalog roots cannot intersect control, siblings or policy', () => {
  const f = fixture(),
  c = emptyCatalog(),
  p = sample(f, c);
  c.profiles.push(p);
  p.code!.location = join(f.control, 'inside');
  assert.throws(() => validateLocations(c, f.home, f.control), kind('overlap'));
});
test('T015 S17 S18 shared sticky immediate parents are refused', () => {
  const f = fixture(),
  shared = join(f.root, 'shared');
  mkdirSync(shared);
  chmodSync(shared, 0o1777);
  assert.throws(() => f.io.directory(join(shared, 'profile')), kind('parent-writable'));
});
test('T016 S19 parent ACL grants are refused using explicit inspection dependencies', () => {
  const f = fixture(),
  guard = new LocationGuard(process.getuid!(), p => p === f.home);
  assert.throws(() => guard.parents(join(f.home, 'target')), kind('parent-acl'));
});
test('T017 S11 S12 S13 reads and writes refuse symlinks and hard links', () => {
  const f = fixture(),
  file = join(f.home, 'file');
  f.io.write(file, 'original', null);
  const linked = join(f.home, 'linked');
  symlinkSync(file, linked);
  assert.throws(() => f.io.read(linked), kind('unsafe-file'));
  assert.throws(() => f.io.write(linked, 'bad'), kind('unsafe-file'));
  unlinkSync(linked);
  linkSync(file, linked);
  assert.throws(() => f.io.read(file), kind('unsafe-file'));
});
test('T017 S11 a linked parent is never traversed', () => {
  const f = fixture(),
  linked = join(f.root, 'alias');
  symlinkSync(f.home, linked);
  assert.throws(() => f.io.write(join(linked, 'file'), 'bad', null), kind('parent-kind'));
  assert.equal(existsSync(join(f.home, 'file')), false);
});
test('T017 S12 FIFOs are rejected without blocking', () => {
  const f = fixture(),
  fifo = join(f.home, 'fifo');
  const result = spawnSync('/usr/bin/mkfifo', [fifo]);
  assert.equal(result.status, 0);
  assert.throws(() => f.io.read(fifo), kind('unsafe-file'));
});
test('T017 S17 foreign directory ownership is refused', () => {
  const f = fixture(),
  guard = new LocationGuard(process.getuid!() + 10000, () => false);
  assert.throws(() => guard.chain(f.home), kind('parent-owner'));
});
test('T018 S16 private files and directories ignore a permissive umask', () => {
  const f = fixture(),
  previous = process.umask(0);
  try {
    const directory = join(f.home, 'private');
    f.io.directory(directory);
    const file = join(directory, 'secret');
    f.io.write(file, 'synthetic', null);
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  }
  finally {
    process.umask(previous);
  }
});
test('T019 private directory validation preserves existing modes', () => {
  const f = fixture(),
  directory = join(f.home, 'selected');
  mkdirSync(directory, { mode: 0o755 });
  f.io.directory(directory);
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
});
test('T020 S15 interrupted replacement leaves the old complete bytes', () => {
  const f = fixture(),
  path = join(f.home, 'file');
  const before = f.io.write(path, 'complete', null);
  const failing = new PrivateIO(f.io.guard, {
    beforeRename: () => {
      throw new Error('injected failure');
    }
  });
  assert.throws(() => failing.write(path, 'partial', before));
  assert.equal(readFileSync(path, 'utf8'), 'complete');
  assert.deepEqual(readdirSync(f.home).filter(x => x.startsWith('.write-')), []);
});
test('T021 S13 S14 replacing the destination after preflight preserves the replacement',
  () => {
    const f = fixture(),
    path = join(f.home, 'file');
    const before = f.io.write(path, 'original', null);
    const writer = new PrivateIO(f.io.guard, {
      beforeRename: () => {
        unlinkSync(path);
        writeFileSync(path, 'concurrent', { mode: 0o600 });
      }
    });
    assert.throws(() => writer.write(path, 'operation', before), kind('image-conflict'));
    assert.equal(readFileSync(path, 'utf8'), 'concurrent');
  });
test('T014 S14 descriptor identity is checked after opening', () => {
  const f = fixture(),
  path = join(f.home, 'file');
  f.io.write(path, 'old', null);
  const reader = new PrivateIO(f.io.guard, {
    afterOpen: () => {
      renameSync(path, path + '-opened');
      writeFileSync(path, 'replacement', { mode: 0o600 });
    }
  });
  assert.throws(() => reader.read(path), kind('file-changed'));
});
test('T022 S14 append refuses a substituted log descriptor', () => {
  const f = fixture();
  const path = join(f.home, 'events');
  const before = f.io.write(path, 'first\n', null);
  let substituted = false;
  const writer = new PrivateIO(f.io.guard, {
    afterOpen: (openedPath, purpose) => {
      if (purpose === 'append') {
        renameSync(openedPath, openedPath + '-opened');
        writeFileSync(openedPath, 'replacement', { mode: 0o600 });
        substituted = true;
      }
    },
  });
  assert.throws(() => writer.append(path, 'secret\n', before), kind('append-conflict'));
  assert.equal(substituted, true);
  assert.equal(readFileSync(path, 'utf8'), 'replacement');
  assert.equal(readFileSync(path + '-opened', 'utf8'), 'first\n');
});
test('T022 S16 a new event log is private and complete', () => {
  const f = fixture(),
  path = join(f.home, 'events');
  f.io.append(path, 'event\n', null);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(readFileSync(path, 'utf8'), 'event\n');
});
test('T023 T024 absent, unreadable and malformed catalogs are distinct', () => {
  const f = fixture(),
  path = join(f.home, 'catalog');
  assert.equal(readCatalog(path, f.io).kind, 'absent');
  f.io.write(path, '{broken', null);
  assert.throws(() => readCatalog(path, f.io), kind('catalog-json'));
  chmodSync(path, 0);
  try {
    assert.throws(() => readCatalog(path, f.io), kind('catalog-unreadable'));
  } finally {
    chmodSync(path, 0o600);
  }
});
test('T025 invalid schemas and unsupported versions are rejected', () => {
  for (const value of [null, [], {}, { ...emptyCatalog(), formatTag: 'foreign/1' }, { ...emptyCatalog(), serial: -1 }, {
    ...emptyCatalog(),
    profiles: [{}]
  }]) {
    assert.throws(() => validateCatalog(value));
  }
});
test('T025 duplicate UUIDs, labels and command names are rejected', () => {
  const f = fixture();
  for (const duplicate of ['id', 'label', 'command']) {
    const c = emptyCatalog(),
    a = sample(f, c),
    b = structuredClone(a);
    b.id = randomUUID();
    b.label = 'second';
    b.code!.command = 'claude-second';
    if (duplicate === 'id') {
      b.id = a.id;
    }
    if (duplicate === 'label') {
      b.label = a.label;
    }
    if (duplicate === 'command') {
      b.code!.command = a.code!.command;
    }
    c.profiles.push(a, b);
    assert.throws(() => validateCatalog(c), kind('catalog-schema'));
  }
});
test('T026 catalog round trips inode strings beyond numeric precision', () => {
  const f = fixture(),
  c = emptyCatalog(),
  p = sample(f, c),
  path = join(f.home, 'catalog');
  p.rootEvidence.push({
    location: p.code!.location,
    role: 'code',
    uid: process.getuid!(),
    device: '18446744073709551611',
    inode: '18446744073709551613',
    profileId: p.id,
    installationKey: c.installationKey,
    nonce: randomUUID()
  });
  c.profiles.push(p);
  writeCatalog(path, c, null, f.io);
  assert.equal(readCatalog(path, f.io).catalog.profiles[0]!.rootEvidence[0]!.inode, '18446744073709551613');
});
test('T027 S24 copied receipts cannot attest a replacement inode', () => {
  const f = fixture(),
  root = join(f.home, 'profile');
  f.io.directory(root);
  const e = recordRoot(root, 'code', randomUUID(), randomUUID(), f.io);
  verifyRoot(e, f.io);
  renameSync(root, root + '-old');
  f.io.directory(root);
  writeFileSync(join(root, '.bcm-root.json'), readFileSync(join(root + '-old', '.bcm-root.json')),
    { mode: 0o600 });
  assert.throws(() => verifyRoot(e, f.io), kind('root-identity'));
});
test('T028 S11 S24 substituted root components are refused', () => {
  const f = fixture(),
  parent = join(f.home, 'profiles'),
  root = join(parent, 'code');
  f.io.directory(root);
  const e = recordRoot(root, 'code', randomUUID(), randomUUID(), f.io);
  renameSync(parent, parent + '-old');
  symlinkSync(parent + '-old', parent);
  assert.throws(() => verifyRoot(e, f.io), kind('parent-kind'));
});
test('T029 T030 S25 unrelated catalog edits do not create or refresh evidence', () => {
  const f = fixture(),
  c = emptyCatalog(),
  p = sample(f, c),
  path = join(f.home, 'catalog');
  c.profiles.push(p);
  c.serial++;
  writeCatalog(path, c, null, f.io);
  assert.deepEqual(readCatalog(path, f.io).catalog.profiles[0]!.rootEvidence, []);
  assert.equal(existsSync(p.code!.location), false);
  f.io.directory(p.code!.location);
  p.rootEvidence.push(recordRoot(p.code!.location, 'code', c.installationKey, p.id, f.io));
  assert.equal(p.rootEvidence.length, 1);
});
test('T031 retirement history persists after directory deletion', () => {
  const f = fixture(),
  c = emptyCatalog(),
  path = join(f.home, 'catalog');
  c.releasedLocations.push({
    id: randomUUID(),
    location: join(f.home, 'gone'),
    role: 'code',
    formerProfileId: randomUUID(),
    formerLabel: 'former',
    retiredAt: new Date().toISOString(),
    reason: 'deleted',
    reusedBy: null
  });
  writeCatalog(path, c, null, f.io);
  assert.equal(readCatalog(path, f.io).catalog.releasedLocations.length, 1);
});
test('S27 registry writers with stale expected images cannot overwrite committed state',
  () => {
    const f = fixture(),
    path = join(f.home, 'catalog'),
    c = emptyCatalog();
    const image = writeCatalog(path, c, null, f.io);
    const next = structuredClone(c);
    next.serial++;
    writeCatalog(path, next, image, f.io);
    assert.throws(() => writeCatalog(path, c, image, f.io), kind('image-conflict'));
    assert.equal(readCatalog(path, f.io).catalog.serial, 1);
  });
test('T034 S33 two independent registry writers cannot both enter', async () => {
  const f = fixture(),
  manager = locks(f),
  a = await manager.acquire('registry');
  await assert.rejects(manager.acquire('registry'), kind('lease-busy'));
  a.release();
  const b = await manager.acquire('registry');
  b.release();
});
test('T034 S37 separate processes contend on the registry gate', async () => {
  const f = fixture(),
  directory = join(f.control, 'leases');
  f.io.directory(directory);
  const child = spawn(process.execPath, [join(repo, 'dist/test/lease-worker.js'), directory],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  const [chunk] = await once(child.stdout!, 'data');
  assert.match(String(chunk), /held/);
  await assert.rejects(locks(f).acquire('registry'), kind('lease-busy'));
  const [code] = await closed;
  assert.equal(code, 0);
});
test('T035 S33 a published lock always contains a complete owner record', async () => {
  const f = fixture(),
  manager = locks(f),
  lease = await manager.acquire('registry');
  const value = JSON.parse(readFileSync(lease.path, 'utf8'));
  for (const key of ['pid', 'uid', 'boot', 'start', 'token', 'createdAt']) {
    assert.ok(Object.hasOwn(value,
      key));
  }
  assert.equal(readdirSync(manager.directory).filter(n => n.startsWith('.owner-')).length,
    0);
  lease.release();
});
test('T036 S34 a dead owner can be reclaimed', async () => {
  const f = fixture(),
  original = await locks(f).acquire('registry');
  const manager = locks(f, {
    ...identity,
    inspect: async () => ({ state: 'dead' })
  });
  const replacement = await manager.acquire('registry');
  assert.notEqual(replacement.owner.token, original.owner.token);
  replacement.release();
});
test('T036 S34 a matching live owner cannot be reclaimed regardless of age', async () => {
  const f = fixture(),
  manager = locks(f),
  lease = await manager.acquire('registry');
  const value = JSON.parse(readFileSync(lease.path, 'utf8'));
  value.createdAt = '2000-01-01T00:00:00.000Z';
  f.io.write(lease.path, JSON.stringify(value), f.io.snapshot(lease.path));
  await assert.rejects(manager.acquire('registry'), kind('lease-busy'));
});
test('T037 S34 boot changes and reused PID start identities allow reclamation', async () => {
  for (const override of [{ boot: 'new-boot', start: 'fixture-start' }, { boot: 'fixture-boot', start: 'new-start' }]) {
    const f = fixture(),
    original = await locks(f).acquire('registry');
    const manager = locks(f, {
      self: async () => override,
      inspect: async () => ({ state: 'alive', ...override })
    });
    const replacement = await manager.acquire('registry');
    assert.notEqual(replacement.owner.token, original.owner.token);
    replacement.release();
  }
});
test('T038 S35 unreadable process identity keeps a lock live', async () => {
  const f = fixture(),
  lease = await locks(f).acquire('registry');
  await assert.rejects(locks(f, {
    ...identity,
    inspect: async () => ({ state: 'unknown' })
  }).acquire('registry'), kind('lease-busy'));
  lease.release();
});
test('T039 S34 a crashed reclamation guard is itself reclaimable', async () => {
  const f = fixture(),
  manager = locks(f),
  lease = await manager.acquire('registry');
  f.io.write(lease.path + '.reclaim', JSON.stringify(lease.owner), null);
  const recovered = await locks(f, {
    ...identity,
    inspect: async () => ({ state: 'dead' })
  }).acquire('registry');
  assert.equal(existsSync(lease.path + '.reclaim'), false);
  recovered.release();
});
test('T040 S36 replacing a lock inode prevents release by its previous owner', async () => {
  const f = fixture(),
  lease = await locks(f).acquire('registry');
  const replacement = { ...lease.owner, token: randomUUID() };
  f.io.write(lease.path, JSON.stringify(replacement), f.io.snapshot(lease.path));
  assert.throws(() => lease.release(), kind('lease-replaced'));
  assert.equal(JSON.parse(readFileSync(lease.path, 'utf8')).token, replacement.token);
});
test('T041 S37 asynchronous prompts retain whole-command exclusion', async () => {
  const f = fixture(),
  manager = locks(f);
  let resume!: () => void;
  const prompt = new Promise<void>(resolve => {
    resume = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {
    entered = resolve;
  });
  const action = manager.withRegistry(async () => {
    entered();
    await prompt;
  });
  await ready;
  await assert.rejects(manager.acquire('registry'), kind('lease-busy'));
  resume();
  await action;
  const next = await manager.acquire('registry');
  next.release();
});
test('T042 S38 all callers contend on the immutable profile key', async () => {
  const f = fixture(),
  id = randomUUID(),
  manager = locks(f);
  await manager.withRegistry(async session => {
    await session.profile(id);
    await assert.rejects(manager.acquire(`profile-${id}`), kind('lease-busy'));
    assert.ok(existsSync(join(manager.directory, `profile-${id}.json`)));
  });
});
test('T046 S37 S38 profile lock acquisition enforces registry first and UUID order', async () => {
  const f = fixture(),
  manager = locks(f),
  ids = [randomUUID(), randomUUID()].sort();
  await assert.rejects(manager.acquire(`profile-${ids[0]!}`), kind('lease-order'));
  await manager.withRegistry(async session => {
    await session.profile(ids[1]!);
    await assert.rejects(session.profile(ids[0]!), kind('lease-order'));
  });
});
test('S33 incomplete or malformed owner records remain blocked', async () => {
  const f = fixture(),
  manager = locks(f);
  f.io.directory(manager.directory);
  f.io.write(join(manager.directory, 'registry.json'), '{}', null);
  await assert.rejects(manager.acquire('registry'), kind('lease-busy'));
});
test('T047 S32 operation record failure prevents target mutation', () => {
  const f = fixture(),
  target = join(f.home, 'target'),
  recovery = join(f.control, 'recovery');
  f.io.directory(f.control);
  f.io.write(recovery, 'blocked', null);
  assert.throws(() => ChangeRecord.begin(f.io, recovery, [target], () => {
  }));
  assert.equal(existsSync(target), false);
});
test('T048 S27 inspection creates no pre-image and capture is lazy until first write',
  () => {
    const f = fixture(),
    target = join(f.home, 'target');
    f.io.write(target, 'original', null);
    const tx = operation(f, [target]);
    tx.inspect(target);
    assert.deepEqual(readdirSync(tx.directory), ['operation.json']);
    tx.write(target, 'changed');
    assert.equal(readdirSync(tx.directory).filter(n => n.startsWith('prior-')).length, 1);
    assert.equal(tx.finish(), 0);
  });
test('T049 S27 every later write checks the latest expected image', () => {
  const f = fixture(),
  target = join(f.home, 'target');
  f.io.write(target, 'original', null);
  const tx = operation(f, [target]);
  tx.write(target, 'first');
  f.io.write(target, 'user edit', f.io.snapshot(target));
  assert.throws(() => tx.write(target, 'second'), kind('image-conflict'));
  assert.equal(readFileSync(target, 'utf8'), 'user edit');
  assert.equal(tx.rollback(), Exit.recovery);
});
test('T050 T056 S28 S31 clean rollback restores original bytes and removes pre-images',
  () => {
    const f = fixture(),
    target = join(f.home, 'target');
    f.io.write(target, 'original', null);
    const tx = operation(f, [target]);
    tx.write(target, 'first');
    tx.write(target, 'second');
    assert.equal(tx.rollback(), 0);
    assert.equal(readFileSync(target, 'utf8'), 'original');
    assert.equal(existsSync(tx.directory), false);
  });
test('T050 S28 rollback restores explicit absence for an operation-created file', () => {
  const f = fixture(),
  target = join(f.home, 'new');
  const tx = operation(f, [target]);
  tx.write(target, 'created');
  assert.equal(tx.rollback(), 0);
  assert.equal(existsSync(target), false);
});
test('T051 S29 S32 concurrent edits survive with private inventoried recovery', () => {
  const f = fixture(),
  target = join(f.home, 'target'),
  notices: boolean[] = [];
  f.io.write(target, 'original', null);
  const tx = operation(f, [target], notices);
  tx.write(target, 'first');
  f.io.write(target, 'user', f.io.snapshot(target));
  assert.equal(tx.rollback(), 74);
  assert.equal(readFileSync(target, 'utf8'), 'user');
  assert.equal(lstatSync(tx.directory).mode & 0o777, 0o700);
  const prior = readdirSync(tx.directory).find(n => n.startsWith('prior-'))!;
  assert.equal(readFileSync(join(tx.directory, prior), 'utf8'), 'original');
  assert.equal(lstatSync(join(tx.directory, prior)).mode & 0o777, 0o600);
  assert.equal(notices[0], true);
});
test('T052 S28 merely captured sibling files never acquire rollback ownership', () => {
  const f = fixture(),
  target = join(f.home, 'sibling');
  f.io.write(target, 'before', null);
  const tx = operation(f, [target]);
  tx.capture(target);
  f.io.write(target, 'user changed', f.io.snapshot(target));
  assert.equal(tx.rollback(), 0);
  assert.equal(readFileSync(target, 'utf8'), 'user changed');
});
test('T054 S11 S29 rollback refuses a substituted parent without traversing it', () => {
  const f = fixture(),
  parent = join(f.home, 'owned'),
  target = join(parent, 'file');
  f.io.directory(parent);
  f.io.write(target, 'before', null);
  const tx = operation(f, [target]);
  tx.write(target, 'operation');
  renameSync(parent, parent + '-old');
  symlinkSync(parent + '-old', parent);
  assert.equal(tx.rollback(), 74);
  assert.equal(readFileSync(join(parent + '-old', 'file'), 'utf8'), 'operation');
});
test('T053 T055 S29 S30 changed installed or staging trees survive cleanup', () => {
  const f = fixture(),
  tree = join(f.home, 'stage');
  f.io.directory(tree);
  const child = join(tree, 'file');
  f.io.write(child, 'before', null);
  const manifest = treeManifest(tree, f.io);
  f.io.write(child, 'changed', f.io.snapshot(child));
  assert.throws(() => cleanSealedTree(tree, manifest, f.io), kind('tree-conflict'));
  assert.equal(readFileSync(child, 'utf8'), 'changed');
});
test('T055 S11 S30 sealed cleanup unlinks tree symlinks without following their targets',
  () => {
    const f = fixture(),
    tree = join(f.home, 'stage'),
    target = join(f.home, 'outside');
    f.io.directory(tree);
    f.io.write(target, 'keep', null);
    symlinkSync(target, join(tree, 'link'));
    const manifest = treeManifest(tree, f.io);
    assert.equal(manifest.find(e => e.name === 'link')!.kind, 'link');
    cleanSealedTree(tree, manifest, f.io);
    assert.equal(existsSync(tree), false);
    assert.equal(readFileSync(target, 'utf8'), 'keep');
  });
test('T056 S31 success discards all temporary pre-images and seals', () => {
  const f = fixture(),
  target = join(f.home, 'target'),
  stage = join(f.home, 'stage'),
  notices: boolean[] = [];
  f.io.write(target, 'old', null);
  const tx = operation(f, [target, stage], notices);
  tx.createStaging(stage);
  f.io.write(join(stage, 'staged'), 'temp', null);
  tx.sealStaging(stage);
  tx.write(target, 'committed');
  assert.equal(tx.finish(), 0);
  assert.equal(existsSync(tx.directory), false);
  assert.equal(existsSync(stage), false);
  assert.equal(readFileSync(target, 'utf8'), 'committed');
  assert.deepEqual(notices, [true, false]);
});
test('T057 S30 S32 failed cleanup reports protected pending recovery', () => {
  const f = fixture(),
  stage = join(f.home, 'stage');
  const tx = operation(f, [stage]);
  tx.createStaging(stage);
  tx.sealStaging(stage);
  f.io.write(join(stage, 'foreign'), 'concurrent', null);
  assert.equal(tx.finish(), Exit.recovery);
  assert.equal(existsSync(tx.directory), true);
  assert.equal(existsSync(join(stage, 'foreign')), true);
});
test('T058 S27 S29 tampered stored bytes prevent destructive rollback', () => {
  const f = fixture(),
  target = join(f.home, 'target');
  f.io.write(target, 'original', null);
  const tx = operation(f, [target]);
  tx.write(target, 'operation');
  const prior = join(tx.directory, readdirSync(tx.directory).find(n => n.startsWith('prior-'))!);
  f.io.write(prior, 'tampered', f.io.snapshot(prior));
  assert.equal(tx.rollback(), 74);
  assert.equal(readFileSync(target, 'utf8'), 'operation');
});
test('T058 S27 targets outside the operation scope are refused', () => {
  const f = fixture(),
  target = join(f.home, 'target'),
  other = join(f.home, 'other');
  const tx = operation(f, [target]);
  assert.throws(() => tx.write(other, 'bad'), kind('operation-scope'));
  assert.equal(existsSync(other), false);
  assert.equal(tx.finish(), 0);
});
test('T007 S28 interrupted mutation can roll back through the operation context', () => {
  const f = fixture(),
  target = join(f.home, 'target');
  const tx = operation(f, [target]);
  let result = 0;
  try {
    tx.write(target, 'pending');
    throw new Problem('interrupt', 'Interrupted.', Exit.interrupted);
  } catch {
    result = tx.rollback() === 0 ? Exit.interrupted : Exit.recovery;
  }
  assert.equal(result, Exit.interrupted);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(tx.directory), false);
});
test('T024 list differentiates missing and corrupt state without creating directories',
  async () => {
    const f = fixture(),
    before = stamp(f.home),
    absent = await front(['list'], f);
    assert.equal(absent.code, 0);
    assert.match(absent.text, /No managed profiles/);
    assert.deepEqual(stamp(f.home), before);
    f.io.directory(f.control);
    f.io.write(join(f.control, 'catalog.json'), '{bad', null);
    const broken = await front(['list'], f);
    assert.equal(broken.code, 1);
    assert.ok(!broken.text.includes('No managed profiles'));
  });
test('list and basic status inspect fixtures without changing bytes, modes or modification times',
  async () => {
    const f = fixture(),
    c = emptyCatalog(),
    p = sample(f, c);
    c.profiles.push(p);
    f.io.directory(f.control);
    f.io.directory(p.code!.location);
    p.rootEvidence.push(recordRoot(p.code!.location, 'code', c.installationKey, p.id, f.io));
    writeCatalog(join(f.control, 'catalog.json'), c, null, f.io);
    const before = stamp(f.home);
    const listed = await front(['list'], f);
    assert.equal(listed.code, 0);
    assert.match(listed.text, /studio: Code/);
    const status = await front(['status', 'studio'], f);
    assert.equal(status.code, 2);
    assert.match(status.text, /code: identity matches/);
    assert.match(status.text, /recorded rc file is missing/i);
    assert.deepEqual(stamp(f.home), before);
  });
test('status reports missing roots without reconstructing them', async () => {
  const f = fixture(),
  c = emptyCatalog(),
  p = sample(f, c);
  c.profiles.push(p);
  f.io.directory(f.control);
  writeCatalog(join(f.control, 'catalog.json'), c, null, f.io);
  const result = await front(['status'], f);
  assert.equal(result.code, 2);
  assert.match(result.text, /missing or inconsistent/);
  assert.equal(existsSync(p.code!.location), false);
});
test('S72 production entry points ignore harness tool and process override variables',
  async () => {
    const f = fixture();
    f.env['BCM_TEST_FAKE_PS' as keyof typeof f.env] = 'credential-sentinel';
    const result = await front(['status'], f);
    assert.equal(result.code, 0);
    assert.ok(!result.text.includes('credential-sentinel'));
  });
test('S69 machine services use absolute paths and bounded shell-free execution', async () => {
  for (const file of Object.values(systemTools)) {
    assert.ok(file.startsWith('/'));
  }
  await assert.rejects(execute('node', []), kind('tool-path'));
  assert.equal((await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])',
    'literal;$(echo bad)'])).stdout, 'literal;$(echo bad)');
});
test('S51 machine command timeouts and output caps expose no captured secrets', async () => {
  for (const [source, options] of [['process.stdout.write("sensitive-sentinel".repeat(1000))',
    { cap: 30 }], ['setTimeout(()=>{},1000)', { timeout: 10 }]] as const) {
    await assert.rejects(execute(process.execPath, ['-e', source], options), error => error instanceof Problem &&
      !error.message.includes('sensitive-sentinel'));
  }
});
test('absolute executable discovery ignores relative PATH entries and keeps shadow order',
  () => {
    const f = fixture(),
    a = join(f.home, 'bin-a'),
    b = join(f.home, 'bin-b');
    f.io.directory(a);
    f.io.directory(b);
    for (const path of [join(a, 'claude'), join(b, 'claude')]) {
      writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    assert.deepEqual(executableCandidates('claude', `.:relative:${a}:${b}:${a}`), [join(a,
      'claude'), join(b, 'claude')]);
  });
test('T016 S19 native replacement-grant ACLs are detected in a private fixture', () => {
  const f = fixture(),
  target = join(f.home, 'acl-parent');
  mkdirSync(target, { mode: 0o700 });
  const grant = spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child',
    target], { encoding: 'utf8', timeout: 3000 });
  assert.equal(grant.status, 0, 'The macOS fixture must support ACL grants.');
  try {
    assert.throws(() => f.io.guard.parents(join(target, 'child')), kind('parent-acl'));
  }
  finally {
    spawnSync('/bin/chmod', ['-N', target], { timeout: 3000 });
  }
});
test('T021 S14 substituted parent identity prevents replacement', () => {
  const f = fixture(),
  parent = join(f.home, 'parent'),
  path = join(parent, 'file');
  f.io.directory(parent);
  const before = f.io.write(path, 'old', null);
  const writer = new PrivateIO(f.io.guard, {
    beforeRename: () => {
      renameSync(parent, parent + '-old');
      mkdirSync(parent, { mode: 0o700 });
      writeFileSync(path, 'new parent content', { mode: 0o600 });
    }
  });
  assert.throws(() => writer.write(path, 'bad', before), kind('parent-changed'));
  assert.equal(readFileSync(path, 'utf8'), 'new parent content');
});
test('T040 S36 same-token copied records still cannot replace the released lock inode',
  async () => {
    const f = fixture(),
    lease = await locks(f).acquire('registry');
    f.io.write(lease.path, JSON.stringify(lease.owner), f.io.snapshot(lease.path));
    assert.throws(() => lease.release(), kind('lease-replaced'));
    assert.ok(existsSync(lease.path));
  });
test('T043 S33 concurrent operations allocate distinct private staging and recovery names',
  () => {
    const f = fixture(),
    target = join(f.home, 'target');
    const a = operation(f, [target]),
    b = operation(f, [target]);
    assert.notEqual(a.directory, b.directory);
    assert.equal(a.finish(), 0);
    assert.equal(b.finish(), 0);
  });
test('T025 catalog rejects contradictory extra fields and non-UTC dates', () => {
  const f = fixture(),
  c = emptyCatalog(),
  p = sample(f, c);
  c.profiles.push(p);
  assert.throws(() => validateCatalog({ ...c, guessedProfiles: [] }), kind('catalog-schema'));
  p.bornAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => validateCatalog(c), kind('catalog-schema'));
});
test('S27 catalog commits require monotonic serials and stable installation identity',
  () => {
    const f = fixture(),
    path = join(f.home, 'catalog'),
    c = emptyCatalog(),
    image = writeCatalog(path, c, null, f.io);
    assert.throws(() => writeCatalog(path, c, image, f.io), kind('catalog-revision'));
    assert.throws(() => writeCatalog(path, {
      ...c,
      serial: 1,
      installationKey: randomUUID()
    }, image, f.io), kind('catalog-revision'));
  });
test('T047 S32 failure to inventory recovery prevents the first target write', () => {
  const f = fixture(),
  target = join(f.home, 'target');
  assert.throws(() => ChangeRecord.begin(f.io, join(f.control, 'recovery'), [target], () => {
    throw new Error('inventory unavailable');
  }));
  assert.equal(existsSync(target), false);
});
test('T057 S29 completion preserves recovery if produced bytes changed', () => {
  const f = fixture(),
  target = join(f.home, 'target'),
  tx = operation(f, [target]);
  tx.write(target, 'operation');
  f.io.write(target, 'user', f.io.snapshot(target));
  assert.equal(tx.finish(), Exit.recovery);
  assert.equal(readFileSync(target, 'utf8'), 'user');
  assert.ok(existsSync(tx.directory));
});
test('T003 T009 command skeleton distinguishes valid future flags from invalid invocation',
  () => {
    const id = randomUUID();
    for (const args of [
      ['add', 'studio', '--target', 'terminal'], ['doctor', '--apply'], ['doctor', '--recover', id],
      ['rename', 'studio', 'work', '--ignore-process-check'], ['repair', 'studio', '--refresh-dock'],
      ['run-profile', 'studio', '--', '--version', 'literal;arg'],
    ]) {
      assert.doesNotThrow(() => invocation(args[0]!, args.slice(1)));
    }
    for (const args of [
      ['add', '--target', 'wrong'], ['doctor', '--apply', '--recover', id],
      ['add', '--target', 'terminal', '--target', 'paired'], ['run-profile'], ['list', '--'],
      ['status', '--force'], ['doctor', '--recover', 'invalid'],
    ]) {
      assert.throws(() => invocation(args[0]!, args.slice(1)), kind('arguments'));
    }
  });
test('T018 S16 even a restrictive umask cannot remove required private creation modes',
  () => {
    const f = fixture(),
    previous = process.umask(0o777);
    try {
      const dir = join(f.home, 'locked');
      f.io.directory(dir);
      f.io.write(join(dir, 'file'), 'bytes', null);
      f.io.append(join(dir, 'events'), 'line\n', null);
      assert.equal(lstatSync(dir).mode & 0o777, 0o700);
      for (const name of ['file', 'events']) {
        assert.equal(lstatSync(join(dir, name)).mode & 0o777,
          0o600);
      }
    }
    finally {
      process.umask(previous);
    }
  });
test('T035 S33 concurrent observers see complete atomically published owner bytes', async () => {
  const f = fixture(),
  directory = join(f.control, 'leases');
  f.io.directory(directory);
  const child = spawn(process.execPath, [join(repo, 'dist/test/lease-worker.js'), directory,
    'cycle'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let observed = 0,
  failure: unknown;
  const observer = setInterval(() => {
    try {
      const owner = JSON.parse(readFileSync(join(directory, 'registry.json'), 'utf8'));
      for (const key of ['pid', 'uid', 'boot', 'start', 'token', 'createdAt']) {
        assert.ok(Object.hasOwn(owner,
          key));
      }
      observed++;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failure = error;
      }
    }
  }, 5);
  const [code] = await closed;
  clearInterval(observer);
  if (failure) {
    throw failure;
  }
  assert.equal(code, 0);
  assert.ok(observed > 0);
});
test('T055 S30 an existing foreign staging tree cannot be claimed for cleanup', () => {
  const f = fixture(),
  stage = join(f.home, 'stage');
  f.io.directory(stage);
  f.io.write(join(stage, 'user-file'), 'keep', null);
  const tx = operation(f, [stage]);
  assert.throws(() => tx.createStaging(stage), kind('stage-exists'));
  assert.throws(() => tx.sealStaging(stage), kind('stage-ownership'));
  assert.equal(tx.finish(), 0);
  assert.equal(readFileSync(join(stage, 'user-file'), 'utf8'), 'keep');
});
test('T156 S68 empty or failed packing never starts installation', () => {
  for (const result of ['process.exitCode=1;', 'process.stdout.write("[]");']) {
    const f = fixture(),
    tool = join(f.home, 'pack-fixture.cjs'),
    marker = join(f.home, 'install-attempted');
    writeFileSync(tool,
      `if(process.argv[2]==='install'){require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')}`
      + `else{${result}}`,
      { mode: 0o600 });
    const run = spawnSync(process.execPath, [join(repo, 'dist/scripts/install-local.js')],
      { env: { ...f.env, npm_execpath: tool }, encoding: 'utf8', timeout: 5000 });
    assert.notEqual(run.status, 0);
    assert.equal(existsSync(marker), false);
  }
});
test('T017 S11 dot segments cannot conceal traversal through a linked parent', () => {
  const f = fixture(),
  alias = join(f.home, 'alias');
  symlinkSync(f.root, alias);
  const concealed = `${alias}/../escape`;
  assert.throws(() => protectedPath(concealed), kind('path-syntax'));
  assert.throws(() => f.io.write(concealed, 'bad', null), kind('path-syntax'));
  assert.equal(existsSync(join(dirname(f.root), 'escape')), false);
});
test('read-only Desktop fixture status distinguishes present and substituted resources',
  async () => {
    const f = fixture(),
    c = emptyCatalog(),
    p = sample(f, c);
    p.code = null;
    p.desktop = {
      location: join(f.home, 'profiles/studio/desktop'),
      source: join(f.home, 'source/Claude.app'),
      launcher: join(f.home, 'Applications/Claude Profiles/Claude studio.app'),
      tint: 'none',
      updateMode: 'launcher',
      defaultLocation: true,
      defaultLauncher: true
    };
    for (const path of [p.desktop.location, p.desktop.source, p.desktop.launcher]) {
      f.io.directory(path);
    }
    p.rootEvidence.push(recordRoot(p.desktop.location, 'desktop', c.installationKey, p.id,
      f.io), recordRoot(p.desktop.launcher, 'launcher', c.installationKey, p.id, f.io));
    c.profiles.push(p);
    f.io.directory(f.control);
    writeCatalog(join(f.control, 'catalog.json'), c, null, f.io);
    const before = stamp(f.home);
    assert.equal((await front(['status', 'studio'], f)).code, 0);
    assert.deepEqual(stamp(f.home), before);
    renameSync(p.desktop.location, p.desktop.location + '-kept');
    f.io.directory(p.desktop.location);
    assert.equal((await front(['status', 'studio'], f)).code, Exit.findings);
    assert.equal(readdirSync(p.desktop.location).length, 0);
  });
