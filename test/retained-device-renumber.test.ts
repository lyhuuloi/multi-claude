import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileFixture } from './support.js';
import { ChangeRecord } from '../src/change-records.js';
import { sameVolumeDevice, volumeUuidForPath } from '../src/machine-services.js';
import { PrivateIO, cleanSealedTree, sameImage, sameTreeManifest, treeManifest } from '../src/private-io.js';

const sandbox = () => profileFixture().home;

function withRenumberedDevice(raw: string): string {
  const parsed = JSON.parse(raw);
  const bump = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(bump); return; }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.device === 'string' && /^\d+$/.test(rec.device)) rec.device = String(BigInt(rec.device) + 2n);
    for (const v of Object.values(rec)) bump(v);
  };
  bump(parsed);
  return JSON.stringify(parsed, null, 2) + '\n';
}

test('retained FileImage survives reboot st_dev renumbering when volume UUID matches and refuses mismatch or missing volume', () => {
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

  const wrongVol = { ...renumbered, volume: '00000000-0000-4000-8000-000000000000' };
  const noVol = { ...renumbered }; delete noVol.volume;
  assert.equal(sameImage(io.snapshot(file), wrongVol), false);
  assert.equal(sameImage(io.snapshot(file), noVol), false);
  assert.throws(() => io.assertImage(file, wrongVol), /expected image/i);
  assert.throws(() => io.assertImage(file, noVol), /expected image/i);
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

  // Full cleanup succeeds when volume UUID matches across renumbered st_dev.
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

  // Simulate macOS reboot st_dev renumbering across every recorded device field in operation.json.
  const opFile = join(op.directory, 'operation.json');
  const raw = readFileSync(opFile, 'utf8');
  io.write(opFile, Buffer.from(withRenumberedDevice(raw)), io.snapshot(opFile));

  // Reload retained operation and roll back cleanly despite renumbered st_dev on guard, directory, file image, and moved tree manifest.
  const loaded = ChangeRecord.loadApplication(io, op.directory, null, p => p.startsWith(dir), () => {});
  const code = loaded.rollback();
  assert.equal(code, 0);
  assert.equal(existsSync(targetFile), false);
  assert.equal(existsSync(sub), false);
  assert.equal(existsSync(dest), false);
  assert.equal(existsSync(stage), false);
});
