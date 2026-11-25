import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { canonicalLocation, protectedPath, refuseOverlap, baselineLocations } from './location-guard.js';
import { volumeUuidForPath } from './machine-services.js';
import { PrivateIO } from './private-io.js';
import type { FileData, FileImage } from './private-io.js';
import { Problem, Exit } from './outcomes.js';
// The catalog format id keeps the tool's first name so existing registries stay readable.
export const formatTag = 'ben-claude-multi/catalog@1';
export type RootRole = 'code' | 'desktop' | 'policy' | 'launcher' | 'copy';
export interface RootEvidence {
  location: string;
  uid: number;
  device: string;
  inode: string;
  volume?: string;
  role: RootRole;
  installationKey: string;
  profileId: string;
  nonce: string
}
export interface CodeSurface {
  location: string;
  shell: 'zsh' | 'bash' | 'fish';
  rc: string;
  command: string;
  github: string | null;
  defaultLocation: boolean;
  defaultCommand: boolean;
  entryChangedAt: string;
  runtime?: string;
  cli?: string;
}
export interface DesktopSurface {
  location: string;
  source: string;
  launcher: string;
  tint: 'none' | 'amber' | 'copper' | 'mint' | 'sky' | 'violet' | 'rose';
  updateMode: 'launcher' | 'application';
  defaultLocation: boolean;
  defaultLauncher: boolean;
  runtime?: string;
  cli?: string;
  useClaudeIcon?: boolean;
  shortcut?: string;
}
export interface Profile {
  id: string;
  label: string;
  bornAt: string;
  changedAt: string;
  code: CodeSurface | null;
  desktop: DesktopSurface | null;
  credentialPolicy: 'subscription' | 'inherit';
  rootEvidence: RootEvidence[]
}
export interface ReleasedLocation {
  id: string;
  location: string;
  role: 'code' | 'desktop' | 'policy';
  formerProfileId: string;
  formerLabel: string;
  retiredAt: string;
  reason: 'kept' | 'deleted' | 'relocated';
  reusedBy: string | null
}
export interface RecoveryClaim {
  operationId: string;
  location: string;
  profileId: string | null
}
export interface Catalog {
  formatTag: typeof formatTag;
  serial: number;
  installationKey: string;
  profiles: Profile[];
  releasedLocations: ReleasedLocation[];
  fencePolicy: 'enabled' | 'disabled';
  ruleClaims: {
    profileId: string;
    rules: string[]
  }[];
  recoveryClaims: RecoveryClaim[]
}
export const uuid = (x: unknown): x is string => typeof x === 'string' &&
/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export const volumeId = (x: unknown): x is string => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
export const sameRootIdentity = (a: RootEvidence | undefined, b: RootEvidence | undefined): boolean =>
  !!a && !!b && a.location === b.location && a.uid === b.uid && a.inode === b.inode && a.role === b.role && a.installationKey === b.installationKey && a.profileId === b.profileId && a.nonce === b.nonce && (a.volume === undefined || b.volume === undefined || a.volume === b.volume);
export const sameProfileIdentity = (a: Profile | null, b: Profile | null): boolean =>
  !a || !b ? a === b : JSON.stringify({ ...a, rootEvidence: 0 }) === JSON.stringify({ ...b, rootEvidence: 0 }) && a.rootEvidence.length === b.rootEvidence.length && a.rootEvidence.every((r, i) => sameRootIdentity(r, b.rootEvidence[i]));
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const timestamp = (x: unknown): boolean => text(x) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
Number.isFinite(Date.parse(x))
&& new Date(x).toISOString() === x;
const choices = (x: unknown, values: readonly string[]): boolean => text(x) && values.includes(x);
export const validLabel = (x: unknown): x is string => text(x) && x !== 'baseline' &&
/^[a-z](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(x);
export const validCommand = (x: unknown): x is string => text(x) && /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(x) &&
!['claude', 'multi-claude', 'ben-claude-multi'].includes(x);
function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new Problem('catalog-schema', 'The catalog structure is invalid.',
      Exit.failure);
  }
}
function fields(value: Record<string, unknown>, allowed: string): void {
  requireValue(Object.keys(value).every(key => allowed.split(' ').includes(key)));
}
function path(x: unknown): asserts x is string {
  requireValue(text(x));
  try {
    protectedPath(x);
  } catch {
    throw new Problem('catalog-schema', 'The catalog contains an unsafe location.', Exit.failure);
  }
}
export function validateCatalog(value: unknown): Catalog {
  requireValue(object(value));
  fields(value, 'formatTag serial installationKey profiles releasedLocations fencePolicy ruleClaims recoveryClaims');
  if (value.formatTag !== formatTag) {
    throw new Problem('catalog-format', 'This catalog format is unsupported.',
      Exit.failure);
  }
  requireValue(Number.isSafeInteger(value.serial) && Number(value.serial) >= 0 && uuid(value.installationKey));
  requireValue(Array.isArray(value.profiles) && Array.isArray(value.releasedLocations) &&
    Array.isArray(value.ruleClaims)
    && Array.isArray(value.recoveryClaims) && choices(value.fencePolicy, ['enabled', 'disabled']));
  const ids = new Set<string>(),
  labels = new Set<string>(),
  commands = new Set<string>();
  for (const p of value.profiles) {
    requireValue(object(p) && uuid(p.id) && validLabel(p.label) && timestamp(p.bornAt) && timestamp(p.changedAt) &&
      choices(p.credentialPolicy, ['subscription', 'inherit']) && Array.isArray(p.rootEvidence));
    fields(p, 'id label bornAt changedAt code desktop credentialPolicy rootEvidence');
    requireValue(!ids.has(p.id) && !labels.has(p.label));
    ids.add(p.id);
    labels.add(p.label);
    requireValue(p.code === null || object(p.code));
    requireValue(p.desktop === null || object(p.desktop));
    requireValue(p.code || p.desktop);
    if (object(p.code)) {
      const c = p.code;
      fields(c, 'location shell rc command github defaultLocation defaultCommand entryChangedAt runtime cli');
      path(c.location);
      path(c.rc);
      if (c.runtime !== undefined || c.cli !== undefined) {
        path(c.runtime);
        path(c.cli);
      }
      requireValue(choices(c.shell, ['zsh', 'bash', 'fish']) && validCommand(c.command) && typeof
        c.defaultLocation === 'boolean'
        && typeof c.defaultCommand === 'boolean' && timestamp(c.entryChangedAt));
      requireValue(!commands.has(c.command));
      commands.add(c.command);
      if (c.github !== null) {
        path(c.github);
        requireValue(c.github === join(c.location, 'github'));
      }
    }
    if (object(p.desktop)) {
      const d = p.desktop;
      fields(d, 'location source launcher tint updateMode defaultLocation defaultLauncher runtime cli useClaudeIcon shortcut');
      if (d.shortcut !== undefined) {
        path(d.shortcut);
        requireValue(d.shortcut.endsWith('.app'));
      }
      requireValue(d.useClaudeIcon === undefined || typeof d.useClaudeIcon === 'boolean');
      path(d.location);
      path(d.source);
      path(d.launcher);
      if (d.runtime !== undefined || d.cli !== undefined) {
        path(d.runtime);
        path(d.cli);
      }
      requireValue(!d.location.toLowerCase().endsWith('-3p') && d.launcher.endsWith('.app') && choices(d.tint,
        ['none', 'amber', 'copper', 'mint', 'sky', 'violet', 'rose']) && choices(d.updateMode,
          ['launcher', 'application'])
        && typeof d.defaultLocation === 'boolean' && typeof d.defaultLauncher === 'boolean');
    }
    const roles = new Set<string>();
    for (const r of p.rootEvidence) {
      requireValue(object(r));
      fields(r, 'location uid device inode volume role installationKey profileId nonce');
      path(r.location);
      requireValue(Number.isSafeInteger(r.uid) && Number(r.uid) >= 0 && text(r.device) && /^\d+$/.test(r.device) &&
        text(r.inode) && /^\d+$/.test(r.inode) && (r.volume === undefined || volumeId(r.volume)) &&
        choices(r.role, ['code', 'desktop', 'policy', 'launcher', 'copy']) &&
        r.installationKey === value.installationKey && r.profileId === p.id && uuid(r.nonce));
      requireValue(text(r.role) && !roles.has(r.role));
      roles.add(r.role);
      requireValue(r.role === 'code' ? p.code !== null : p.desktop !== null);
      const expected = r.role === 'code' ? (p.code as CodeSurface | null)?.location : r.role === 'desktop' ?
      (p.desktop as DesktopSurface | null)?.location
      : r.role === 'policy' ? (p.desktop as DesktopSurface | null)?.location + '-3p' : r.role === 'launcher' ?
      (p.desktop as DesktopSurface | null)?.launcher
      : r.location;
      requireValue(expected === r.location);
    }
  }
  const retiredIds = new Set<string>();
  for (const r of value.releasedLocations) {
    requireValue(object(r));
    fields(r, 'id location role formerProfileId formerLabel retiredAt reason reusedBy');
    path(r.location);
    requireValue(uuid(r.id) && !retiredIds.has(r.id) && uuid(r.formerProfileId) && validLabel(r.formerLabel) &&
      timestamp(r.retiredAt) && choices(r.role, ['code', 'desktop', 'policy']) && choices(r.reason,
        ['kept', 'deleted', 'relocated']) && (r.reusedBy === null || uuid(r.reusedBy)));
    retiredIds.add(r.id);
  }
  const claimIds = new Set<string>();
  for (const c of value.ruleClaims) {
    requireValue(object(c));
    fields(c, 'profileId rules');
    requireValue(object(c) && uuid(c.profileId) && ids.has(c.profileId) && !claimIds.has(c.profileId) &&
      Array.isArray(c.rules)
      && c.rules.every(text) && new Set(c.rules).size === c.rules.length);
    claimIds.add(c.profileId);
  }
  for (const c of value.recoveryClaims) {
    requireValue(object(c));
    fields(c, 'operationId location profileId');
    requireValue(object(c) && uuid(c.operationId) && (c.profileId === null || uuid(c.profileId)));
    path(c.location);
  }
  return value as unknown as Catalog;
}
export function emptyCatalog(): Catalog {
  return {
    formatTag,
    serial: 0,
    installationKey: randomUUID(),
    profiles: [],
    releasedLocations: [],
    fencePolicy: 'enabled',
    ruleClaims: [],
    recoveryClaims: []
  };
}
export interface LoadedCatalog {
  kind: 'absent' | 'present';
  catalog: Catalog;
  image: FileImage | null
}
export function readCatalog(file: string, io: PrivateIO): LoadedCatalog {
  let data;
  try {
    data = io.read(file);
  } catch (error) {
    const unreadable = (error instanceof Problem && error.kind === 'read-error') || ['EACCES',
      'EPERM',
      'EIO'].includes((error as NodeJS.ErrnoException).code ?? '');
    throw new Problem(unreadable ? 'catalog-unreadable' : 'catalog-unsafe', unreadable ? 'The catalog is unreadable.'
      : 'The catalog failed filesystem safety checks.', unreadable ? Exit.failure : Exit.refusal);
  }
  if (!data) {
    return { kind: 'absent', catalog: emptyCatalog(), image: null };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.bytes));
  }
  catch {
    throw new Problem('catalog-json', 'The catalog is not valid UTF-8 JSON.', Exit.failure);
  }
  return { kind: 'present', catalog: validateCatalog(value), image: data.image };
}
export function validateLocations(catalog: Catalog, home: string, control: string): void {
  const used = [...baselineLocations(home), control];
  for (const p of catalog.profiles) {
    for (const location of [p.code?.location, p.desktop?.location, p.desktop ? p.desktop.location + '-3p' :
      undefined, p.desktop?.launcher]) {
      if (!location) {
        continue;
      }
      refuseOverlap(location, used);
      used.push(location);
    }
  }
}
export function writeCatalog(file: string, catalog: Catalog, expected: FileImage | null,
  io: PrivateIO): FileImage {
  validateCatalog(catalog);
  const current = readCatalog(file, io);
  io.assertImage(file, expected);
  if (current.kind === 'present' && (catalog.serial !== current.catalog.serial + 1 || catalog.installationKey !==
    current.catalog.installationKey)) {
    throw new Problem('catalog-revision',
      'Catalog changes must advance the serial and preserve installation identity.');
  }
  return io.write(file, JSON.stringify(catalog, null, 2) + '\n', expected);
}
export function recordRoot(location: string, role: RootRole, installationKey: string, profileId: string,
  io: PrivateIO): RootEvidence {
  io.guard.chain(location);
  const s = lstatSync(location, { bigint: true });
  if (s.uid !== BigInt(io.guard.uid)) {
    throw new Problem('root-owner', 'The profile root belongs to another owner.');
  }
  const liveDevice = String(s.dev), volume = volumeUuidForPath(location, liveDevice);
  const evidence: RootEvidence = {
    location: canonicalLocation(location), role, installationKey, profileId, nonce: randomUUID(),
    uid: Number(s.uid), device: liveDevice, inode: String(s.ino), ...(volume ? { volume } : {}),
  };
  io.write(join(role === 'copy' ? dirname(location) : location, role === 'copy' ? '.bcm-copy.json' :
    '.bcm-root.json'), JSON.stringify({ installationKey, profileId, role, nonce: evidence.nonce }), null);
  return evidence;
}
export function verifyRoot(r: RootEvidence, io: PrivateIO, volumeLookup = volumeUuidForPath): RootEvidence {
  io.guard.chain(r.location);
  const s = lstatSync(r.location, { bigint: true }), liveDevice = String(s.dev);
  if (canonicalLocation(r.location) !== r.location || Number(s.uid) !== r.uid || String(s.ino) !== r.inode) throw new Problem('root-identity', 'The profile root identity does not match its registration.');
  let data: FileData | null, receipt: unknown;
  try { data = io.read(join(r.role === 'copy' ? dirname(r.location) : r.location, r.role === 'copy' ? '.bcm-copy.json' : '.bcm-root.json')); receipt = JSON.parse(data?.bytes.toString('utf8') ?? 'null'); }
  catch { throw new Problem('root-receipt', 'The profile receipt is unreadable.'); }
  if (!data || !object(receipt) || receipt.installationKey !== r.installationKey || receipt.profileId !== r.profileId || receipt.role !== r.role || receipt.nonce !== r.nonce) throw new Problem('root-receipt', 'The profile receipt does not match its registration.');
  const liveVolume = liveDevice !== r.device || r.volume === undefined ? volumeLookup(r.location, liveDevice) : r.volume;
  if (data.image.device !== liveDevice || (liveDevice !== r.device && (!r.volume || !liveVolume || liveVolume !== r.volume))) throw new Problem('root-identity', 'The profile root identity does not match its registration.');
  return liveDevice === r.device && (r.volume !== undefined || !liveVolume) ? r : { ...r, device: liveDevice, ...(liveVolume ? { volume: liveVolume } : {}) };
}
