import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-support.js';
function shortcutFixture() {
  const f = lifecycleFixture();
  const directory = join(f.home, 'Shared Applications');
  mkdirSync(directory, { mode: 0o700 });
  f.desktop.shortcutDirectory = directory;
  const [source, data, dock, icon, tint] = f.desktopAnswers;
  const add = (answer: string, label = 'studio') =>
    f.invoke(['add', label, '--target', 'desktop'], [source!, data!, dock!, icon!, tint!, answer, 'y']);
  const link = (label = 'studio') => join(directory, `Claude ${label}.app`);
  const linked = (label = 'studio') => lstatSync(link(label)).isSymbolicLink() && readlinkSync(link(label));
  return { ...f, directory, add, link, linked };
}
test('A001 the shortcut is opt-in: the default answer creates none and records none', async () => {
  const f = shortcutFixture();
  const result = await f.add('');
  assert.equal(result.code, 0, result.text);
  assert.equal(f.profile().desktop!.shortcut, undefined);
  assert.equal(existsSync(f.link()), false);
});
test('A002 a confirmed shortcut is a link to the launcher, recorded and shown by status', async () => {
  const f = shortcutFixture();
  const result = await f.add('y');
  assert.equal(result.code, 0, result.text);
  assert.equal(f.profile().desktop!.shortcut, f.link());
  assert.equal(f.linked(), f.profile().desktop!.launcher);
  assert.ok((await f.invoke(['status', 'studio'], null)).text.includes(`Shortcut: ${f.link()}`));
  const doctor = await f.invoke(['doctor'], null);
  assert.ok(doctor.text.includes('studio: shortcut links to the launcher.'), doctor.text);
});
test('A003 an occupied shortcut name is preserved and never fails the profile', async () => {
  const f = shortcutFixture();
  mkdirSync(f.link());
  writeFileSync(join(f.link(), 'keep'), 'foreign');
  const result = await f.add('y');
  assert.equal(result.code, 0, result.text);
  assert.ok(result.text.includes('Shortcut skipped'), result.text);
  assert.equal(existsSync(join(f.link(), 'keep')), true);
  const doctor = await f.invoke(['doctor'], null);
  assert.notEqual(doctor.code, 0);
  assert.ok(doctor.text.includes("is not this profile's link"), doctor.text);
  assert.equal((await f.invoke(['remove', 'studio'], ['y', 'y', 'y', 'y'])).code, 0);
  assert.equal(existsSync(join(f.link(), 'keep')), true);
});
test('A004 rename moves the shortcut with the launcher and remove deletes it', async () => {
  const f = shortcutFixture();
  assert.equal((await f.add('y')).code, 0);
  const renamed = await f.invoke(['rename', 'studio', 'work'], ['y']);
  assert.equal(renamed.code, 0, renamed.text);
  assert.equal(lstatSync(f.link(), { throwIfNoEntry: false }), undefined);
  assert.equal(f.profile('work').desktop!.shortcut, f.link('work'));
  assert.equal(f.linked('work'), f.profile('work').desktop!.launcher);
  const removed = await f.invoke(['remove', 'work'], ['y', 'y', 'y', 'y']);
  assert.equal(removed.code, 0, removed.text);
  assert.equal(lstatSync(f.link('work'), { throwIfNoEntry: false }), undefined);
});
test('A005 repair recreates a missing shortcut, adopts a matching link and drops it on request', async () => {
  const f = shortcutFixture();
  assert.equal((await f.add('')).code, 0);
  symlinkSync(f.profile().desktop!.launcher, f.link());
  const adopted = await f.invoke(['repair', 'studio', '--shortcut'], ['n']);
  assert.equal(adopted.code, 0, adopted.text);
  assert.equal(f.profile().desktop!.shortcut, f.link());
  assert.equal(f.linked(), f.profile().desktop!.launcher);
  unlinkSync(f.link());
  const doctor = await f.invoke(['doctor'], null);
  assert.ok(doctor.text.includes('is missing'), doctor.text);
  assert.equal((await f.invoke(['repair', 'studio'], ['n'])).code, 0);
  assert.equal(f.linked(), f.profile().desktop!.launcher);
  const dropped = await f.invoke(['repair', 'studio', '--no-shortcut'], ['n']);
  assert.equal(dropped.code, 0, dropped.text);
  assert.equal(f.profile().desktop!.shortcut, undefined);
  assert.equal(lstatSync(f.link(), { throwIfNoEntry: false }), undefined);
  assert.equal((await f.invoke(['repair', 'studio', '--shortcut', '--no-shortcut'], ['n'])).code, 64);
});
