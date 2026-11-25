import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { healthFixture } from './health-support.js';
import { catalog, save } from './support.js';
import { PrivateIO } from '../src/private-io.js';
import type { FileData } from '../src/private-io.js';
import { recordRoot, verifyRoot } from '../src/profile-catalog.js';
import { Problem } from '../src/outcomes.js';

function renumberDevices(f: ReturnType<typeof healthFixture>): Map<string, { inode: string; nonce: string; oldDev: string }> {
  const value = catalog(f);
  const before = new Map<string, { inode: string; nonce: string; oldDev: string }>();
  for (const profile of value.profiles) {
    for (const root of profile.rootEvidence) {
      const shifted = String(BigInt(root.device) + 2n);
      before.set(`${profile.id}:${root.role}`, { inode: root.inode, nonce: root.nonce, oldDev: shifted });
      root.device = shifted;
    }
  }
  save(f, value);
  return before;
}

test('verifyRoot accepts APFS device renumbering when inode, owner, location and receipt match', () => {
  const f = healthFixture();
  const dir = join(f.home, 'dev-renumber-root');
  f.io.directory(dir);
  const recorded = recordRoot(dir, 'code', randomUUID(), randomUUID(), f.io);
  const stale = { ...recorded, device: String(BigInt(recorded.device) + 2n) };
  const live = verifyRoot(stale, f.io);
  assert.equal(live.device, recorded.device);
  assert.equal(live.inode, recorded.inode);
  assert.equal(live.nonce, recorded.nonce);
  // Does not mutate caller object.
  assert.equal(stale.device, String(BigInt(recorded.device) + 2n));
});

test('verifyRoot still refuses replaced inode, wrong receipt nonce, or cross-volume receipt', () => {
  const f = healthFixture();
  const dir = join(f.home, 'dev-renumber-refuse');
  f.io.directory(dir);
  const recorded = recordRoot(dir, 'code', randomUUID(), randomUUID(), f.io);

  // Cross-volume receipt (e.g. different volume mounted over root with same inode) must fail root-identity.
  const crossVolumeIO = Object.create(f.io) as PrivateIO;
  crossVolumeIO.read = (path: string): FileData | null => {
    const data = f.io.read(path);
    if (!data) {
      return null;
    }
    return { bytes: data.bytes, image: { ...data.image, device: String(BigInt(data.image.device) + 9n) } };
  };
  assert.throws(
    () => verifyRoot(recorded, crossVolumeIO),
    error => error instanceof Problem && error.kind === 'root-identity',
  );

  // Bad nonce still fails root-receipt even with drifted device.
  const wrongNonce = { ...recorded, device: String(BigInt(recorded.device) + 2n), nonce: randomUUID() };
  assert.throws(
    () => verifyRoot(wrongNonce, f.io),
    error => error instanceof Problem && error.kind === 'root-receipt',
  );

  // Replaced directory (copied receipt, new inode) still fails root-identity.
  renameSync(dir, dir + '-old');
  f.io.directory(dir);
  writeFileSync(join(dir, '.bcm-root.json'), readFileSync(join(dir + '-old', '.bcm-root.json')), { mode: 0o600 });
  assert.throws(
    () => verifyRoot({ ...recorded, device: String(BigInt(recorded.device) + 2n) }, f.io),
    error => error instanceof Problem && error.kind === 'root-identity',
  );
});

test('paired profile commands survive reboot st_dev renumbering and doctor --apply refreshes devices', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const before = renumberDevices(f);

  const status = await f.invoke(['status', 'studio'], null);
  assert.equal(status.code, 0, status.text);
  assert.match(status.text, /code: identity matches/);
  assert.match(status.text, /desktop: identity matches/);
  assert.match(status.text, /launcher: identity matches/);

  const run = await f.invoke(['run-profile', 'studio'], null);
  assert.equal(run.code, 0, run.text);

  const open = await f.invoke(['open-profile', 'studio'], null);
  assert.equal(open.code, 0, open.text);
  const recovery = join(f.control, 'recovery');
  const displaced = existsSync(recovery)
    ? readdirSync(recovery).filter(name => name.startsWith('displaced-'))
    : [];
  assert.deepEqual(displaced, [], 'Untouched copy must not be falsely displaced after reboot');

  const dock = await f.invoke(['_dock-entry', f.profile().id, join(f.control, 'catalog.json')], null);
  assert.equal(dock.code, 0, dock.text);

  const doctor = await f.invoke(['doctor'], null);
  assert.equal(doctor.code, 0, doctor.text);

  const repair = await f.invoke(['repair', 'studio'], ['n']);
  assert.equal(repair.code, 0, repair.text);

  const apply = await f.invoke(['doctor', '--apply'], []);
  assert.equal(apply.code, 0, apply.text);
  const refreshed = catalog(f);
  for (const profile of refreshed.profiles) {
    for (const root of profile.rootEvidence) {
      const liveDev = String(lstatSync(root.location, { bigint: true }).dev);
      const prev = before.get(`${profile.id}:${root.role}`)!;
      assert.equal(root.device, liveDev, `${root.role} device should be refreshed to live st_dev`);
      assert.equal(root.inode, prev.inode);
      assert.equal(root.nonce, prev.nonce);
    }
  }
});

test('displaced copy is still detected and archived when st_dev also renumbered', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  renumberDevices(f);

  const application = f.application();
  renameSync(application, join(f.home, 'original-Claude.app'));
  cpSync(f.source, application, { recursive: true });
  f.put(join(application, 'replacement-note'), 'external updater after reboot');
  const replacementInode = lstatSync(application).ino;

  const doctor = await f.invoke(['doctor'], null);
  assert.notEqual(doctor.code, 0);
  assert.match(doctor.text, /copy identity: The dedicated copy was replaced outside multi-claude/);

  const apply = await f.invoke(['doctor', '--apply'], []);
  assert.equal(apply.code, 0, apply.text);
  const recovery = join(f.control, 'recovery');
  const archives = readdirSync(recovery).filter(name => name.startsWith('displaced-'));
  assert.equal(archives.length, 1);
  assert.equal(lstatSync(join(recovery, archives[0]!, 'Claude.app')).ino, replacementInode);
});
