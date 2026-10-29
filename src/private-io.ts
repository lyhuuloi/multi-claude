import {
  constants as F,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  fchmodSync,
  readdirSync,
  readlinkSync,
  rmdirSync
} from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LocationGuard, protectedPath } from './location-guard.js';
import { isMissing, Problem } from './outcomes.js';
import type { BigIntStats } from 'node:fs';
export interface FileImage {
  device: string;
  inode: string;
  uid: number;
  mode: number;
  size: string;
  modified: string;
  changed: string;
  digest: string
}
export interface FileData {
  bytes: Buffer;
  image: FileImage
}
export const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const sameImage = (a: FileImage | null, b: FileImage | null): boolean => JSON.stringify(a) === JSON.stringify(b);
function regular(s: BigIntStats, uid: number): void {
  if (!s.isFile() || s.uid !== BigInt(uid) || s.nlink !== 1n || (s.mode & 0o022n) !== 0n) {
    throw new Problem('unsafe-file',
      'The file must be regular, owner-controlled and single-linked.');
  }
}
function image(s: BigIntStats, bytes: Buffer): FileImage {
  return {
    device: String(s.dev),
    inode: String(s.ino),
    uid: Number(s.uid),
    mode: Number(s.mode & 0o777n),
    size: String(s.size),
    modified: String(s.mtimeNs),
    changed: String(s.ctimeNs),
    digest: digest(bytes)
  };
}
export interface IOHooks {
  afterOpen?: (path: string, purpose: 'read' | 'append') => void;
  beforeRename?: (path: string) => void
}
export class PrivateIO {
  constructor(readonly guard = new LocationGuard(), private readonly hooks: IOHooks = {}) {
  }
  private readableParents(path: string): void {
    let p = basename(path) === 'Icon\r' ? protectedPath(dirname(path)) : dirname(protectedPath(path));
    for (;;) {
      try {
        this.guard.chain(p);
        return;
      }
      catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
      p = dirname(p);
    }
  }
  read(path: string): FileData | null {
    this.readableParents(path);
    let before: BigIntStats;
    try {
      before = lstatSync(path, { bigint: true });
    }
    catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw new Problem('read-error', 'The file cannot be inspected.');
    }
    regular(before, this.guard.uid);
    let fd: number;
    try {
      fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    }
    catch {
      throw new Problem('read-error', 'The file cannot be opened safely.');
    }
    try {
      this.hooks.afterOpen?.(path, 'read');
      const opened = fstatSync(fd, { bigint: true });
      regular(opened, this.guard.uid);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Problem('file-changed',
          'The file changed while opening.');
      }
      if (opened.size > 16n * 1024n * 1024n) {
        throw new Problem('file-size',
          'The file exceeds the supported read size.');
      }
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) {
          break;
        }
        length += count;
      }
      const bytes = buffer.subarray(0, length),
      after = fstatSync(fd, { bigint: true }),
      atPath = lstatSync(path, { bigint: true });
      if (BigInt(length) !== opened.size || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs ||
        opened.ctimeNs !== after.ctimeNs || after.dev !== atPath.dev || after.ino !== atPath.ino) {
        throw new Problem('file-changed',
          'The file changed while reading.');
      }
      return { bytes, image: image(after, bytes) };
    } finally {
      closeSync(fd);
    }
  }
  contentDigest(path: string): string {
    this.guard.chain(dirname(path));
    const before = lstatSync(path, { bigint: true });
    regular(before, this.guard.uid);
    const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    try {
      const opened = fstatSync(fd, { bigint: true });
      regular(opened, this.guard.uid);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Problem('tree-race', 'A tree entry changed while opening.');
      }
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(1024 * 1024);
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, count));
      }
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(path, { bigint: true });
      if (opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs || opened.size !== after.size
        || current.dev !== after.dev || current.ino !== after.ino) {
        throw new Problem('tree-race', 'A tree entry changed while hashing.');
      }
      return hash.digest('hex');
    } finally {
      closeSync(fd);
    }
  }
  snapshot(path: string): FileImage | null {
    return this.read(path)?.image ?? null;
  }
  assertImage(path: string, expected: FileImage | null): void {
    if (!sameImage(this.snapshot(path), expected)) {
      throw new Problem('image-conflict',
        'The current file no longer matches the expected image.');
    }
  }
  directory(path: string): void {
    protectedPath(path);
    try {
      const s = lstatSync(path, { bigint: true });
      this.guard.chain(path);
      if (!s.isDirectory() || s.uid !== BigInt(this.guard.uid)) {
        throw new Problem('directory-owner',
          'The selected directory is not owned by this user.');
      }
      return;
      // Preserve existing user-selected modes.
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    this.directory(dirname(path));
    const stamps = this.guard.parents(path);
    this.guard.recheck(stamps);
    // Keep the new directory openable even when the caller masks owner bits.
    const previousMask = process.umask(0o077);
    try {
      mkdirSync(path, { mode: 0o700 });
    } finally {
      process.umask(previousMask);
    }
    const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_DIRECTORY);
    try {
      const s = fstatSync(fd, { bigint: true });
      if (!s.isDirectory() || s.uid !== BigInt(this.guard.uid)) {
        throw new Problem('directory-race',
          'Private directory creation changed.');
      }
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
    this.flushDirectory(dirname(path));
  }
  directoryExclusive(path: string): { device: string; inode: string; uid: number } {
    protectedPath(path);
    const parents = this.guard.parents(path);
    this.guard.recheck(parents);
    const mask = process.umask(0o077);
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Problem('directory-exists', 'A planned-absent directory appeared; it was left untouched.');
      }
      throw error;
    } finally {
      process.umask(mask);
    }
    const before = lstatSync(path, { bigint: true });
    const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_DIRECTORY);
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || opened.uid !== BigInt(this.guard.uid)
        || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Problem('directory-race', 'The exclusively created directory changed.');
      }
      fchmodSync(fd, 0o700);
      this.guard.recheck(parents);
      const current = lstatSync(path, { bigint: true });
      if (!current.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw new Problem('directory-race', 'The exclusively created directory was substituted.');
      }
      this.flushDirectory(dirname(path));
      return { device: String(opened.dev), inode: String(opened.ino), uid: Number(opened.uid) };
    } finally {
      closeSync(fd);
    }
  }
  flushDirectory(path: string): void {
    const fd = openSync(path, F.O_RDONLY | F.O_NOFOLLOW | F.O_DIRECTORY);
    try {
      try {
        fsyncSync(fd);
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw error;
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  write(path: string, bytes: Buffer | string, expected: FileImage | null = this.snapshot(path),
    mode = 0o600): FileImage {
    const parents = this.guard.parents(path);
    this.assertImage(path, expected);
    const temporary = join(dirname(path), `.write-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
      regular(fstatSync(fd, { bigint: true }), this.guard.uid);
      fchmodSync(fd, mode & 0o777);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.hooks.beforeRename?.(path);
      this.guard.recheck(parents);
      this.assertImage(path, expected);
      renameSync(temporary, path);
      this.flushDirectory(dirname(path));
      return this.read(path)!.image;
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }
    }
  }
  remove(path: string, expected: FileImage): void {
    const parents = this.guard.parents(path);
    this.assertImage(path, expected);
    this.guard.recheck(parents);
    unlinkSync(path);
    this.flushDirectory(dirname(path));
  }
  append(path: string, bytes: string, expected: FileImage | null = this.snapshot(path)): FileImage {
    const parents = this.guard.parents(path);
    this.assertImage(path, expected);
    if (expected && expected.mode !== 0o600) {
      throw new Problem('log-mode', 'The existing event log is not private.');
    }
    const fd = openSync(path, F.O_WRONLY | F.O_APPEND | F.O_NOFOLLOW | (expected ? 0 : F.O_CREAT | F.O_EXCL),
      0o600);
    try {
      this.hooks.afterOpen?.(path, 'append');
      const s = fstatSync(fd, { bigint: true });
      regular(s, this.guard.uid);
      if (!expected) {
        fchmodSync(fd, 0o600);
      }
      const current = this.snapshot(path);
      if (String(s.dev) !== current?.device || String(s.ino) !== current.inode || (expected && !sameImage(current,
        expected))) {
        throw new Problem('append-conflict', 'The log descriptor does not match its expected file.');
      }
      this.guard.recheck(parents);
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return this.read(path)!.image;
  }
}
export interface TreeEntry {
  name: string;
  kind: 'directory' | 'file' | 'link';
  device: string;
  inode: string;
  uid: string;
  mode: string;
  size: string;
  modified: string;
  changed: string;
  digest: string
}
export function treeManifest(root: string, io: PrivateIO): TreeEntry[] {
  io.guard.chain(root);
  const result: TreeEntry[] = [];
  function visit(path: string, name: string): void {
    const s = lstatSync(path, { bigint: true });
    if (s.uid !== BigInt(io.guard.uid)) {
      throw new Problem('tree-owner', 'The tree contains a foreign owner.');
    }
    const kind = s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : undefined;
    if (!kind) {
      throw new Problem('tree-kind', 'The tree contains an unsupported entry.');
    }
    result.push({
      name,
      kind,
      device: String(s.dev),
      inode: String(s.ino),
      uid: String(s.uid),
      mode: String(s.mode),
      size: String(s.size),
      modified: String(s.mtimeNs),
      changed: String(s.ctimeNs),
      digest: kind === 'file' ? io.contentDigest(path) : kind === 'link' ? digest(readlinkSync(path)) : ''
    });
    if (kind === 'directory') {
      for (const child of readdirSync(path).sort()) {
        visit(join(path,
          child), name ? `${name}/${child}` : child);
      }
    }
  }
  visit(root, '');
  return result;
}
export function cleanSealedTree(root: string, manifest: TreeEntry[], io: PrivateIO, partial = false): void {
  let actual: TreeEntry[];
  try {
    actual = treeManifest(root, io);
  } catch (error) {
    if (partial && isMissing(error)) {
      return;
    }
    throw error;
  }
  if (partial) {
    for (const entry of actual) {
      const prior = manifest.find(value => value.name === entry.name);
      const directory = entry.kind === 'directory' && prior?.kind === 'directory';
      if (!prior || (directory ? ['device', 'inode', 'uid', 'mode'].some(key =>
        entry[key as keyof TreeEntry] !== prior[key as keyof TreeEntry])
        : JSON.stringify(entry) !== JSON.stringify(prior))) {
        throw new Problem('tree-conflict', 'Partial cleanup preserves changed or unrecognized material.');
      }
    }
    manifest = actual;
  }
  if (!partial && JSON.stringify(actual) !== JSON.stringify(manifest)) {
    throw new Problem('tree-conflict',
      'The staging tree changed; retain it for review.');
  }
  const parents = io.guard.parents(root);
  for (const entry of [...manifest].sort((a, b) => b.name.split('/').length - a.name.split('/').length ||
    b.name.length - a.name.length)) {
    if (entry.name.startsWith('/') || entry.name.split('/').some(n => n === '..' || n === '.')) {
      throw new Problem('tree-scope',
        'Invalid staging manifest location.');
    }
    io.guard.recheck(parents);
    const rootNow = lstatSync(root, { bigint: true }),
    rootEntry = manifest.find(e => e.name === '');
    if (!rootEntry || !rootNow.isDirectory() || String(rootNow.dev) !== rootEntry.device || String(rootNow.ino)
      !== rootEntry.inode) {
      throw new Problem('tree-conflict',
        'The staging root was substituted.');
    }
    const path = entry.name ? join(root, entry.name) : root;
    io.guard.chain(dirname(path));
    const s = lstatSync(path, { bigint: true });
    if (String(s.dev) !== entry.device || String(s.ino) !== entry.inode || String(s.uid) !== entry.uid ||
      String(s.mode) !== entry.mode) {
      throw new Problem('tree-conflict',
        'A staging entry was substituted.');
    }
    if (entry.kind === 'directory') {
      if (!s.isDirectory()) {
        throw new Problem('tree-conflict', 'A staging directory changed kind.');
      }
      rmdirSync(path);
    } else {
      const currentDigest = entry.kind === 'link' && s.isSymbolicLink() ? digest(readlinkSync(path)) : entry.kind
      === 'file'
      && s.isFile() ? io.contentDigest(path) : null;
      if (currentDigest !== entry.digest || String(s.size) !== entry.size || String(s.mtimeNs) !== entry.modified
        || String(s.ctimeNs) !== entry.changed) {
        throw new Problem('tree-conflict',
          'A staging entry changed before cleanup.');
      }
      unlinkSync(path);
    }
  }
  io.flushDirectory(dirname(root));
}
