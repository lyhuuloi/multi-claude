import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { healthFixture } from './health-support.js';
import { profileFixture } from './support.js';
import { CatalogSession } from '../src/profile-actions.js';
import { ChangeRecord } from '../src/change-records.js';
import { scratchIdentity, removeScratch } from '../scripts/scratch-directory.js';

for (const route of ['shell', 'launcher'] as const) {
  test(`S07 S49 recovery reports a restored ${route} route that bypasses current policy as incomplete`, async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const profile = f.profile();
    const path = route === 'shell' ? profile.code!.rc
      : join(profile.desktop!.launcher, 'Contents/Resources/Scripts/main.scpt');
    const valid = readFileSync(path, 'utf8');
    const bypass = route === 'shell' ? valid.replace('run-profile --profile-id', 'claude --config')
      : valid.replace('_dock-entry', 'open-profile');
    assert.notEqual(bypass, valid);
    f.put(path, bypass);
    const session = new CatalogSession(f.io, f.control);
    const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [path], session.inventory, profile.id);
    transaction.bind(profile, profile);
    transaction.write(path, valid);
    const id = transaction.directory.split('/').at(-1)!;
    const result = await f.invoke(['doctor', '--recover', id], ['y']);
    assert.notEqual(result.code, 0, result.text);
    assert.match(result.text, /Recovery is incomplete.*Run doctor --apply/);
    assert.equal(result.text.includes('Unfinished operation recovered'), false);
    assert.equal(readFileSync(path, 'utf8'), bypass);
  });
}

for (const kind of ['directory', 'link'] as const) {
  test(`S30 S72 scratch cleanup preserves a substituted ${kind} and warns`, () => {
    const f = profileFixture();
    const path = join(f.home, 'scratch');
    f.io.directory(path);
    const identity = scratchIdentity(path);
    renameSync(path, path + '-original');
    const target = kind === 'link' ? join(f.home, 'unrelated') : path;
    f.io.directory(target);
    f.io.write(join(target, 'sentinel'), 'keep', null);
    if (kind === 'link') {
      symlinkSync(target, path);
    }
    const warnings: string[] = [];
    removeScratch(path, identity, message => warnings.push(String(message)));
    assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'keep');
    assert.ok(existsSync(path + '-original'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /substituted.*untouched/);
  });
}

test('S30 scratch cleanup removes only its unchanged real directory', () => {
  const f = profileFixture();
  const path = join(f.home, 'scratch');
  f.io.directory(path);
  f.io.write(join(path, 'owned'), 'temporary', null);
  removeScratch(path, scratchIdentity(path), () => assert.fail('Unexpected cleanup warning'));
  assert.equal(existsSync(path), false);
});
