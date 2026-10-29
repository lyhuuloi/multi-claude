import { canonicalLocation } from './location-guard.js';
import type { DirectoryStamp } from './location-guard.js';
import { PrivateIO, treeManifest } from './private-io.js';
import type { TreeEntry } from './private-io.js';
import { verifyRoot } from './profile-catalog.js';
import type { RootEvidence } from './profile-catalog.js';
import { Problem } from './outcomes.js';

export interface ApprovedTree {
  location: string;
  parents: DirectoryStamp[];
  manifest: TreeEntry[];
  root?: RootEvidence;
}

export function approveTree(location: string, io: PrivateIO, root?: RootEvidence): ApprovedTree {
  if (root) {
    verifyRoot(root, io);
  }
  const approval: ApprovedTree = {
    location: canonicalLocation(location), parents: io.guard.parents(location), manifest: treeManifest(location, io),
    ...(root ? { root: structuredClone(root) } : {}),
  };
  assertApprovedTree(location, approval, io);
  return approval;
}

export function assertApprovedTree(location: string, approval: ApprovedTree, io: PrivateIO): void {
  io.guard.recheck(approval.parents);
  if (approval.root) {
    verifyRoot(approval.root, io);
  }
  if (canonicalLocation(location) !== approval.location
    || JSON.stringify(treeManifest(location, io)) !== JSON.stringify(approval.manifest)) {
    throw new Problem('tree-approval', 'The approved directory changed or was substituted; it was left untouched.');
  }
}
