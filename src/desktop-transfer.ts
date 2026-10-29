import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { PrivateIO, treeManifest } from './private-io.js';
import type { ChangeRecord } from './change-records.js';
import { present } from './managed-resources.js';
import { jsonDocument } from './setup-selection.js';
import { Problem } from './outcomes.js';
const dictionary = (value: unknown): value is Record<string, unknown> =>
!!value && typeof value === 'object' && !Array.isArray(value);
export function extensionId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,191}$/.test(id) && id !== '.' && id !== '..';
}
function connectorShape(value: Record<string, unknown>): void {
  if (value.mcpServers === undefined) {
    return;
  }
  if (!dictionary(value.mcpServers)) {
    throw new Problem('connector-shape', 'The connector inventory must be an object.');
  }
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name) || !dictionary(server)
      || (server.command !== undefined && typeof server.command !== 'string')
      || (server.url !== undefined && typeof server.url !== 'string')
      || (server.args !== undefined
        && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')))
      || (server.env !== undefined && (!dictionary(server.env)
        || Object.values(server.env).some(value => typeof value !== 'string')))) {
      throw new Problem('connector-shape', 'A connector definition is malformed; its configuration was preserved.');
    }
  }
}
export function connectorDocument(root: string, io: PrivateIO): Record<string, unknown> {
  const file = io.read(join(root, 'claude_desktop_config.json'));
  const value = file ? jsonDocument(file.bytes) : {};
  if (!dictionary(value)) {
    throw new Problem('connector-shape', 'Connector configuration must be an object.');
  }
  if (value.mcpServers !== undefined && !dictionary(value.mcpServers)) {
    throw new Problem('connector-shape', 'The connector inventory is not an object; the file was preserved.');
  }
  connectorShape(value);
  return value;
}
export function connectorInventory(root: string, io: PrivateIO): string[] {
  return Object.keys(connectorDocument(root, io).mcpServers as Record<string, unknown> ?? {}).sort();
}
export function mergeConnectors(
  source: string, target: string, selected: readonly string[], transaction: ChangeRecord, io: PrivateIO,
): { copied: string[]; unchanged: string[] } {
  const from = connectorDocument(source, io);
  const path = join(target, 'claude_desktop_config.json');
  const prior = io.read(path);
  const next = prior ? jsonDocument(prior.bytes) : {};
  if (!dictionary(next)) {
    throw new Problem('connector-shape', 'Destination connector configuration must be an object.');
  }
  if (next.mcpServers !== undefined && !dictionary(next.mcpServers)) {
    throw new Problem('connector-shape', 'The destination connector inventory is malformed and was preserved.');
  }
  connectorShape(next);
  const servers = dictionary(from.mcpServers) ? from.mcpServers : {};
  const existing = dictionary(next.mcpServers) ? next.mcpServers : {};
  const copied: string[] = [];
  const unchanged: string[] = [];
  for (const name of selected) {
    if (!Object.hasOwn(servers, name)) {
      throw new Problem('connector-selection', 'A selected connector is no longer available.');
    }
    if (Object.hasOwn(existing, name)) {
      unchanged.push(name);
    } else {
      Object.defineProperty(existing, name, {
        value: structuredClone(servers[name]), enumerable: true, writable: true, configurable: true,
      });
      copied.push(name);
    }
  }
  if (copied.length) {
    next.mcpServers = existing;
    transaction.allow(path);
    io.assertImage(path, prior?.image ?? null);
    transaction.write(path, JSON.stringify(next, null, 2) + '\n');
  }
  return { copied, unchanged };
}
export function extensionInventory(root: string, io: PrivateIO): string[] {
  const directory = join(root, 'Claude Extensions');
  if (!present(directory)) {
    return [];
  }
  io.guard.chain(directory);
  const names = readdirSync(directory).sort();
  if (names.some(name => !extensionId(name))) {
    throw new Problem('extension-id', 'An extension identifier is not a safe single path component.');
  }
  return names;
}
function manifest(root: string, io: PrivateIO): void {
  const file = io.read(join(root, 'manifest.json'));
  const value = file ? jsonDocument(file.bytes) : {};
  if (!dictionary(value) || typeof value.name !== 'string' || !value.name.trim() || typeof value.version !== 'string'
    || !/^\d+(?:\.\d+)*(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.test(value.version)
    || (value.manifest_version !== undefined && typeof value.manifest_version !== 'string')) {
    throw new Problem('extension-manifest', 'A selected extension has no valid manifest.');
  }
}
export function stageExtension(source: string, id: string, transaction: ChangeRecord, io: PrivateIO): string {
  if (!extensionId(id)) {
    throw new Problem('extension-id', 'The selected extension identifier is unsafe.');
  }
  const from = join(source, 'Claude Extensions', id);
  manifest(from, io);
  const before = treeManifest(from, io);
  if (before.some(entry => entry.kind === 'link')) {
    throw new Problem('extension-link', 'Selected extension files must not be links.');
  }
  const stage = join(transaction.directory, 'extension-' + id);
  transaction.allow(stage);
  transaction.createStaging(stage);
  for (const entry of before) {
    if (!entry.name) {
      continue;
    }
    const target = join(stage, entry.name);
    if (entry.kind === 'directory') {
      io.directory(target);
    } else {
      io.directory(dirname(target));
      io.write(target, io.read(join(from, entry.name))!.bytes, null);
    }
  }
  manifest(stage, io);
  const project = (entries: ReturnType<typeof treeManifest>) => entries.map(entry => ({
    name: entry.name, kind: entry.kind, digest: entry.digest,
  }));
  if (JSON.stringify(treeManifest(from, io)) !== JSON.stringify(before)
    || JSON.stringify(project(treeManifest(stage, io))) !== JSON.stringify(project(before))) {
    throw new Problem('extension-race', 'An extension changed during staging.');
  }
  transaction.sealStaging(stage);
  return stage;
}
export function extensionSettings(root: string, id: string, io: PrivateIO): Buffer | null {
  if (!extensionId(id)) {
    throw new Problem('extension-id', 'The selected extension identifier is unsafe.');
  }
  const value = io.read(join(root, 'Claude Extensions Settings', id + '.json'));
  if (value) {
    jsonDocument(value.bytes);
  }
  return value?.bytes ?? null;
}
