import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { requireIsolation } from './isolation.js';
import { PrivateIO } from '../src/private-io.js';
import { verifyClaude } from '../src/claude-authenticity.js';
import { productionDesktopArtifacts } from '../src/desktop-services.js';
import { compileLauncher, launcherIdentifier, appleString } from '../src/dock-bundles.js';
import { stableNodePath } from '../src/shell-entries.js';
import { execute, systemTools } from '../src/machine-services.js';
import { launcherRouteMatches } from '../src/launcher-review.js';
import type { Profile } from '../src/profile-catalog.js';
import { Problem } from '../src/outcomes.js';
const root = requireIsolation();
const io = new PrivateIO();
const storage = mkdtempSync(join(root, 'native-'));
const source = '/Applications/Claude.app';
const artifacts = productionDesktopArtifacts();
const allowed = new Set([
  '/usr/bin/codesign', '/bin/cp', '/usr/bin/ditto', '/usr/bin/plutil',
  '/usr/bin/osacompile', '/usr/bin/osadecompile', '/usr/bin/osascript',
]);
const blocked = (value: string) =>
/Operation not permitted|not allowed|sandbox|not available|not authorized/i.test(value);
let sourceAvailable = false;
let fresh: string | null = null;
async function checkedTool(file: string, args: readonly string[]) {
  assert.ok(allowed.has(file), 'Native evidence tools must not launch, quit or signal applications.');
  assert.equal(args.some(value => value.includes('runningApplicationWithProcessIdentifier')), false);
  const result = await execute(file, args, { timeout: 120000 });
  if (result.code !== 0 && blocked(result.stderr)) {
    throw new Problem('native-unavailable', 'The native capability is blocked by this sandbox.');
  }
  return result;
}
function unavailable(error: unknown): boolean {
  return error instanceof Problem && (error.kind === 'native-unavailable' || error.kind === 'tool-bound');
}
function checksum(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
test('T159 S01 S06 native source: deep strict verification of the pinned Claude identity', async context => {
  try {
    lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      context.skip('UNAVAILABLE: /Applications/Claude.app is absent; source signature is unverified.');
      return;
    }
    throw error;
  }
  try {
    const trust = await checkedTool('/usr/bin/codesign', ['--verify', '--strict', '/usr/bin/true']);
    if (trust.code !== 0 && /CSSMERR_TP_NOT_TRUSTED/.test(trust.stderr)) {
      context.skip('UNAVAILABLE: system signature trust is unavailable even for /usr/bin/true.');
      return;
    }
    assert.equal(trust.code, 0, 'The signature capability prerequisite failed.');
    await verifyClaude(source, true, io.guard, checkedTool);
    sourceAvailable = true;
  } catch (error) {
    if (unavailable(error)) {
      context.skip('UNAVAILABLE: native signature capability is blocked; source identity is unverified.');
      return;
    }
    throw error;
  }
});
test('T159 S03 S04 native fresh copy: private temporary storage and deep strict verification', async context => {
  if (!sourceAvailable) {
    context.skip('UNAVAILABLE: requires a verified source; no application was copied.');
    return;
  }
  const before = checksum(join(source, 'Contents/Info.plist'));
  const first = join(storage, 'clone');
  io.directory(first);
  const firstApp = join(first, 'Claude.app');
  let candidate = firstApp;
  try {
    await artifacts.copy(source, firstApp, true);
  } catch {
    const fallback = join(storage, 'fallback');
    io.directory(fallback);
    candidate = join(fallback, 'Claude.app');
    await artifacts.copy(source, candidate, false);
  }
  try {
    await verifyClaude(candidate, true, io.guard, checkedTool, true);
  } catch (error) {
    if (unavailable(error)) {
      context.skip('UNAVAILABLE: native fresh-copy signature capability is blocked.');
      fresh = null;
      return;
    }
    throw error;
  }
  assert.equal(lstatSync(candidate).uid, process.getuid!());
  assert.equal(checksum(join(source, 'Contents/Info.plist')), before);
  fresh = candidate;
});
test('T159 S04 S09 native tint: Finder metadata preserves the signed plist and deep pinned identity', async context => {
  if (!fresh) {
    context.skip('UNAVAILABLE: a verified temporary application copy is required for tint validation.');
    return;
  }
  try {
    const probe = await checkedTool(systemTools.osascript, [
      '-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); "ready"',
    ]);
    assert.equal(probe.code, 0, 'AppKit import failed; tint capability is not established.');
    const before = checksum(join(fresh, 'Contents/Info.plist'));
    await artifacts.tint(fresh, 'sky');
    assert.equal(checksum(join(fresh, 'Contents/Info.plist')), before);
    await verifyClaude(fresh, false, io.guard, checkedTool, true);
  } catch (error) {
    if (unavailable(error)) {
      context.skip('UNAVAILABLE: native icon metadata or signature capability is blocked.');
      return;
    }
    throw error;
  }
});
test('T088 T160 S07 native compiler: identifier, literal paths and synchronous routing', async context => {
  const scratch = join(storage, 'compiler');
  io.directory(scratch);
  const minimal = join(scratch, 'probe.applescript');
  io.write(minimal, 'on run\ndo shell script "/usr/bin/true"\nend run\n', null);
  try {
    const probe = await checkedTool(systemTools.osacompile, ['-o', join(scratch, 'Probe.app'), minimal]);
    if (probe.code !== 0 && /Expected end of line but found identifier/.test(probe.stderr)) {
      context.skip('UNAVAILABLE: the compiler cannot resolve Standard Additions do shell script.');
      return;
    }
    assert.equal(probe.code, 0, 'The native AppleScript compiler failed its minimal compilation.');
    const id = randomUUID();
    const runtime = stableNodePath(process.execPath, process.env.PATH ?? '');
    const cli = join(process.env.BCM_TEST_REPO!, 'dist/src/main.js');
    const catalog = join(scratch, 'curly “quotes” and apostrophe\' catalog.json');
    const target = join(scratch, 'Launcher.app');
    await compileLauncher(target, scratch, 'Native profile', id, runtime, cli, catalog, io, artifacts);
    const script = await checkedTool(systemTools.osadecompile, [join(target, 'Contents/Resources/Scripts/main.scpt')]);
    assert.equal(script.code, 0);
    const route = { id, desktop: { runtime, cli } } as Profile;
    assert.ok(launcherRouteMatches(script.stdout, route, catalog), 'Doctor must recognize the decompiled route.');
    assert.match(script.stdout, /_dock-entry/);
    assert.match(script.stdout, /do shell script/);
    assert.match(script.stdout, /NODE_OPTIONS -u NODE_PATH/);
    assert.equal(script.stdout.includes('/usr/bin/open'), false);
    const plist = await checkedTool('/usr/bin/plutil', [
      '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(target, 'Contents/Info.plist'),
    ]);
    assert.equal(plist.stdout.trim(), launcherIdentifier(id));
    const literal = await checkedTool(systemTools.osascript, ['-e', 'return ' + appleString(catalog)]);
    assert.equal(literal.code, 0);
    assert.equal(literal.stdout.trim(), catalog);
  } catch (error) {
    if (unavailable(error)) {
      context.skip('UNAVAILABLE: native AppleScript compilation or inspection is blocked.');
      return;
    }
    throw error;
  }
});
for (const claim of [
  'T160 attended Dock waiting, focus and running tile behavior',
  'T161 effective Read, Grep and Glob permission enforcement',
  'T162 live-session permission reload and later settings writes',
]) {
  test(`T163 ${claim}`, {
    skip: 'UNAVAILABLE: attended application behavior requires a disposable account and explicit selection.',
  }, () => {});
}
