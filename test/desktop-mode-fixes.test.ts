import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { requireIsolation } from './isolation.js';
import { Problem } from '../src/outcomes.js';
import { protectedPath } from '../src/location-guard.js';
import { PrivateIO, treeManifest, cleanSealedTree } from '../src/private-io.js';
import { launchdOverrideNames } from '../src/desktop-services.js';
import { launcherSource } from '../src/dock-bundles.js';
const testRoot = requireIsolation();
const kind = (expected: string) => (error: unknown) => error instanceof Problem && error.kind === expected;
function bundle() {
  const root = realpathSync(mkdtempSync(join(testRoot, 'bundle-')));
  const stage = join(root, 'stage');
  const helper = join(stage, 'Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS');
  mkdirSync(helper, { recursive: true, mode: 0o700 });
  writeFileSync(join(helper, 'Claude Helper (GPU)'), 'binary', { mode: 0o700 });
  writeFileSync(join(stage, 'Claude.app/Contents/Info.plist'), 'plist', { mode: 0o600 });
  return { stage, helper };
}
test('D001 a copied application whose helper bundles carry parentheses can be inventoried', () => {
  const { stage } = bundle();
  const manifest = treeManifest(stage, new PrivateIO());
  assert.ok(manifest.some(entry =>
    entry.name === 'Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)'
    && entry.kind === 'file' && entry.digest.length === 64));
});
test('D002 failed staging that holds such an application can be cleaned', () => {
  const { stage } = bundle();
  const io = new PrivateIO();
  cleanSealedTree(stage, treeManifest(stage, io), io);
  assert.equal(existsSync(stage), false);
});
test('D003 selected locations still refuse parentheses, and a tree root must be a protected location', () => {
  assert.throws(() => protectedPath('/private/tmp/a (b)'), kind('path-syntax'));
  const { helper } = bundle();
  assert.throws(() => treeManifest(helper, new PrivateIO()), kind('path-syntax'));
});
test('D004 a shared-writable directory inside such an application is still refused', () => {
  const { stage, helper } = bundle();
  chmodSync(helper, 0o777);
  assert.throws(() => treeManifest(stage, new PrivateIO()), kind('parent-writable'));
});
test('D005 launchd overrides are the names with a value, not every name launchctl answers for', async () => {
  const asked: string[] = [];
  const names = await launchdOverrideNames(async name => {
    asked.push(name);
    return { code: 0, stdout: name === 'GH_TOKEN' ? 'value\n' : '\n' };
  });
  assert.deepEqual(names, ['GH_TOKEN']);
  assert.equal(asked.length, 10);
  assert.deepEqual(await launchdOverrideNames(async () => ({ code: 0, stdout: '' })), []);
  assert.deepEqual(await launchdOverrideNames(async () => ({ code: 113, stdout: 'ignored' })), []);
});
test('D006 every system tool the launcher script calls exists on this host', () => {
  const source = launcherSource('/node/path', '/cli/main.js', '11111111-1111-4111-8111-111111111111', '/catalog.json');
  const tools = [...source.matchAll(/(?<![\w'\/])\/(?:usr\/)?bin\/[a-z]+/g)].map(match => match[0]);
  assert.ok(tools.length >= 2);
  assert.deepEqual(tools.filter(tool => !existsSync(tool)), []);
});
