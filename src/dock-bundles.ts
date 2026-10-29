import { accessSync, constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { PrivateIO } from './private-io.js';
import { uuid } from './profile-catalog.js';
import { shellQuote, Problem } from './outcomes.js';
import type { DesktopArtifacts } from './desktop-services.js';
export function appleString(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Problem('applescript-data', 'Launcher data contains unsupported control characters.');
  }
  const parts: string[] = [];
  let text = '';
  const flush = () => {
    if (text) {
      parts.push('"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
      text = '';
    }
  };
  for (const character of value) {
    if (character.codePointAt(0)! > 127) {
      flush();
      parts.push(`(character id ${character.codePointAt(0)!})`);
    } else {
      text += character;
    }
  }
  flush();
  return parts.length ? '(' + parts.join(' & ') + ')' : '""';
}
export function launcherIdentifier(profileId: string): string {
  if (!uuid(profileId)) {
    throw new Problem('launcher-id', 'A launcher requires a profile UUID.');
  }
  return 'io.github.lyhuuloi.ben-claude-multi.p' + profileId.replace(/-/g, '');
}
export function launcherSource(runtime: string, cli: string, profileId: string, catalog: string): string {
  launcherIdentifier(profileId);
  if (![runtime, cli, catalog].every(isAbsolute)) {
    throw new Problem('launcher-path', 'Launcher engine paths must be absolute.');
  }
  const check = `/usr/bin/test -x ${shellQuote(runtime)} && /usr/bin/test -f ${shellQuote(cli)}`;
  const command = ['/usr/bin/env -u NODE_OPTIONS -u NODE_PATH', runtime, cli, '_dock-entry', profileId, catalog]
  .map((value, index) => index ? shellQuote(value) : value).join(' ');
  return [
    'on run',
    '  try',
    `    do shell script ${appleString(check)}`,
    '  on error',
    '    display dialog "The profile engine is missing. Run ben-claude-multi doctor." '
    + 'buttons {"Close"} default button "Close"',
    '    return',
    '  end try',
    '  with timeout of 3600 seconds',
    '    try',
    `      do shell script ${appleString(command)}`,
    '    on error',
    '      return',
    '    end try',
    '  end timeout',
    'end run',
    '',
  ].join('\n');
}
function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
export async function compileLauncher(
  target: string, scratch: string, label: string, id: string, runtime: string, cli: string, catalog: string,
  io: PrivateIO, artifacts: DesktopArtifacts, sourcePrepared?: () => void,
): Promise<void> {
  accessSync(runtime, constants.X_OK);
  accessSync(cli, constants.R_OK);
  const source = join(scratch, 'launcher.applescript');
  io.write(source, launcherSource(runtime, cli, id, catalog), null);
  sourcePrepared?.();
  await artifacts.compile(source, target);
  io.guard.chain(target);
  io.guard.chain(join(target, 'Contents'));
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
  + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>'
  + `<key>CFBundleIdentifier</key><string>${launcherIdentifier(id)}</string>`
  + `<key>CFBundleName</key><string>${xml('Claude ' + label)}</string>`
  + `<key>CFBundleDisplayName</key><string>${xml('Claude ' + label)}</string>`
  + '<key>CFBundleExecutable</key><string>applet</string>'
  + '<key>CFBundlePackageType</key><string>APPL</string>'
  + '<key>CFBundleIconFile</key><string>applet</string>'
  + '<key>LSUIElement</key><false/></dict></plist>\n';
  const file = join(target, 'Contents/Info.plist');
  io.write(file, plist, io.snapshot(file));
}
