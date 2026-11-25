import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-support.js';
import { installProfile, profileFixture } from './support.js';
import { approveTree } from '../src/approved-tree.js';
import { ChangeRecord } from '../src/change-records.js';
import { sameVolumeDevice, volumeUuidForPath } from '../src/machine-services.js';
import { CatalogSession } from '../src/profile-actions.js';
import { PrivateIO, cleanSealedTree, sameDeviceField, sameImage, sameTreeManifest, treeManifest } from '../src/private-io.js';

const sandbox = () => profileFixture().home;

function transformOperation(raw: string, fn: (rec: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(raw);
  const walk = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    const rec = obj as Record<string, unknown>;
    fn(rec);
    for (const v of Object.values(rec)) walk(v);
  };
  walk(parsed);
  return JSON.stringify(parsed, null, 2) + '\n';
}

const withRenumberedDevice = (raw: string): string => transformOperation(raw, rec => {
  if (typeof rec.device === 'string' && /^\d+$/.test(rec.device)) rec.device = String(BigInt(rec.device) + 2n);
});

const withoutVolume = (raw: string): string => transformOperation(raw, rec => {
  if ('volume' in rec) delete rec.volume;
});

test('P1-1: sameVolumeDevice enforces recorded volume UUID even when st_dev is numerically equal', () => {
  const uuidA = '11111111-1111-4111-8111-111111111111';
  const uuidB = '22222222-2222-4222-8222-222222222222';
  assert.equal(sameVolumeDevice('/synthetic/root', '7', '7', uuidA, () => uuidB), false);
  assert.equal(sameVolumeDevice('/synthetic/root', '7', '7', uuidA, () => null), false);
  assert.equal(sameVolumeDevice('/synthetic/root', '7', '7', uuidA, () => uuidA), true);
  assert.equal(sameVolumeDevice('/synthetic/root', '9', '7', uuidA, () => uuidA), true);
  assert.equal(sameVolumeDevice('/synthetic/root', '7', '7', undefined, () => uuidB), true);
  assert.equal(sameVolumeDevice('/synthetic/root', '9', '7', undefined, () => uuidB), false);
  assert.equal(sameDeviceField({ device: '7', volume: uuidB }, { device: '7', volume: uuidA }), false);
});

test('retained FileImage survives reboot st_dev renumbering when volume UUID matches and refuses mismatch or missing volume on identical content', () => {
  const dir = sandbox();
  const io = new PrivateIO();
  const file = join(dir, 'settings.json');
  io.write(file, Buffer.from('{"ok":true}\n'), null);
  const recorded = io.snapshot(file)!;
  assert.ok(recorded.volume, 'FileImage must record persistent APFS volume UUID');

  const renumbered = { ...recorded, device: String(BigInt(recorded.device) + 2n) };
  assert.equal(sameImage(io.snapshot(file), renumbered), true);
  assert.doesNotThrow(() => io.assertImage(file, renumbered));
  io.write(file, Buffer.from('{"ok":2}\n'), renumbered);
  assert.equal(readFileSync(file, 'utf8'), '{"ok":2}\n');

  // Capture fresh snapshot after write so only device/volume differ (inode, size, timestamps, and digest match).
  const current = io.snapshot(file)!;
  const currentRenumbered = { ...current, device: String(BigInt(current.device) + 2n) };
  const wrongVolSameDev = { ...current, volume: '00000000-0000-4000-8000-000000000000' };
  const wrongVolDiffDev = { ...currentRenumbered, volume: '00000000-0000-4000-8000-000000000000' };
  const noVolDiffDev = { ...currentRenumbered }; delete noVolDiffDev.volume;
  assert.equal(sameImage(current, wrongVolSameDev), false);
  assert.equal(sameImage(current, wrongVolDiffDev), false);
  assert.equal(sameImage(current, noVolDiffDev), false);
  assert.throws(() => io.assertImage(file, wrongVolSameDev), /expected image/i);
  assert.throws(() => io.assertImage(file, wrongVolDiffDev), /expected image/i);
  assert.throws(() => io.assertImage(file, noVolDiffDev), /expected image/i);
});

test('retained TreeManifest and cleanSealedTree survive reboot st_dev renumbering when volume UUID matches and refuse mismatch/missing volume', () => {
  const dir = sandbox();
  const io = new PrivateIO();
  const tree = join(dir, 'stage');
  mkdirSync(tree, { mode: 0o700 });
  io.write(join(tree, 'a.txt'), Buffer.from('hello\n'), null);
  const manifest = treeManifest(tree, io);
  assert.ok(manifest.every(e => Boolean(e.volume)), 'TreeEntry must record persistent volume UUID');

  const renumbered = manifest.map(e => ({ ...e, device: String(BigInt(e.device) + 2n) }));
  assert.equal(sameTreeManifest(treeManifest(tree, io), renumbered), true);

  const wrongVol = renumbered.map(e => ({ ...e, volume: '00000000-0000-4000-8000-000000000000' }));
  const noVol = renumbered.map(({ volume: _v, ...rest }) => rest);
  assert.throws(() => cleanSealedTree(tree, wrongVol, io, false), /changed|substituted/i);
  assert.throws(() => cleanSealedTree(tree, noVol, io, false), /changed|substituted/i);
  assert.throws(() => cleanSealedTree(tree, wrongVol, io, true), /changed|conflict|unrecognized/i);

  cleanSealedTree(tree, renumbered, io, false);
  assert.equal(existsSync(tree), false);
});

test('retained ChangeRecord guards, directories, files, and moved trees recover cleanly after reboot st_dev renumbering', () => {
  const dir = sandbox();
  const io = new PrivateIO();
  const recovery = join(dir, 'recovery');
  const root = join(dir, 'code-root');
  const sub = join(root, 'nested');
  const targetFile = join(sub, 'settings.json');
  const stage = join(dir, 'stage');
  const dest = join(dir, 'moved-dest');
  mkdirSync(recovery, { mode: 0o700 });
  mkdirSync(root, { mode: 0o700 });
  const rootStat = lstatSync(root, { bigint: true });
  const rootVol = volumeUuidForPath(root, String(rootStat.dev));
  assert.ok(rootVol);
  assert.equal(sameVolumeDevice(root, String(rootStat.dev), String(rootStat.dev + 2n), rootVol!), true);
  assert.equal(sameVolumeDevice(root, String(rootStat.dev), String(rootStat.dev + 2n), undefined), false);
  assert.equal(sameVolumeDevice(root, String(rootStat.dev), String(rootStat.dev + 2n), '00000000-0000-4000-8000-000000000000'), false);

  const destFile = join(dest, 'nested-edit.json');
  const op = ChangeRecord.begin(io, recovery, [targetFile, stage, dest, destFile, sub], () => {}, null);
  op.pinRoot(root, String(rootStat.dev), String(rootStat.ino), rootVol!);
  op.createDirectory(sub);
  op.write(targetFile, Buffer.from('{"a":1}\n'));
  op.createStaging(stage);
  io.write(join(stage, 'item.txt'), Buffer.from('payload\n'), null);
  op.sealStaging(stage);
  op.moveTree(stage, dest);
  op.write(destFile, Buffer.from('{"moved":true}\n'));

  const opFile = join(op.directory, 'operation.json');
  const raw = readFileSync(opFile, 'utf8');
  io.write(opFile, Buffer.from(withRenumberedDevice(raw)), io.snapshot(opFile));

  const loaded = ChangeRecord.loadApplication(io, op.directory, null, p => p.startsWith(dir), () => {});
  const code = loaded.rollback();
  assert.equal(code, 0);
  assert.equal(existsSync(targetFile), false);
  assert.equal(existsSync(sub), false);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(stage), false);
});

test('P1-2: RecoveryActions recovers a pre-upgrade base-format moved Code tree whose move.expected lacks volume', async () => {
  const f = lifecycleFixture();
  const first = installProfile(f, 'first');
  const root = first.rootEvidence.find(value => value.role === 'code')!;
  const origSettings = join(first.code!.location, 'settings.json');
  f.put(origSettings, '{"clean":true}\n');
  const movedTo = join(f.data, 'renamed/code');
  const movedSettings = join(movedTo, 'settings.json');
  const renamed = { ...first, label: 'renamed', code: { ...first.code!, location: movedTo }, rootEvidence: first.rootEvidence.map(r => r.role === 'code' ? { ...r, location: movedTo } : r) };
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [root.location, movedTo, origSettings, movedSettings], session.inventory, first.id);
  transaction.bind(first, renamed);
  transaction.createDirectory(join(f.data, 'renamed'));
  transaction.pinRoot(root.location, root.device, root.inode);
  transaction.moveTree(root.location, movedTo, true, approveTree(root.location, f.io));
  transaction.write(movedSettings, '{"interrupted":"partial"}');

  // Strip volume fields from operation.json to match a base-format retained record created before upgrading.
  const opFile = join(transaction.directory, 'operation.json');
  f.io.write(opFile, Buffer.from(withoutVolume(readFileSync(opFile, 'utf8'))), f.io.snapshot(opFile));

  const id = transaction.directory.split('/').at(-1)!;
  const result = await f.invoke(['doctor', '--recover', id], ['y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(existsSync(movedTo), false);
  assert.equal(existsSync(transaction.directory), false);
  const restored = JSON.parse(readFileSync(origSettings, 'utf8'));
  assert.equal(restored.clean, true);
  assert.equal(restored.interrupted, undefined);
});
