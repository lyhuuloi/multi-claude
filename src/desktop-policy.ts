import { approveTree } from './approved-tree.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrivateIO, digest, treeManifest } from './private-io.js';
import type { ChangeRecord } from './change-records.js';
import type { Catalog, Profile, RootEvidence } from './profile-catalog.js';
import { uuid, verifyRoot } from './profile-catalog.js';
import { evidence, present, rootReceipt } from './managed-resources.js';
import { jsonDocument } from './setup-selection.js';
import { Problem } from './outcomes.js';
interface PolicyReceipt {
  format: 'bcm-policy/1';
  installationKey: string;
  profileId: string;
  nonce: string;
  entry: string;
  members: Record<string, string>;
}
export interface PolicyView {
  kind: 'absent' | 'owned' | 'foreign' | 'changed';
  effective: 'blocked' | 'allowed' | 'unknown';
  location: string;
  receipt?: PolicyReceipt;
  root?: RootEvidence;
}
export function policyView(profile: Profile, io: PrivateIO): PolicyView {
  const location = profile.desktop!.location + '-3p';
  if (!present(location)) {
    return { kind: 'absent', effective: 'allowed', location };
  }
  const base: PolicyView = { kind: 'foreign', effective: 'unknown', location };
  try {
    io.guard.chain(location);
    const metadata = io.read(join(location, 'configLibrary/_meta.json'));
    if (metadata) {
      const meta = jsonDocument(metadata.bytes);
      if (meta && typeof meta === 'object' && !Array.isArray(meta) && 'appliedId' in meta && uuid(meta.appliedId)) {
        const entry = io.read(join(location, 'configLibrary', meta.appliedId + '.json'));
        if (entry) {
          const value = jsonDocument(entry.bytes);
          if (value && typeof value === 'object' && 'disableAutoUpdates' in value) {
            base.effective = value.disableAutoUpdates === true ? 'blocked'
            : value.disableAutoUpdates === false ? 'allowed' : 'unknown';
          }
        }
      }
    }
    const root = profile.rootEvidence.find(value => value.role === 'policy');
    if (!root) {
      return base;
    }
    base.kind = 'changed';
    verifyRoot(root, io);
    const bytes = io.read(join(location, '.bcm-policy.json'));
    if (!bytes) {
      return base;
    }
    const receipt = JSON.parse(bytes.bytes.toString('utf8')) as PolicyReceipt;
    if (receipt.format !== 'bcm-policy/1' || receipt.installationKey !== root.installationKey
      || receipt.profileId !== profile.id || receipt.nonce !== root.nonce || !uuid(receipt.entry)
      || !receipt.members || typeof receipt.members !== 'object' || Array.isArray(receipt.members)) {
      return base;
    }
    const names = ['.bcm-root.json', 'configLibrary/_meta.json', 'configLibrary/' + receipt.entry + '.json'].sort();
    if (JSON.stringify(Object.keys(receipt.members).sort()) !== JSON.stringify(names)) {
      return base;
    }
    for (const name of names) {
      const file = io.read(join(location, name));
      if (!file || digest(file.bytes) !== receipt.members[name]) {
        return base;
      }
    }
    return { kind: 'owned', effective: base.effective, location, root, receipt };
  } catch {
    return base;
  }
}
export function createPolicy(profile: Profile, catalog: Catalog, transaction: ChangeRecord, io: PrivateIO): boolean {
  const view = policyView(profile, io);
  if (view.kind !== 'absent') {
    return view.kind === 'owned' && view.effective === 'blocked';
  }
  const stage = join(transaction.directory, 'policy-' + randomUUID());
  transaction.allow(stage);
  transaction.createStaging(stage);
  io.directory(join(stage, 'configLibrary'));
  const root = evidence(stage, 'policy', profile, catalog, io);
  const entry = randomUUID();
  const members = new Map([
    ['.bcm-root.json', rootReceipt(root)],
    ['configLibrary/_meta.json', JSON.stringify({
      appliedId: entry, entries: [{ id: entry, name: 'Managed updates' }],
    })],
    // Claude Desktop reads the applied entry as configLibrary/<id>.json.
    ['configLibrary/' + entry + '.json', JSON.stringify({ disableAutoUpdates: true })],
  ]);
  for (const [name, bytes] of members) {
    io.write(join(stage, name), bytes, null);
  }
  const receipt: PolicyReceipt = {
    format: 'bcm-policy/1', installationKey: root.installationKey, profileId: profile.id, nonce: root.nonce,
    entry, members: Object.fromEntries([...members].map(([name, bytes]) => [name, digest(bytes)])),
  };
  io.write(join(stage, '.bcm-policy.json'), JSON.stringify(receipt) + '\n', null);
  transaction.sealStaging(stage);
  transaction.allow(view.location);
  transaction.createDirectory(join(view.location, '..'));
  transaction.moveTree(stage, view.location);
  root.location = view.location;
  profile.rootEvidence = profile.rootEvidence.filter(value => value.role !== 'policy').concat(root);
  return true;
}
export function clearPolicy(profile: Profile, transaction: ChangeRecord, io: PrivateIO): boolean {
  const view = policyView(profile, io);
  if (view.kind === 'absent') {
    profile.rootEvidence = profile.rootEvidence.filter(value => value.role !== 'policy');
    return true;
  }
  if (view.kind !== 'owned' || !view.receipt || !view.root) {
    return false;
  }
  const family = ['.bcm-policy.json', ...Object.keys(view.receipt.members)];
  const approved = approveTree(view.location, io, view.root);
  const entries = approved.manifest;
  const unrelated = entries.some(entry => entry.name && entry.name !== 'configLibrary'
    && !family.includes(entry.name));
  const images = new Map(family.map(name => [name, io.snapshot(join(view.location, name))]));
  verifyRoot(view.root, io);
  if (JSON.stringify(treeManifest(view.location, io)) !== JSON.stringify(entries)) {
    throw new Problem('policy-race', 'The policy family changed before cleanup.');
  }
  if (!unrelated) {
    const retired = join(transaction.directory, 'policy-retired-' + randomUUID());
    transaction.allow(view.location);
    transaction.allow(retired);
    transaction.moveTree(view.location, retired, true, approved);
    profile.rootEvidence = profile.rootEvidence.filter(value => value.role !== 'policy');
  } else {
    for (const name of family.filter(name => name !== '.bcm-root.json')) {
      if (policyView(profile, io).kind !== 'owned' && name === family[0]) {
        throw new Problem('policy-race', 'The owned policy family changed before cleanup.');
      }
      verifyRoot(view.root, io);
      const path = join(view.location, name);
      transaction.allow(path);
      io.assertImage(path, images.get(name)!);
      transaction.remove(path);
    }
  }
  return true;
}
