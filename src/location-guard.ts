import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, basename } from 'node:path';
import { parentAclAllowsReplacement } from './machine-services.js';
import { isMissing, Problem } from './outcomes.js';
export const currentUid = () => process.getuid!();
export function protectedPath(path: string): string {
  if (!isAbsolute(path) || path.split('/').some(part => part === '.' || part === '..') ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\[\](){}\\*?!]/u.test(path)) {
    throw new Problem('path-syntax',
      'A protected location must be absolute and contain no unsupported characters.');
  }
  return normalize(path);
}
function descendantPath(path: string, root: string): string {
  if (path !== root && (!path.startsWith(root + '/') || path.includes('\0')
    || path.slice(root.length + 1).split('/').some(part => part === '' || part === '.' || part === '..'))) {
    throw new Problem('path-syntax', 'A tree entry must stay inside its protected root.');
  }
  return path;
}
export function canonicalLocation(path: string): string {
  let cursor = protectedPath(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cursor), ...tail);
    }
    catch (error) {
      if (!isMissing(error)) {
        throw new Problem('path-unreadable', 'Cannot resolve a location.');
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new Problem('path-unresolved', 'Cannot resolve a location ancestor.');
    }
    tail.unshift(basename(cursor));
    cursor = parent;
  }
}
// Conservative on case-sensitive volumes too: a rejected alias is safer than a missed one.
export function locationKey(path: string): string {
  return canonicalLocation(path)
  .normalize('NFC')
  .toLowerCase()
  .replace(/^\/system\/volumes\/data(?=\/users\/)/, '')
  .replace(/\/$/, '');
}
export function overlaps(a: string, b: string): boolean {
  const x = locationKey(a);
  const y = locationKey(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
export function refuseOverlap(candidate: string, occupied: readonly string[]): void {
  if (occupied.some(path => overlaps(candidate, path))) {
    throw new Problem('overlap',
      'The selected location intersects a protected location.');
  }
}
export function baselineLocations(home: string): string[] {
  return ['/Applications/Claude.app',
    join(home, 'Applications/Claude.app'),
    join(home, '.claude'),
    join(home, '.claude.json'),
    join(home, 'Library/Application Support/Claude'),
    join(home, 'Library/Application Support/Claude-3p'),
    join(home, '.config/gh')];
}
export interface DirectoryStamp {
  path: string;
  device: string;
  inode: string
}
export class LocationGuard {
  private readonly inspectedAcls = new Map<string, string>();
  constructor(readonly uid = currentUid(), private readonly acl = parentAclAllowsReplacement) {
  }
  // `within` names an already selected root. Entries below it are names the tool did not choose, such as
  // "Claude Helper (GPU).app" inside a copied application, so only their traversal syntax is refused.
  chain(path: string, within?: string): DirectoryStamp[] {
    const normalized = within === undefined ? protectedPath(path) : descendantPath(path, protectedPath(within));
    let cursor = parse(normalized).root;
    const stamps: DirectoryStamp[] = [];
    const components = normalized.slice(cursor.length).split('/').filter(Boolean);
    for (const component of ['', ...components]) {
      cursor = component ? join(cursor, component) : cursor;
      const s = lstatSync(cursor, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink()) {
        throw new Problem('parent-kind',
          'A location component is not a real directory.');
      }
      if (s.uid !== BigInt(this.uid) && s.uid !== 0n) {
        throw new Problem('parent-owner',
          'A location parent belongs to another owner.');
      }
      const shared = (s.mode & 0o022n) !== 0n;
      // A sticky ancestor is allowed only above a private, owner-controlled boundary.
      if (shared && !(cursor !== normalized && (s.mode & 0o1000n) !== 0n)) {
        throw new Problem('parent-writable',
          'A writable shared parent is unsafe, including a sticky immediate parent.');
      }
      const aclStamp = `${s.dev}:${s.ino}:${s.ctimeNs}`;
      if (this.inspectedAcls.get(cursor) !== aclStamp) {
        if (this.acl(cursor)) {
          throw new Problem('parent-acl', 'A parent ACL permits replacement by another principal.');
        }
        this.inspectedAcls.set(cursor, aclStamp);
      }
      stamps.push({ path: cursor, device: String(s.dev), inode: String(s.ino) });
    }
    return stamps;
  }
  parents(target: string): DirectoryStamp[] {
    const parent = basename(target) === 'Icon\r' ? protectedPath(dirname(target)) : dirname(protectedPath(target));
    return this.chain(parent);
  }
  recheck(stamps: readonly DirectoryStamp[]): void {
    for (const stamp of stamps) {
      const s = lstatSync(stamp.path, { bigint: true });
      if (!s.isDirectory() || String(s.dev) !== stamp.device || String(s.ino) !== stamp.inode) {
        throw new Problem('parent-changed',
          'A location parent changed during the operation.');
      }
    }
    if (stamps.length) {
      this.chain(stamps[stamps.length - 1]!.path);
    }
  }
}
