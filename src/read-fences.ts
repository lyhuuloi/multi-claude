import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { canonicalLocation, protectedPath, locationKey } from './location-guard.js';
import { verifyRoot } from './profile-catalog.js';
import type { FileImage } from './private-io.js';
import type { Catalog, Profile, RootEvidence } from './profile-catalog.js';
import { PrivateIO } from './private-io.js';
import { jsonDocument } from './setup-selection.js';
import { isMissing, Problem } from './outcomes.js';
export interface FenceFinding {
  profileId: string;
  label: string;
  message: string;
}
export function directorySpellings(location: string): string[] {
  protectedPath(location);
  const result = new Set([location, canonicalLocation(location)]);
  for (const path of [...result]) {
    if (path.startsWith('/Users/')) {
      result.add('/System/Volumes/Data' + path);
    }
    if (path.startsWith('/System/Volumes/Data/Users/')) {
      result.add(path.slice('/System/Volumes/Data'.length));
    }
    if (path.startsWith('/private/tmp/')) {
      result.add(path.slice('/private'.length));
    }
    if (path.startsWith('/private/var/')) {
      result.add(path.slice('/private'.length));
    }
  }
  return [...result].sort();
}
export function expectedRules(catalog: Catalog, profile: Profile, control: string): string[] {
  if (catalog.fencePolicy === 'disabled') {
    return [];
  }
  const locations = new Set<string>([control, ...catalog.recoveryClaims.map(value => value.location)]);
  for (const sibling of catalog.profiles) {
    if (sibling.id === profile.id) {
      continue;
    }
    if (sibling.code) {
      locations.add(sibling.code.location);
    }
    if (sibling.desktop) {
      locations.add(sibling.desktop.location);
      locations.add(sibling.desktop.location + '-3p');
    }
  }
  const own = [profile.code?.location, profile.desktop?.location];
  if (profile.desktop) {
    own.push(profile.desktop.location + '-3p');
  }
  for (const retired of catalog.releasedLocations) {
    if (retired.reusedBy === profile.id
      && own.some(location => location && locationKey(location) === locationKey(retired.location))) {
      continue;
    }
    try {
      lstatSync(retired.location);
      locations.add(retired.location);
    } catch (error) {
      if (!isMissing(error)) {
        throw new Problem('retired-unreadable', 'A retired location cannot be inspected.');
      }
    }
  }
  const rules = new Set<string>();
  for (const location of locations) {
    for (const path of directorySpellings(location)) {
      rules.add(`Read(/${path})`);
      rules.add(`Read(/${path}/**)`);
    }
  }
  return [...rules].sort();
}
function settings(value: unknown): {
  document: Record<string, unknown>;
  deny: string[]
} {
  const document = value as Record<string, unknown>;
  if (document.permissions !== undefined
    && (!document.permissions || typeof document.permissions !== 'object' || Array.isArray(document.permissions))) {
    throw new Problem('fence-permissions', 'The settings permissions structure is invalid.');
  }
  const permissions = document.permissions as Record<string, unknown> | undefined;
  if (permissions?.deny !== undefined
    && (!Array.isArray(permissions.deny) || !permissions.deny.every(rule => typeof rule === 'string'))) {
    throw new Problem('fence-deny', 'The settings deny list is invalid.');
  }
  return { document, deny: (permissions?.deny as string[] | undefined) ?? [] };
}
export function synchronizeFences(
  catalog: Catalog,
  control: string,
  io: PrivateIO,
  write: (path: string, bytes: Buffer, expected: FileImage | null, root: RootEvidence) => void,
  notice: (profile: Profile) => void,
  writable: (profile: Profile) => boolean = () => true,
): FenceFinding[] {
  const findings: FenceFinding[] = [];
  for (const profile of catalog.profiles) {
    if (!profile.code) {
      continue;
    }
    try {
      if (!writable(profile)) {
        throw new Problem('fence-safety', 'Settings repair skipped because profile paths failed safety preflight.');
      }
      const root = profile.rootEvidence.find(value => value.role === 'code');
      if (!root) {
        throw new Problem('fence-root', 'Code root ownership is unrecorded.');
      }
      verifyRoot(root, io);
      const wanted = expectedRules(catalog, profile, control);
      const path = join(profile.code.location, 'settings.json');
      const data = io.read(path);
      const parsed = settings(data ? jsonDocument(data.bytes) : {});
      const priorClaims = catalog.ruleClaims.find(claim => claim.profileId === profile.id)?.rules ?? [];
      const retained = parsed.deny.filter(rule => !priorClaims.includes(rule) || wanted.includes(rule));
      const claims = priorClaims.filter(rule => retained.includes(rule) && wanted.includes(rule));
      for (const rule of wanted) {
        if (!retained.includes(rule)) {
          retained.push(rule);
          claims.push(rule);
        }
      }
      if (JSON.stringify(parsed.deny) !== JSON.stringify(retained)) {
        const permissions = {
          ...(parsed.document.permissions as Record<string, unknown> | undefined),
          deny: retained
        };
        const bytes = Buffer.from(JSON.stringify({ ...parsed.document, permissions }, null, 2) + '\n');
        verifyRoot(root, io);
        io.assertImage(path, data?.image ?? null);
        write(path, bytes, data?.image ?? null, root);
        notice(profile);
      }
      catalog.ruleClaims = catalog.ruleClaims.filter(claim => claim.profileId !== profile.id);
      if (claims.length) {
        catalog.ruleClaims.push({ profileId: profile.id, rules: [...new Set(claims)].sort() });
      }
      const actual = io.read(path);
      const audited = settings(actual ? jsonDocument(actual.bytes) : {}).deny;
      if (wanted.some(rule => !audited.includes(rule))) {
        throw new Problem('fence-drift', 'Read rules still differ after synchronization.');
      }
    } catch (error) {
      findings.push({
        profileId: profile.id,
        label: profile.label,
        message: error instanceof Problem ? error.message : 'The settings file cannot be safely inspected.',
      });
    }
  }
  return findings;
}
export function auditFences(catalog: Catalog, control: string, io: PrivateIO): FenceFinding[] {
  const copy = structuredClone(catalog);
  return synchronizeFences(copy, control, io, () => {
    throw new Problem('fence-missing', 'Read rules need synchronization.');
  }, () => {
  });
}
