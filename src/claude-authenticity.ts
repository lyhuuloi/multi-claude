import { lstatSync } from 'node:fs';
import { join, parse } from 'node:path';
import { LocationGuard, protectedPath } from './location-guard.js';
import { execute, systemTools } from './machine-services.js';
import type { ToolResult } from './machine-services.js';
import { Problem } from './outcomes.js';
export const pinnedRequirement = 'identifier "com.anthropic.claudefordesktop" and anchor apple generic '
+ 'and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
export type NativeTool = (file: string, args: readonly string[]) => Promise<ToolResult>;
export function bundleStructure(path: string, guard: LocationGuard, privateParent = false): void {
  protectedPath(path);
  if (privateParent) {
    guard.chain(path);
  } else {
    let cursor = parse(path).root;
    for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
      cursor = join(cursor, part);
      const component = lstatSync(cursor);
      if (!component.isDirectory() || component.isSymbolicLink()) {
        throw new Problem('bundle-structure', 'An application location contains a linked component.');
      }
    }
  }
  const root = lstatSync(path, { bigint: true });
  const contents = lstatSync(join(path, 'Contents'), { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || !contents.isDirectory() || contents.isSymbolicLink()) {
    throw new Problem('bundle-structure', 'Application roots and Contents must be real directories.');
  }
  if (privateParent) {
    guard.parents(path);
    if (root.uid !== BigInt(guard.uid) || contents.uid !== BigInt(guard.uid)) {
      throw new Problem('bundle-owner', 'The dedicated application must belong to this user.');
    }
    const parent = lstatSync(join(path, '..'), { bigint: true });
    if (parent.uid !== BigInt(guard.uid) || (parent.mode & 0o777n) !== 0o700n) {
      throw new Problem('bundle-private', 'Application storage must have a private owner-controlled parent.');
    }
  }
}
export async function verifyClaude(
  path: string,
  strict: boolean,
  guard: LocationGuard,
  tool: NativeTool = (file, args) => execute(file, args, { timeout: 120000 }),
  privateParent = false,
): Promise<void> {
  bundleStructure(path, guard, privateParent);
  const before = [path, join(path, 'Contents')].map(value => lstatSync(value, { bigint: true }));
  const args = ['--verify', '--deep', ...(strict ? ['--strict'] : []), '-R', '=' + pinnedRequirement, path];
  const result = await tool(systemTools.codesign, args);
  if (result.code !== 0) {
    throw new Problem('claude-signature', 'Claude application signature verification failed.');
  }
  bundleStructure(path, guard, privateParent);
  for (const [index, value] of [path, join(path, 'Contents')].entries()) {
    const current = lstatSync(value, { bigint: true });
    if (current.dev !== before[index]!.dev || current.ino !== before[index]!.ino) {
      throw new Problem('bundle-substituted', 'An application changed during signature verification.');
    }
  }
}
export function compareVersions(left: string | null, right: string | null): -1 | 0 | 1 | null {
  if (!left || !right || !/^\d+(?:\.\d+)*$/.test(left) || !/^\d+(?:\.\d+)*$/.test(right)) {
    return null;
  }
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const x = a[index] ?? 0n;
    const y = b[index] ?? 0n;
    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}
