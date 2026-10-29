import { join, posix } from 'node:path';
import { lstatSync, readdirSync } from 'node:fs';
import { PrivateIO } from './private-io.js';
import { isMissing, Problem } from './outcomes.js';
import { migrateDocument } from './reference-mapping.js';
const topFiles = ['settings.json', 'CLAUDE.md', 'keybindings.json'];
const topDirectories = ['skills', 'commands', 'agents', 'hooks', 'output-styles'];
const pluginFiles = ['installed_plugins.json', 'known_marketplaces.json', 'config.json', 'blocklist.json'];
const pluginDirectories = ['cache', 'marketplaces', 'repos'];
const strippedFields = [
  'apiKeyHelper', 'awsCredentialExport', 'awsAuthRefresh', 'otelHeadersHelper',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'ANTHROPIC_BASE_URL',
];
export function jsonDocument(bytes: Buffer, objectOnly = true): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Problem('setup-json', 'A required setup document is malformed.');
  }
  if (objectOnly && (!value || typeof value !== 'object' || Array.isArray(value))) {
    throw new Problem('setup-json', 'A required setup document needs an object root.');
  }
  return value;
}
export function stripSettings(value: Record<string, unknown>, removed: Set<string>): Record<string, unknown> {
  const result = { ...value };
  for (const name of strippedFields) {
    if (Object.hasOwn(result, name)) {
      removed.add(name);
      delete result[name];
    }
  }
  if (Object.hasOwn(result, 'env')) {
    if (!result.env || typeof result.env !== 'object' || Array.isArray(result.env)) {
      throw new Problem('setup-env', 'The setup environment structure is invalid.');
    }
    const env = { ...result.env } as Record<string, unknown>;
    for (const name of Object.keys(env)) {
      if (/token|api[_-]?key|secret|password|header/i.test(name) || strippedFields.includes(name)) {
        removed.add(name);
        delete env[name];
      }
    }
    result.env = env;
  }
  return result;
}
export interface SeedSelection {
  files: Map<string, Buffer>;
  directories: Set<string>;
  removed: string[];
  warnings: string[];
}
export function collectSetup(home: string, destination: string, io: PrivateIO): SeedSelection {
  const source = join(home, '.claude');
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  let totalBytes = 0;
  function collect(name: string, directory: boolean): void {
    const path = join(source, name);
    let stat;
    try {
      stat = lstatSync(path, { bigint: true });
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || stat.uid !== BigInt(io.guard.uid) || (directory && !stat.isDirectory())) {
      throw new Problem('setup-source', 'Setup contains a linked, foreign-owned or unexpected entry.');
    }
    if (directory) {
      io.guard.chain(path);
      directories.add(name);
      for (const child of readdirSync(path).sort()) {
        const childName = posix.join(name, child);
        collect(childName, lstatSync(join(source, childName)).isDirectory());
      }
    } else {
      const data = io.read(path);
      if (!data) {
        throw new Problem('setup-race', 'A selected setup entry disappeared.');
      }
      totalBytes += data.bytes.length;
      if (files.size >= 10000 || totalBytes > 64 * 1024 * 1024) {
        throw new Problem('setup-size', 'The selected setup exceeds import limits.');
      }
      files.set(name, data.bytes);
    }
  }
  for (const name of topFiles) {
    collect(name, false);
  }
  for (const name of topDirectories) {
    collect(name, true);
  }
  for (const name of pluginFiles) {
    collect(`plugins/${name}`, false);
  }
  for (const name of pluginDirectories) {
    collect(`plugins/${name}`, true);
  }
  const user = io.read(join(home, '.claude.json'));
  if (user) {
    const value = jsonDocument(user.bytes) as Record<string, unknown>;
    if (Object.hasOwn(value, 'mcpServers')) {
      if (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers)) {
        throw new Problem('setup-mcp', 'The baseline MCP configuration is invalid.');
      }
      files.set('.claude.json', Buffer.from(JSON.stringify({ mcpServers: value.mcpServers }, null, 2) + '\n'));
    }
  }
  const removed = new Set<string>();
  const warnings: string[] = [];
  const copied = (path: string) => {
    if (path === destination) {
      return true;
    }
    const suffix = path.slice(destination.length + 1);
    return files.has(suffix) || directories.has(suffix);
  };
  for (const [name, bytes] of files) {
    if (!['settings.json', 'keybindings.json', '.claude.json',
      ...pluginFiles.map(value => `plugins/${value}`)].includes(name)) {
      continue;
    }
    let value = jsonDocument(bytes, name !== 'keybindings.json');
    if (name === 'settings.json') {
      value = stripSettings(value as Record<string, unknown>, removed);
    }
    value = migrateDocument(name, value, {
      source,
      destination,
      home,
      required: false,
      copied,
      warn: message => warnings.push(message),
    });
    files.set(name, Buffer.from(JSON.stringify(value, null, 2) + '\n'));
  }
  return { files, directories, removed: [...removed].sort(), warnings };
}
export function eligibleSetup(home: string, io: PrivateIO): boolean {
  for (const name of [...topFiles, ...topDirectories, 'plugins']) {
    try {
      lstatSync(join(home, '.claude', name));
      return true;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
  return io.read(join(home, '.claude.json')) !== null;
}
