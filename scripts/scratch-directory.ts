import { lstatSync, rmSync, unlinkSync, rmdirSync } from 'node:fs';

export interface ScratchIdentity {
  device: bigint;
  inode: bigint;
  uid: bigint;
}

export function scratchIdentity(path: string): ScratchIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Scratch storage must be a real directory.');
  }
  return { device: stat.dev, inode: stat.ino, uid: stat.uid };
}

export function removeScratch(path: string, expected: ScratchIdentity, warn = console.error): void {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== expected.device
      || stat.ino !== expected.inode || stat.uid !== expected.uid) {
      warn(`WARNING: scratch directory was substituted; leaving it untouched: ${path}`);
      return;
    }
  } catch {
    warn(`WARNING: scratch directory cannot be checked; leaving it untouched: ${path}`);
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

export interface PackedArchive {
  path: string;
  identity: ScratchIdentity;
}

export function removePackedScratch(
  path: string, expected: ScratchIdentity, archive?: PackedArchive, warn = console.error,
): void {
  try {
    const root = scratchIdentity(path);
    if (root.device !== expected.device || root.inode !== expected.inode || root.uid !== expected.uid) {
      warn(`WARNING: packing scratch directory changed; leaving it untouched: ${path}`);
      return;
    }
    if (archive) {
      const stat = lstatSync(archive.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.dev !== archive.identity.device
        || stat.ino !== archive.identity.inode || stat.uid !== archive.identity.uid) {
        warn(`WARNING: packed archive changed; leaving scratch storage untouched: ${path}`);
        return;
      }
      unlinkSync(archive.path);
    }
    rmdirSync(path);
  } catch {
    warn(`WARNING: packing scratch cleanup could not finish; unexpected material was preserved: ${path}`);
  }
}
