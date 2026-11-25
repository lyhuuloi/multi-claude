import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { healthFixture } from './health-support.js';
import { catalog, save } from './support.js';
import { PrivateIO } from '../src/private-io.js';
import type { FileData } from '../src/private-io.js';
import { ApplicationVault } from '../src/application-vault.js';
import { CatalogSession } from '../src/profile-actions.js';
import { ChangeRecord } from '../src/change-records.js';
import { recordRoot, sameProfileIdentity, sameRootIdentity, verifyRoot } from '../src/profile-catalog.js';
import { Problem } from '../src/outcomes.js';

function renumberDevices(f: ReturnType<typeof healthFixture>): Map<string, { inode: string; nonce: string; volume: string | undefined }> {
  const value = catalog(f);
  const before = new Map<string, { inode: string; nonce: string; volume: string | undefined }>();
  for (const profile of value.profiles) {
    for (const root of profile.rootEvidence) {
      before.set(`${profile.id}:${root.role}`, { inode: root.inode, nonce: root.nonce, volume: root.volume });
      root.device = String(BigInt(root.device) + 2n);
    }
  }
  save(f, value);
  return before;
}

test('verifyRoot binds replacement-device check to persistent volume UUID and refuses mismatched/missing volume', () => {
  const f = healthFixture();
  const dir = join(f.home, 'dev-renumber-root');
  f.io.directory(dir);
  const recorded = recordRoot(dir, 'code', randomUUID(), randomUUID(), f.io);
  assert.ok(recorded.volume, 'recordRoot must stamp persistent volume UUID on macOS');
  const stale = { ...recorded, device: String(BigInt(recorded.device) + 2n) };
  const live = verifyRoot(stale, f.io);
  assert.equal(live.device, recorded.device);
  assert.equal(live.volume, recorded.volume);
  assert.equal(stale.device, String(BigInt(recorded.device) + 2n));

  // P1 #2: different filesystem volume UUID MUST fail root-identity even with valid receipt + matching inode.
  assert.throws(
    () => verifyRoot(stale, f.io, () => randomUUID()),
    error => error instanceof Problem && error.kind === 'root-identity',
  );
  // Unavailable volume UUID MUST fail closed on device change.
  assert.throws(
    () => verifyRoot(stale, f.io, () => null),
    error => error instanceof Problem && error.kind === 'root-identity',
  );
  // Unbound legacy record (no recorded volume UUID) MUST fail closed on device change.
  const { volume: _drop, ...unbound } = stale;
  assert.throws(
    () => verifyRoot(unbound, f.io),
    error => error instanceof Problem && error.kind === 'root-identity',
  );
});

test('verifyRoot still refuses replaced inode, wrong receipt nonce, or cross-volume receipt', () => {
  const f = healthFixture();
  const dir = join(f.home, 'dev-renumber-refuse');
  f.io.directory(dir);
  const recorded = recordRoot(dir, 'code', randomUUID(), randomUUID(), f.io);

  const crossVolumeIO = Object.create(f.io) as PrivateIO;
  crossVolumeIO.read = (path: string): FileData | null => {
    const data = f.io.read(path);
    if (!data) return null;
    return { bytes: data.bytes, image: { ...data.image, device: String(BigInt(data.image.device) + 9n) } };
  };
  assert.throws(() => verifyRoot(recorded, crossVolumeIO), error => error instanceof Problem && error.kind === 'root-identity');

  const wrongNonce = { ...recorded, device: String(BigInt(recorded.device) + 2n), nonce: randomUUID() };
  assert.throws(() => verifyRoot(wrongNonce, f.io), error => error instanceof Problem && error.kind === 'root-receipt');

  renameSync(dir, dir + '-old');
  f.io.directory(dir);
  writeFileSync(join(dir, '.bcm-root.json'), readFileSync(join(dir + '-old', '.bcm-root.json')), { mode: 0o600 });
  assert.throws(() => verifyRoot({ ...recorded, device: String(BigInt(recorded.device) + 2n) }, f.io), error => error instanceof Problem && error.kind === 'root-identity');
});

test('paired profile commands survive reboot st_dev renumbering and doctor --apply refreshes devices & backfills volume', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const before = renumberDevices(f);

  assert.equal((await f.invoke(['status', 'studio'], null)).code, 0);
  assert.equal((await f.invoke(['run-profile', 'studio'], null)).code, 0);
  assert.equal((await f.invoke(['open-profile', 'studio'], null)).code, 0);
  const recovery = join(f.control, 'recovery');
  const displaced = existsSync(recovery) ? readdirSync(recovery).filter(name => name.startsWith('displaced-')) : [];
  assert.deepEqual(displaced, []);
  assert.equal((await f.invoke(['_dock-entry', f.profile().id, join(f.control, 'catalog.json')], null)).code, 0);
  assert.equal((await f.invoke(['doctor'], null)).code, 0);
  assert.equal((await f.invoke(['repair', 'studio'], ['n'])).code, 0);

  const apply = await f.invoke(['doctor', '--apply'], []);
  assert.equal(apply.code, 0, apply.text);
  for (const profile of catalog(f).profiles) {
    for (const root of profile.rootEvidence) {
      const liveDev = String(lstatSync(root.location, { bigint: true }).dev);
      const prev = before.get(`${profile.id}:${root.role}`)!;
      assert.equal(root.device, liveDev);
      assert.equal(root.inode, prev.inode);
      assert.equal(root.nonce, prev.nonce);
      assert.equal(root.volume, prev.volume);
    }
  }
  // Legacy catalog missing volume UUID gets backfilled by doctor --apply while st_dev matches.
  const legacy = catalog(f);
  for (const r of legacy.profiles[0]!.rootEvidence) delete r.volume;
  save(f, legacy);
  assert.equal((await f.invoke(['doctor', '--apply'], [])).code, 0);
  assert.ok(catalog(f).profiles[0]!.rootEvidence.every(r => Boolean(r.volume)));
});

test('P1 #1: device-ID refresh does not break recovery of retained operations or committed refresh journals', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  // 1. Retained operation.json bound to profile snapshot with pre-refresh device ID.
  const preRefresh = structuredClone(f.profile());
  for (const root of preRefresh.rootEvidence) root.device = String(BigInt(root.device) + 2n);
  const recRoot = join(f.control, 'recovery');
  const op = ChangeRecord.begin(f.io, recRoot, [], (notice, active) => {
    const next = catalog(f);
    next.recoveryClaims = active
      ? next.recoveryClaims.filter(c => c.operationId !== notice.operationId).concat(notice)
      : next.recoveryClaims.filter(c => c.operationId !== notice.operationId);
    save(f, next);
  }, preRefresh.id);
  op.bind(preRefresh, preRefresh);
  const opId = op.directory.split('/').at(-1)!;
  assert.equal(sameProfileIdentity(f.profile(), preRefresh), true);
  // Live catalog now holds live device IDs (as after doctor --apply refresh); doctor --recover must succeed.
  const rec = await f.invoke(['doctor', '--recover', opId], ['y']);
  assert.equal(rec.code, 0, rec.text);
  assert.deepEqual(catalog(f).recoveryClaims, []);

  // 2. ApplicationVault.recover recognizes a committed refresh journal even after root.device was refreshed.
  const copyRoot = f.profile().rootEvidence.find(r => r.role === 'copy')!;
  const staleEvidence = { ...copyRoot, device: String(BigInt(copyRoot.device) + 2n) };
  assert.equal(sameRootIdentity(staleEvidence, copyRoot), true);
  const vault = new ApplicationVault(f.control, f.io, f.desktop, new CatalogSession(f.io, f.control), f.profile(), async () => {}, () => {});
  const missingOp = join(f.control, 'recovery', randomUUID());
  f.io.write(vault.journal, JSON.stringify({
    format: 'bcm-refresh/1', operation: missingOp, profileId: f.profile().id,
    installationKey: catalog(f).installationKey, phase: 'installed', applications: [], evidence: staleEvidence,
  }) + '\n', null);
  await vault.recover();
  assert.equal(existsSync(vault.journal), false);
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
