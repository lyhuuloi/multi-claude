import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalLocation } from './location-guard.js';
import { PrivateIO, treeManifest } from './private-io.js';
import type { Catalog, Profile, RootEvidence, RootRole } from './profile-catalog.js';
import { verifyRoot } from './profile-catalog.js';
import type { ChangeRecord } from './change-records.js';
import { isMissing, Problem } from './outcomes.js';
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return false;
  }
}
export function evidence(
  path: string, role: RootRole, profile: Profile, catalog: Catalog, io: PrivateIO,
): RootEvidence {
  io.guard.chain(path);
  const stat = lstatSync(path, { bigint: true });
  return {
    location: canonicalLocation(path), role, uid: Number(stat.uid), device: String(stat.dev), inode: String(stat.ino),
    installationKey: catalog.installationKey, profileId: profile.id, nonce: randomUUID(),
  };
}
export function rootReceipt(root: RootEvidence, tint?: string): string {
  return JSON.stringify({
    installationKey: root.installationKey, profileId: root.profileId, role: root.role, nonce: root.nonce,
    ...(tint === undefined ? {} : { tint }),
  }) + '\n';
}
export function checkedRoot(profile: Profile, role: RootRole, io: PrivateIO, missing = false): RootEvidence {
  const root = profile.rootEvidence.find(value => value.role === role);
  if (!root) {
    throw new Problem('root-evidence', `The ${role} root has no recorded identity.`);
  }
  if (!missing || present(root.location)) {
    verifyRoot(root, io);
  }
  return root;
}
export function destination(path: string, from: string | null, io: PrivateIO): void {
  let parent = dirname(path);
  while (!present(parent)) {
    parent = dirname(parent);
  }
  io.guard.chain(parent);
  if (present(path)) {
    throw new Problem('destination-exists', 'A planned destination is occupied; no resources were moved.');
  }
  if (from && lstatSync(from).dev !== lstatSync(parent).dev) {
    throw new Problem('move-volume', 'A planned data move crosses filesystem volumes.');
  }
}
export function updateLauncher(
  built: string, installed: string, root: RootEvidence, transaction: ChangeRecord, io: PrivateIO,
): void {
  verifyRoot(root, io);
  transaction.pinRoot(root.location, root.device, root.inode);
  const entries = treeManifest(built, io);
  if (entries.some(entry => entry.kind === 'link')) {
    throw new Problem('launcher-link', 'Generated launcher staging contains a link.');
  }
  for (const entry of entries) {
    if (!entry.name || entry.name === '.bcm-root.json') {
      continue;
    }
    verifyRoot(root, io);
    const path = join(installed, entry.name);
    if (entry.kind === 'directory') {
      transaction.createDirectory(path);
    } else {
      transaction.allow(path);
      transaction.write(path, io.read(join(built, entry.name))!.bytes, parseInt(entry.mode, 10) & 0o777);
    }
  }
  const stock = join(installed, 'Contents/Resources/applet.icns');
  if (!present(join(built, 'Contents/Resources/applet.icns')) && present(stock)) {
    verifyRoot(root, io);
    transaction.allow(stock);
    transaction.remove(stock);
  }
}
