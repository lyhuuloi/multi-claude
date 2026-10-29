import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { PrivateIO } from './private-io.js';
import type { CodeSurface, Profile } from './profile-catalog.js';
import { uuid, validCommand } from './profile-catalog.js';
import { Problem, shellQuote } from './outcomes.js';
interface ShellBlock {
  id: string;
  start: number;
  end: number;
  separator: boolean;
  body: Buffer;
}
function blocks(bytes: Buffer): ShellBlock[] {
  const text = bytes.toString('latin1');
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result: ShellBlock[] = [];
  let offset = 0;
  let current: {
    id: string;
    start: number;
    bodyStart: number;
    separator: boolean
  } | null = null;
  const seen = new Set<string>();
  for (const line of lines) {
    const content = line.replace(/\r?\n$/, '');
    if (content.startsWith('# bcm-profile ')) {
      const marker = content.match(/^# bcm-profile ([0-9a-f-]+) (begin [01]|end)$/);
      if (!marker || !uuid(marker[1])) {
        throw new Problem('shell-markers', 'A managed shell marker is malformed.');
      }
      const id = marker[1];
      if (marker[2]!.startsWith('begin')) {
        if (current || seen.has(id)) {
          throw new Problem('shell-markers', 'Managed shell entries are nested or duplicated.');
        }
        const separator = marker[2] === 'begin 1';
        const eol = offset >= 2 && text.slice(offset - 2, offset) === '\r\n' ? 2 : 1;
        if (separator && (offset < eol || text[offset - 1] !== '\n')) {
          throw new Problem('shell-markers', 'A managed shell separator is inconsistent.');
        }
        current = { id, start: offset - (separator ? eol : 0), bodyStart: offset + line.length, separator };
      } else {
        if (!current || current.id !== id) {
          throw new Problem('shell-markers', 'A managed shell entry has an unmatched end.');
        }
        result.push({
          id,
          start: current.start,
          end: offset + line.length,
          separator: current.separator,
          body: bytes.subarray(current.bodyStart, offset),
        });
        seen.add(id);
        current = null;
      }
    }
    offset += line.length;
  }
  if (current) {
    throw new Problem('shell-markers', 'A managed shell entry is unfinished.');
  }
  return result;
}
function quote(value: string, shell: CodeSurface['shell']): string {
  if (/[\x00-\x1f\x7f\u2028\u2029]/u.test(value)) {
    throw new Problem('shell-path', 'A shell route contains unsupported control characters.');
  }
  return shell === 'fish'
  ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  : shellQuote(value);
}
export function shellBody(profile: Profile, eol = '\n'): Buffer {
  const code = profile.code;
  if (!code?.runtime || !code.cli || !isAbsolute(code.runtime) || !isAbsolute(code.cli)) {
    throw new Problem('shell-route', 'The profile lacks absolute Node and CLI paths.');
  }
  if (!validCommand(code.command)) {
    throw new Problem('shell-command', 'The terminal command name is invalid.');
  }
  const route = [
    '/usr/bin/env -u NODE_OPTIONS -u NODE_PATH',
    quote(code.runtime, code.shell),
    quote(code.cli, code.shell),
    'run-profile --profile-id',
    quote(profile.id, code.shell),
    '--',
  ].join(' ');
  const lines = code.shell === 'fish'
  ? [`function ${code.command}`, `  ${route} $argv`, 'end']
  : [`${code.command}() {`, `  ${route} "$@"`, '}'];
  return Buffer.from(lines.join(eol) + eol);
}
export function editShell(bytes: Buffer, profile: Profile, remove = false): Buffer {
  const all = blocks(bytes);
  const block = all.find(value => value.id === profile.id);
  if (remove && !block) {
    return bytes;
  }
  const eol = bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  const separator = block?.separator ?? bytes.length > 0;
  const body = remove ? Buffer.alloc(0) : Buffer.concat([
    Buffer.from((separator ? eol : '') + `# bcm-profile ${profile.id} begin ${separator ? 1 : 0}` + eol),
    shellBody(profile, eol),
    Buffer.from(`# bcm-profile ${profile.id} end` + eol),
  ]);
  if (!remove && profile.code) {
    const command = profile.code.command.replace(/-/g, '\\-');
    const unmanaged = new RegExp(`(?:^|\\n)\\s*(?:function\\s+|alias\\s+)?${command}\\s*(?:\\(|=|\\s|$)`);
    const outside = block
    ? Buffer.concat([bytes.subarray(0, block.start), bytes.subarray(block.end)])
    : bytes;
    if (unmanaged.test(outside.toString('utf8'))) {
      throw new Problem('shell-shadow', 'The chosen terminal command has an unmanaged shell definition.');
    }
  }
  if (block) {
    return Buffer.concat([bytes.subarray(0, block.start), body, bytes.subarray(block.end)]);
  }
  return Buffer.concat([bytes, body]);
}
export function shellEntryFinding(profile: Profile, io: PrivateIO, sessionStart: number | null): string | null {
  if (!profile.code) {
    return null;
  }
  const data = io.read(profile.code.rc);
  if (!data) {
    return 'The recorded rc file is missing.';
  }
  const found = blocks(data.bytes).find(value => value.id === profile.id);
  const eol = data.bytes.includes(Buffer.from('\r\n')) ? '\r\n' : '\n';
  if (!found || !found.body.equals(shellBody(profile, eol))) {
    return 'The recorded rc entry is missing or does not route this UUID and command correctly.';
  }
  if (sessionStart === null) {
    return 'Session age is unknown; shell loading cannot be confirmed.';
  }
  if (sessionStart < Date.parse(profile.code.entryChangedAt)) {
    return `Reload ${profile.code.rc} or open another terminal; this session predates the managed entry.`;
  }
  return null;
}
export function stableNodePath(current: string, path: string): string {
  const target = realpathSync(current);
  const candidates = ['/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    ...path.split(':').map(p => join(p, 'node'))];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || candidate.includes('/Cellar/')) {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === target) {
        return candidate;
      }
    } catch {
      continue;
    }
  }
  if (current.includes('/Cellar/')) {
    throw new Problem('node-stability', 'No stable Node installation path is available for the shell entry.');
  }
  return current;
}
