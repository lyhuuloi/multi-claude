import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { PrivateIO } from './private-io.js';
import type { Profile } from './profile-catalog.js';
import { launcherIdentifier, launcherSource } from './dock-bundles.js';
import type { HealthServices } from './health-services.js';
import { Problem } from './outcomes.js';
function literal(expression: string): string {
  let offset = 0;
  const space = () => {
    while (/\s/.test(expression[offset] ?? '') && offset < expression.length) {
      offset++;
    }
  };
  const term = (): string => {
    space();
    if (expression[offset] === '(') {
      offset++;
      const value = concatenate();
      space();
      if (expression[offset++] !== ')') {
        throw new Error('Unclosed expression');
      }
      return value;
    }
    if (expression[offset] === '"') {
      offset++;
      let result = '';
      while (offset < expression.length) {
        const character = expression[offset++]!;
        if (character === '"') {
          return result;
        }
        if (character === '\\') {
          const escaped = expression[offset++];
          if (escaped !== '\\' && escaped !== '"') {
            throw new Error('Unsupported escape');
          }
          result += escaped;
        } else {
          result += character;
        }
      }
      throw new Error('Unclosed string');
    }
    const codepoint = expression.slice(offset).match(/^character\s+id\s+(\d+)/i);
    if (!codepoint) {
      throw new Error('Not a constant expression');
    }
    offset += codepoint[0].length;
    const value = Number(codepoint[1]);
    if (value < 32 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      throw new Error('Invalid character');
    }
    return String.fromCodePoint(value);
  };
  const concatenate = (): string => {
    let result = term();
    space();
    while (expression[offset] === '&') {
      offset++;
      result += term();
      space();
    }
    return result;
  };
  const result = concatenate();
  space();
  if (offset !== expression.length) {
    throw new Error('Unexpected script expression');
  }
  return result;
}
function normalized(script: string): string {
  return script.split(/\r?\n/).map(line => {
    const command = line.match(/^\s*do shell script\s+(.+)\s*$/i);
    if (command) {
      return 'shell:' + JSON.stringify(literal(command[1]!));
    }
    let quoted = false;
    let escaped = false;
    let result = '';
    for (const character of line.trim()) {
      if (character === '"' && !escaped) {
        quoted = !quoted;
      }
      if (quoted || !/[\s()]/.test(character)) {
        result += character;
      }
      escaped = character === '\\' && !escaped;
    }
    return result;
  }).filter(Boolean).join('\n');
}
export function launcherRouteMatches(script: string, profile: Profile, catalog: string): boolean {
  try {
    const desktop = profile.desktop!;
    return normalized(script) === normalized(launcherSource(desktop.runtime!, desktop.cli!, profile.id, catalog));
  } catch {
    return false;
  }
}
export async function readPlist(
  path: string, io: PrivateIO, services: HealthServices,
): Promise<Record<string, unknown>> {
  const file = io.read(path);
  if (!file) {
    throw new Problem('plist-missing', 'Required application metadata is absent.');
  }
  const result = await services.tool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path]);
  io.assertImage(path, file.image);
  if (result.code !== 0) {
    throw new Problem('plist-unknown', 'Application metadata could not be decoded.');
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Problem('plist-shape', 'Application metadata is not a dictionary.');
  }
  return value as Record<string, unknown>;
}
export async function dockURLs(path: string, io: PrivateIO, services: HealthServices): Promise<string[]> {
  const file = io.read(path);
  if (!file) {
    throw new Problem('plist-missing', 'Dock pin metadata is absent.');
  }
  const extract = async (key: string) => {
    io.assertImage(path, file.image);
    const result = await services.tool('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path]);
    io.assertImage(path, file.image);
    return result;
  };
  const count = await extract('persistent-apps');
  const value = count.stdout.trim();
  if (count.code !== 0 || !/^\d+$/.test(value) || Number(value) > 500) {
    throw new Problem('dock-shape', 'Dock pin count is unsupported or exceeds the inspection limit.');
  }
  const urls: string[] = [];
  for (let index = 0; index < Number(value); index++) {
    const result = await extract(`persistent-apps.${index}.tile-data.file-data._CFURLString`);
    if (result.code === 1) {
      continue;
    }
    if (result.code !== 0) {
      throw new Problem('dock-unknown', 'A Dock pin URL could not be inspected.');
    }
    urls.push(result.stdout.replace(/\r?\n$/, ''));
  }
  return urls;
}
export async function launcherFinding(
  profile: Profile, catalog: string, io: PrivateIO, services: HealthServices,
): Promise<string | null> {
  const desktop = profile.desktop!;
  const plist = await readPlist(join(desktop.launcher, 'Contents/Info.plist'), io, services);
  if (plist.CFBundleIdentifier !== launcherIdentifier(profile.id) || plist.LSUIElement !== false
    || plist.CFBundleIconFile !== 'applet' || plist.CFBundleExecutable !== 'applet' || plist.CFBundleName !==
    'Claude ' + profile.label
    || plist.CFBundleDisplayName !== 'Claude ' + profile.label) {
    return 'Launcher metadata or stable bundle identity differs; run repair.';
  }
  const executable = join(desktop.launcher, 'Contents/MacOS/applet');
  io.read(executable);
  accessSync(executable, constants.X_OK);
  const script = join(desktop.launcher, 'Contents/Resources/Scripts/main.scpt');
  const before = io.read(script);
  if (!before) {
    return 'Launcher script is missing; run repair.';
  }
  const result = await services.tool('/usr/bin/osadecompile', [script]);
  io.assertImage(script, before.image);
  return result.code === 0 && launcherRouteMatches(result.stdout, profile, catalog) ? null
  : 'Launcher routing or synchronous waiting could not be verified; run repair.';
}
