import { approveTree } from '../src/approved-tree.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, lstatSync, renameSync, symlinkSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lifecycleFixture } from './lifecycle-support.js';
import { catalog, installProfile, save } from './support.js';
import { policyView } from '../src/desktop-policy.js';
import { CatalogSession } from '../src/profile-actions.js';
import { ChangeRecord } from '../src/change-records.js';
import { LeaseManager } from '../src/operation-leases.js';
import { Problem } from '../src/outcomes.js';
import { connectorInventory, mergeConnectors } from '../src/desktop-transfer.js';
import { auditFences } from '../src/read-fences.js';
const contents = (path: string) => readFileSync(path, 'utf8');
test('T138 S37 S49 paired setup plans both surfaces and publishes only completed resources', async () => {
  const f = lifecycleFixture();
  f.services.checkpoint = stage => {
    if (stage === 'add-shell' || stage === 'add-fences') {
      assert.equal(catalog(f).profiles.length, 0);
    }
  };
  const result = await f.addPaired();
  assert.equal(result.code, 0, result.text);
  const profile = f.profile();
  assert.ok(profile.code && profile.desktop);
  assert.equal(profile.rootEvidence.length, 5);
  assert.ok(existsSync(profile.desktop.launcher));
  assert.equal(policyView(profile, f.io).effective, 'blocked');
  assert.deepEqual(auditFences(catalog(f), f.control, f.io), []);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
  assert.equal(f.calls.some(call => call.kind === 'open'), false);
});
test('T138 S48 failed Code preparation leaves a completed Desktop-only registration', async () => {
  const f = lifecycleFixture();
  f.services.checkpoint = stage => {
    if (stage === 'add-staged') {
      throw new Error('injected Code failure');
    }
  };
  const result = await f.addPaired();
  assert.equal(result.code, 2, result.text);
  assert.equal(f.profile().code, null);
  assert.ok(f.profile().desktop);
  assert.equal(existsSync(join(f.data, 'studio/code')), false);
  assert.match(result.text, /resume with add studio --target terminal/);
});
test('T138 S31 failed Desktop preparation registers completed Code without a launcher claim', async () => {
  const f = lifecycleFixture();
  f.desktop.compile = async () => {
    throw new Error('injected compiler failure');
  };
  const result = await f.addPaired();
  assert.equal(result.code, 2, result.text);
  assert.ok(f.profile().code);
  assert.equal(f.profile().desktop, null);
  assert.equal(existsSync(join(f.data, 'studio/desktop')), false);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T139 S28 neither surface completing leaves no registration or unchanged attempt data', async () => {
  const f = lifecycleFixture();
  f.services.checkpoint = stage => {
    if (stage === 'add-staged') {
      throw new Error('Code failure');
    }
  };
  f.desktop.copy = async () => {
    throw new Problem('copy-command', 'copy failure');
  };
  const result = await f.addPaired();
  assert.notEqual(result.code, 0);
  assert.equal(catalog(f).profiles.length, 0);
  assert.equal(existsSync(join(f.data, 'studio/code')), false);
  assert.equal(existsSync(join(f.data, 'studio/desktop')), false);
  assert.equal(contents(join(f.source, 'Contents/Info.plist')), '4.29.0');
});
test('T140 S49 missing-surface linking preserves UUID and existing chats in both directions', async () => {
  for (const codeFirst of [true, false]) {
    const f = lifecycleFixture();
    const first = codeFirst
    ? await f.invoke(['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'y'])
    : await f.addDesktop();
    assert.equal(first.code, 0, first.text);
    const before = f.profile();
    const oldRoot = before.code?.location ?? before.desktop!.location;
    f.put(join(oldRoot, 'chat-canary'), 'preserve');
    const second = await f.invoke(['add', 'studio', '--target', codeFirst ? 'desktop' : 'terminal'],
      codeFirst ? [...f.desktopAnswers, 'y'] : ['', '', '', '', '', 'y']);
    assert.equal(second.code, 0, second.text);
    assert.equal(f.profile().id, before.id);
    assert.ok(f.profile().code && f.profile().desktop);
    assert.equal(contents(join(oldRoot, 'chat-canary')), 'preserve');
    assert.equal((await f.invoke(['open-profile', 'studio'], null)).code, 0);
    assert.ok(f.calls.at(-1)!.value.includes('CLAUDE_CONFIG_DIR='));
  }
});
test('T140 S50 adding GitHub to a paired profile updates dynamic Desktop selection', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  f.services.executables = name => name === 'gh' ? ['/fixture/gh'] : ['/fixture/claude'];
  const result = await f.invoke(['add', 'studio', '--target', 'terminal'], ['y', 'y']);
  assert.equal(result.code, 0, result.text);
  assert.equal((await f.invoke(['open-profile', 'studio'], null)).code, 0);
  assert.ok(f.calls.at(-1)!.value.includes('GH_CONFIG_DIR='));
  assert.match(result.text, /insecure-storage/);
  assert.match(result.text, /Reopen existing Desktop sessions/);
});
test('T138 S25 repeated paired setup preserves completed surfaces without rewriting the catalog', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const before = contents(join(f.control, 'catalog.json'));
  const result = await f.invoke(['add', 'studio', '--target', 'paired']);
  assert.equal(result.code, 0, result.text);
  assert.equal(contents(join(f.control, 'catalog.json')), before);
});
test('T132 S64 policy creation uses an owned absent root with digests and a UUID entry', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const view = policyView(f.profile(), f.io);
  assert.equal(view.kind, 'owned');
  assert.ok(view.receipt?.entry);
  const entry = JSON.parse(contents(join(view.location, 'configLibrary', view.receipt!.entry)));
  assert.equal(entry.disableAutoUpdates, true);
  const metadata = JSON.parse(contents(join(view.location, 'configLibrary/_meta.json')));
  assert.equal(metadata.appliedId, view.receipt!.entry);
  assert.equal(metadata.entries[0].id, metadata.appliedId);
  const before = contents(join(f.control, 'catalog.json'));
  assert.equal((await f.invoke(['desktop-updates', 'studio', 'launcher'])).code, 0);
  assert.equal(contents(join(f.control, 'catalog.json')), before);
});
for (const member of ['configLibrary/_meta.json', 'entry', '.bcm-policy.json']) {
  test(`T134 T136 S64 S65 changed ${member} preserves the entire policy family and preference`, async () => {
    const f = lifecycleFixture();
    assert.equal((await f.addDesktop()).code, 0);
    const view = policyView(f.profile(), f.io);
    const path = join(view.location, member === 'entry' ? 'configLibrary/' + view.receipt!.entry : member);
    f.put(path, '{}');
    const snapshots = readdirSync(join(view.location, 'configLibrary')).map(name =>
      [name, contents(join(view.location, 'configLibrary', name))]);
    const result = await f.invoke(['desktop-updates', 'studio', 'application'], ['y']);
    assert.equal(result.code, 73, result.text);
    assert.equal(f.profile().desktop!.updateMode, 'launcher');
    assert.deepEqual(readdirSync(join(view.location, 'configLibrary')).map(name =>
      [name, contents(join(view.location, 'configLibrary', name))]), snapshots);
    assert.equal(contents(path), '{}');
  });
}
test('T133 T137 S64 foreign policy is never edited and is reported in both update modes', async () => {
  const f = lifecycleFixture();
  const policy = join(f.data, 'studio/desktop-3p/configLibrary');
  const id = randomUUID();
  f.put(join(policy, '_meta.json'), JSON.stringify({ appliedId: id, entries: [{ id, name: 'External' }] }));
  f.put(join(policy, id), JSON.stringify({ disableAutoUpdates: false }));
  const before = contents(join(policy, '_meta.json'));
  const result = await f.addDesktop();
  assert.equal(result.code, 2, result.text);
  assert.equal(contents(join(policy, '_meta.json')), before);
  assert.equal(existsSync(join(dirname(policy), '.bcm-policy.json')), false);
  assert.equal((await f.invoke(['desktop-updates', 'studio'])).code, 2);
  const value = catalog(f);
  value.profiles[0]!.desktop!.updateMode = 'application';
  save(f, value);
  assert.equal((await f.invoke(['desktop-updates', 'studio'])).code, 2);
  assert.equal(contents(join(policy, '_meta.json')), before);
});
test('T132 T136 S65 successful policy changes precede preference commit and retain no backups', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const off = await f.invoke(['desktop-updates', 'studio', 'application'], ['y']);
  assert.equal(off.code, 0, off.text);
  assert.equal(f.profile().desktop!.updateMode, 'application');
  assert.equal(existsSync(f.profile().desktop!.location + '-3p'), false);
  const on = await f.invoke(['desktop-updates', 'studio', 'launcher']);
  assert.equal(on.code, 0, on.text);
  assert.equal(policyView(f.profile(), f.io).effective, 'blocked');
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T141 T124 S24 S58 S63 paired rename stages first, preserves identities and protects siblings', async () => {
  const f = lifecycleFixture();
  const sibling = installProfile(f, 'sibling');
  assert.equal((await f.addPaired()).code, 0);
  const before = f.profile();
  const launcherInode = lstatSync(before.desktop!.launcher).ino;
  f.put(join(before.desktop!.location, 'chats'), 'keep chats');
  f.put(join(before.code!.location, 'settings.json'), JSON.stringify({
    hooks: { command: before.code!.location + '/hook' }, claudeMdExcludes: [before.code!.location],
  }));
  f.services.checkpoint = stage => {
    if (stage === 'rename-staged') {
      assert.equal(catalog(f).profiles.find(profile => profile.id === before.id)!.label, 'studio');
      assert.ok(existsSync(before.desktop!.location));
      assert.ok(existsSync(before.code!.location));
    }
  };
  const result = await f.invoke(['rename', 'studio', 'work'], ['y']);
  assert.equal(result.code, 0, result.text);
  const after = f.profile('work');
  assert.equal(after.id, before.id);
  assert.equal(lstatSync(after.desktop!.launcher).ino, launcherInode);
  assert.equal(contents(join(after.desktop!.location, 'chats')), 'keep chats');
  assert.equal(after.rootEvidence.find(root => root.role === 'copy')!.location,
    before.rootEvidence.find(root => root.role === 'copy')!.location);
  assert.equal(policyView(after, f.io).kind, 'owned');
  const settings = JSON.parse(contents(join(after.code!.location, 'settings.json')));
  assert.equal(settings.hooks.command, after.code!.location + '/hook');
  assert.deepEqual(settings.claudeMdExcludes, [before.code!.location]);
  assert.ok(contents(join(sibling.code!.location, 'settings.json')).includes(after.desktop!.location));
  assert.match(result.text, /Restart.*Code sessions/);
  assert.equal(catalog(f).releasedLocations.filter(record => record.formerProfileId === before.id).length, 3);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
for (const stage of ['rename-staged', 'rename-moved-code', 'rename-moved-desktop', 'rename-moved-policy',
  'rename-moved-launcher', 'rename-shell', 'rename-launcher', 'rename-fences']) {
  test(`T142 S27 S28 S31 paired rename failure at ${stage} rolls back only operation-owned results`, async () => {
    const f = lifecycleFixture();
    assert.equal((await f.addPaired()).code, 0);
    const before = f.profile();
    const identities = before.rootEvidence.map(root => [root.location, lstatSync(root.location).ino]);
    f.services.checkpoint = observed => {
      if (observed === stage) {
        throw new Error('injected rename failure');
      }
    };
    const result = await f.invoke(['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, 1, result.text);
    assert.equal(f.profile().id, before.id);
    for (const [path, inode] of identities) {
      assert.equal(lstatSync(path as string).ino, inode);
    }
    assert.equal(existsSync(join(f.data, 'work/desktop')), false);
    assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
  });
}
test('T141 S20 policy and launcher destinations are checked before compilation or any move', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const before = f.profile();
  f.put(join(f.data, 'work/desktop-3p/foreign'), 'preserve');
  let compiled = false;
  f.desktop.compile = async () => {
    compiled = true;
  };
  const result = await f.invoke(['rename', 'studio', 'work'], ['y']);
  assert.equal(result.code, 73, result.text);
  assert.equal(compiled, false);
  assert.ok(existsSync(before.code!.location));
  assert.ok(existsSync(before.desktop!.location));
});
test('T141 S64 rename refuses unverified policy migration before changing any root', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const view = policyView(f.profile(), f.io);
  f.put(join(view.location, 'configLibrary/_meta.json'), '{}');
  const result = await f.invoke(['rename', 'studio', 'work'], ['y']);
  assert.equal(result.code, 73, result.text);
  assert.equal(f.profile().label, 'studio');
  assert.ok(existsSync(f.profile().code!.location));
});
test('T143 T145 S24 S59 ordinary Desktop removal keeps data and policy, unregisters both app paths', async () => {
  const f = lifecycleFixture();
  const sibling = installProfile(f, 'sibling');
  assert.equal((await f.addPaired()).code, 0);
  const profile = f.profile();
  const application = f.application();
  f.put(join(profile.desktop!.location, 'chats'), 'keep');
  const policy = contents(join(profile.desktop!.location + '-3p', '.bcm-policy.json'));
  const result = await f.invoke(['remove', 'studio'], ['', '', 'y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(catalog(f).profiles.some(value => value.id === profile.id), false);
  assert.equal(contents(join(profile.desktop!.location, 'chats')), 'keep');
  assert.ok(existsSync(profile.code!.location));
  assert.equal(contents(join(profile.desktop!.location + '-3p', '.bcm-policy.json')), policy);
  assert.equal(existsSync(application), false);
  assert.equal(existsSync(profile.desktop!.launcher), false);
  assert.deepEqual(f.calls.filter(call => call.kind === 'unregister').map(call => call.value).sort(),
    [application, profile.desktop!.launcher].sort());
  assert.equal(catalog(f).releasedLocations.filter(record => record.formerProfileId === profile.id).length, 3);
  assert.ok(contents(join(sibling.code!.location, 'settings.json')).includes(profile.desktop!.location));
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T143 S24 approved Desktop deletion removes owned policy but preserves unrelated policy files', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const view = policyView(profile, f.io);
  f.put(join(view.location, 'third-party-data'), 'keep credentials');
  const result = await f.invoke(['remove', 'studio'], ['y', 'y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(existsSync(profile.desktop!.location), false);
  assert.equal(contents(join(view.location, 'third-party-data')), 'keep credentials');
  assert.equal(existsSync(join(view.location, '.bcm-policy.json')), false);
  assert.equal(existsSync(join(view.location, 'configLibrary', view.receipt!.entry)), false);
  assert.ok(catalog(f).releasedLocations.some(record => record.location === view.location && record.reason === 'kept'));
});
test('T028 S24 removal rechecks Desktop identity immediately before staging deletion', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  f.services.checkpoint = stage => {
    if (stage === 'remove-before-desktop') {
      renameSync(profile.desktop!.location, profile.desktop!.location + '-original');
      f.put(join(profile.desktop!.location, 'foreign'), 'preserve');
    }
  };
  const result = await f.invoke(['remove', 'studio'], ['y', 'y']);
  assert.equal(result.code, 73, result.text);
  assert.equal(contents(join(profile.desktop!.location, 'foreign')), 'preserve');
  assert.equal(f.profile().id, profile.id);
  assert.ok(existsSync(f.application()));
});
test('T028 S26 substituted Desktop links only receive separate unlink-only consent', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const location = profile.desktop!.location;
  renameSync(location, location + '-original');
  symlinkSync(location + '-original', location);
  const refusal = await f.invoke(['remove', 'studio'], ['']);
  assert.equal(refusal.code, 0);
  assert.ok(lstatSync(location).isSymbolicLink());
  const accepted = await f.invoke(['remove', 'studio'], ['y']);
  assert.equal(accepted.code, 0, accepted.text);
  assert.equal(existsSync(location), false);
  assert.ok(existsSync(location + '-original'));
  assert.equal(f.profile().id, profile.id);
  assert.ok(existsSync(profile.desktop!.launcher));
});
test('T097 T099 S25 foreign launchers are preserved while repair creates another verified route', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const original = f.profile().desktop!.launcher;
  renameSync(original, original + '-owned');
  f.put(join(original, 'Contents/Info.plist'), 'foreign plist');
  const result = await f.invoke(['repair', 'studio'], ['']);
  assert.equal(result.code, 0, result.text);
  assert.equal(contents(join(original, 'Contents/Info.plist')), 'foreign plist');
  assert.notEqual(f.profile().desktop!.launcher, original);
  assert.ok(f.calls.some(call => call.kind === 'register' && call.value === f.profile().desktop!.launcher));
  assert.equal(f.calls.some(call => call.kind === 'register' && call.value === original), false);
});
test('T098 T099 S07 S31 in-place repair preserves launcher inode and UUID and requires Dock consent', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const inode = lstatSync(profile.desktop!.launcher).ino;
  for (const answers of [[''], ['y']]) {
    const result = await f.invoke(['repair', 'studio'], answers);
    assert.equal(result.code, 0, result.text);
    assert.equal(lstatSync(f.profile().desktop!.launcher).ino, inode);
    assert.ok(contents(join(profile.desktop!.launcher, 'Contents/Info.plist'))
      .includes(profile.id.replaceAll('-', '')));
    assert.match(contents(join(profile.desktop!.launcher, 'Contents/Resources/Scripts/main.scpt')), /_dock-entry/);
  }
  assert.equal(f.calls.filter(call => call.kind === 'dock-refresh').length, 1);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T044 T045 T042 S38 S39 Dock clicks respect lifecycle gates and current UUID state', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const id = f.profile().id;
  const file = join(f.control, 'catalog.json');
  let blocked = 0;
  f.services.checkpoint = async stage => {
    if (stage === 'rename-staged' || stage === 'remove-staged') {
      const click = await f.invoke(['_dock-entry', id, file], null);
      assert.equal(click.code, 73, click.text);
      blocked++;
    }
  };
  const renamed = await f.invoke(['rename', 'studio', 'work'], ['y']);
  assert.equal(renamed.code, 0, renamed.text);
  assert.equal((await f.invoke(['_dock-entry', id, file], null)).code, 0);
  assert.ok(f.calls.at(-1)!.value.includes(f.profile('work').desktop!.location));
  const removed = await f.invoke(['remove', 'work'], ['', 'y']);
  assert.equal(removed.code, 0, removed.text);
  assert.equal(blocked, 2);
  const opens = f.calls.filter(call => call.kind === 'open').length;
  assert.equal((await f.invoke(['_dock-entry', id, file], null)).code, 73);
  assert.equal(f.calls.filter(call => call.kind === 'open').length, opens);
});
function extension(f: ReturnType<typeof lifecycleFixture>, root: string, id: string, value: string): void {
  f.put(join(root, 'Claude Extensions', id, 'manifest.json'), JSON.stringify({
    manifest_version: '0.3', name: id, version: '1.0.0-beta.1',
  }));
  f.put(join(root, 'Claude Extensions', id, 'content.txt'), value);
  f.put(join(root, 'Claude Extensions Settings', id + '.json'), JSON.stringify({ value }));
}
test('T115 S66 copy-setup selects nothing by default even with replacement permission', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  extension(f, f.profile('source').desktop!.location, 'safe.extension', 'credential-sentinel');
  const target = f.profile('target');
  const before = contents(join(f.control, 'catalog.json'));
  const result = await f.invoke(['copy-setup', 'source', 'target', '--replace-selected'], ['', '']);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /credentials/);
  assert.equal(result.text.includes('credential-sentinel'), false);
  assert.equal(existsSync(join(target.desktop!.location, 'Claude Extensions')), false);
  assert.equal(contents(join(f.control, 'catalog.json')), before);
});
test('T116 T118 S66 selected extensions and additive connectors preserve unrelated target configuration', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  const source = f.profile('source').desktop!.location;
  const target = f.profile('target').desktop!.location;
  extension(f, source, 'safe.extension', 'new');
  f.put(join(source, 'claude_desktop_config.json'), JSON.stringify({
    mcpServers: { keep: { command: 'source-keep' }, new: { command: 'source-new' } }, unrelated: 'do not copy',
  }));
  f.put(join(target, 'claude_desktop_config.json'), JSON.stringify({
    mcpServers: { keep: { command: 'target-keep' } }, targetOnly: true,
  }));
  const result = await f.invoke(['copy-setup', 'source', 'target'], ['1', '1,2']);
  assert.equal(result.code, 0, result.text);
  assert.equal(contents(join(target, 'Claude Extensions/safe.extension/content.txt')), 'new');
  const document = JSON.parse(contents(join(target, 'claude_desktop_config.json')));
  assert.equal(document.mcpServers.keep.command, 'target-keep');
  assert.equal(document.mcpServers.new.command, 'source-new');
  assert.equal(document.targetOnly, true);
  assert.equal(Object.hasOwn(document, 'unrelated'), false);
  assert.match(result.text, /Restart the target Desktop/);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T117 S28 S31 extension and settings replacement roll back together after a failed swap', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  const source = f.profile('source').desktop!.location;
  const target = f.profile('target').desktop!.location;
  extension(f, source, 'safe.extension', 'new');
  extension(f, target, 'safe.extension', 'old');
  f.services.checkpoint = stage => {
    if (stage === 'transfer-extension-installed') {
      throw new Error('injected pair failure');
    }
  };
  const result = await f.invoke(['copy-setup', 'source', 'target', '--replace-selected'], ['1', '']);
  assert.equal(result.code, 2, result.text);
  assert.equal(contents(join(target, 'Claude Extensions/safe.extension/content.txt')), 'old');
  assert.deepEqual(JSON.parse(contents(join(target, 'Claude Extensions Settings/safe.extension.json'))),
    { value: 'old' });
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T116 T119 S11 malformed manifests and linked configuration never replace target bytes', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  const source = f.profile('source').desktop!.location;
  const target = f.profile('target').desktop!.location;
  extension(f, source, 'safe.extension', 'new');
  extension(f, target, 'safe.extension', 'old');
  f.put(join(source, 'Claude Extensions/safe.extension/manifest.json'), '{}');
  const malformed = await f.invoke(['copy-setup', 'source', 'target', '--replace-selected'], ['1', '']);
  assert.equal(malformed.code, 2, malformed.text);
  assert.equal(contents(join(target, 'Claude Extensions/safe.extension/content.txt')), 'old');
  f.put(join(source, 'claude_desktop_config.json'), '{"mcpServers":{"new":{"command":"fixture"}}}');
  const path = join(target, 'claude_desktop_config.json');
  const untouched = join(f.home, 'untouched.json');
  f.put(untouched, '{"unrelated":true}');
  symlinkSync(untouched, path);
  const linked = await f.invoke(['copy-setup', 'source', 'target'], ['', '1']);
  assert.equal(linked.code, 2, linked.text);
  assert.ok(lstatSync(path).isSymbolicLink());
  assert.equal(contents(untouched), '{"unrelated":true}');
});
test('T068 S43 target process appearance after transfer staging blocks installation', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop('source')).code, 0);
  assert.equal((await f.addDesktop('target')).code, 0);
  const source = f.profile('source').desktop!.location;
  const target = f.profile('target');
  extension(f, source, 'safe.extension', 'new');
  f.services.checkpoint = stage => {
    if (stage === 'transfer-staged') {
      const application = f.application('target');
      f.setProcesses([{
        pid: 112, uid: f.io.guard.uid, start: 'fixture-start', executable: join(application, 'Contents/MacOS/Claude'),
        bundle: application, bundleId: 'com.anthropic.claudefordesktop',
        data: target.desktop!.location, uncertain: false,
      }]);
    }
  };
  const result = await f.invoke(['copy-setup', 'source', 'target'], ['1', '']);
  assert.equal(result.code, 2, result.text);
  assert.equal(existsSync(join(target.desktop!.location, 'Claude Extensions/safe.extension')), false);
});
test('T042 S38 repair uses the same profile mutex as the Dock helper', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const manager = new LeaseManager(join(f.control, 'leases'), f.io, f.services.identities);
  const gate = await manager.acquire('registry');
  const profile = await manager.acquire(`profile-${f.profile().id}`);
  gate.release();
  try {
    const result = await f.invoke(['repair', 'studio']);
    assert.equal(result.code, 73, result.text);
    assert.equal(f.calls.some(call => call.kind === 'register'), false);
  } finally {
    profile.release();
  }
});
test('T058 T060 S27 S31 confirmed recovery restores owned bytes and reapplies mandatory read rules', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const profile = f.profile();
  const path = join(profile.code!.location, 'settings.json');
  const before = contents(path);
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [path], session.inventory, profile.id);
  transaction.bind(profile, profile);
  transaction.write(path, '{}');
  const result = await f.invoke(['doctor', '--recover', transaction.directory.split('/').at(-1)!], ['y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(contents(path), before);
  assert.deepEqual(auditFences(catalog(f), f.control, f.io), []);
  assert.equal(existsSync(transaction.directory), false);
});
test('T058 S29 recovery refuses tampered pre-images and preserves the current produced file', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const profile = f.profile();
  const path = join(profile.code!.location, 'user-file');
  f.put(path, 'original');
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [path], session.inventory, profile.id);
  transaction.bind(profile, profile);
  transaction.write(path, 'produced');
  const prior = readdirSync(transaction.directory).find(name => name.startsWith('prior-'))!;
  f.put(join(transaction.directory, prior), 'tampered');
  const result = await f.invoke(['doctor', '--recover', transaction.directory.split('/').at(-1)!], ['y']);
  assert.equal(result.code, 74, result.text);
  assert.equal(contents(path), 'produced');
  assert.ok(existsSync(transaction.directory));
});
test('T059 S24 removed registrations are never recreated from former operation records', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory, profile.id);
  transaction.bind(profile, profile);
  const next = structuredClone(session.catalog);
  next.profiles = [];
  session.commit(next);
  const result = await f.invoke(['doctor', '--recover', transaction.directory.split('/').at(-1)!], ['y']);
  assert.equal(result.code, 74, result.text);
  assert.equal(catalog(f).profiles.length, 0);
});
test('T135 S28 interrupted owned policy creation can be recovered without adopting foreign files', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  assert.equal((await f.invoke(['desktop-updates', 'studio', 'application'], ['y'])).code, 0);
  f.services.checkpoint = stage => {
    if (stage === 'policy-written') {
      throw new Error('interrupted policy change');
    }
  };
  const result = await f.invoke(['desktop-updates', 'studio', 'launcher']);
  assert.equal(result.code, 1, result.text);
  assert.equal(f.profile().desktop!.updateMode, 'application');
  assert.equal(existsSync(f.profile().desktop!.location + '-3p'), false);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T054 S11 S29 an in-place launcher root substitution blocks rollback traversal', async () => {
  let substitute = false;
  let launcher = '';
  let replaced = false;
  const hooks = {
    beforeRename: (path: string) => {
      if (substitute && !replaced && path === join(launcher, 'Contents/Info.plist')) {
        replaced = true;
        renameSync(launcher, launcher + '-original');
        f.put(join(launcher, 'Contents/Info.plist'), 'foreign canary');
      }
    },
  };
  const f = lifecycleFixture(hooks);
  assert.equal((await f.addDesktop()).code, 0);
  launcher = f.profile().desktop!.launcher;
  substitute = true;
  const result = await f.invoke(['repair', 'studio'], ['']);
  assert.equal(result.code, 74, result.text);
  assert.equal(replaced, true);
  assert.equal(contents(join(launcher, 'Contents/Info.plist')), 'foreign canary');
  assert.ok(existsSync(launcher + '-original'));
  assert.ok(catalog(f).recoveryClaims.length);
});
test('T058 S27 restoration targets outside the bound profile cannot be introduced through stored scope', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addPaired()).code, 0);
  const sibling = installProfile(f, 'sibling');
  const untouched = join(sibling.code!.location, 'user-file');
  f.put(untouched, 'sibling canary');
  const profile = f.profile();
  const path = join(profile.code!.location, 'user-file');
  f.put(path, 'original');
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [path], session.inventory, profile.id);
  transaction.bind(profile, profile);
  transaction.write(path, 'produced');
  const file = join(transaction.directory, 'operation.json');
  const value = JSON.parse(contents(file));
  value.files[0].path = untouched;
  value.scope.push(untouched);
  f.put(file, JSON.stringify(value));
  const result = await f.invoke(['doctor', '--recover', value.id], ['y']);
  assert.equal(result.code, 74, result.text);
  assert.equal(contents(untouched), 'sibling canary');
  assert.equal(contents(path), 'produced');
});
for (const foreign of [false, true]) {
  test(`T057 S30 S31 partial cleanup ${foreign ? 'preserves new material' : 'resumes proved remaining entries'}`,
    async () => {
      const f = lifecycleFixture();
      assert.equal((await f.addDesktop()).code, 0);
      const profile = f.profile();
      const session = new CatalogSession(f.io, f.control);
      const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory, profile.id);
      transaction.bind(profile, profile);
      const stage = join(transaction.directory, 'stage');
      transaction.allow(stage);
      transaction.createStaging(stage);
      f.put(join(stage, 'one'), 'one');
      f.put(join(stage, 'two'), 'two');
      transaction.sealStaging(stage);
      const discarded = join(transaction.directory, 'discarded');
      transaction.allow(discarded);
      transaction.moveTree(stage, discarded, true);
      const path = join(transaction.directory, 'operation.json');
      const record = JSON.parse(contents(path));
      record.phase = 'complete';
      f.put(path, JSON.stringify(record));
      unlinkSync(join(discarded, 'one'));
      if (foreign) {
        f.put(join(discarded, 'foreign'), 'preserve');
      }
      const result = await f.invoke(['doctor', '--recover', record.id], ['y']);
      assert.equal(result.code, foreign ? 74 : 0, result.text);
      if (foreign) {
        assert.equal(contents(join(discarded, 'foreign')), 'preserve');
        assert.equal(contents(join(discarded, 'two')), 'two');
      } else {
        assert.equal(existsSync(transaction.directory), false);
      }
    });
}
test('T098 S09 Finder Icon CR metadata is copied during owned in-place launcher repair', async () => {
  const f = lifecycleFixture();
  f.desktop.icon = async (_application, launcher) => {
    f.put(join(launcher, 'Icon\r'), 'custom icon fixture');
  };
  const result = await f.invoke(['add', 'studio', '--target', 'desktop'], [f.source, '', '', 'y', 'sky', 'y']);
  assert.equal(result.code, 0, result.text);
  const launcher = f.profile().desktop!.launcher;
  const inode = lstatSync(launcher).ino;
  const repaired = await f.invoke(['repair', 'studio'], ['']);
  assert.equal(repaired.code, 0, repaired.text);
  assert.equal(lstatSync(launcher).ino, inode);
  assert.equal(contents(join(launcher, 'Icon\r')), 'custom icon fixture');
});
test('S67 T033 retired Desktop reuse requires its own default-No exact-path consent', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const location = f.profile().desktop!.location;
  f.put(join(location, 'chat'), 'kept');
  assert.equal((await f.invoke(['remove', 'studio'], ['', 'y'])).code, 0);
  const refused = await f.invoke(['add', 'studio', '--target', 'desktop'], [...f.desktopAnswers, 'y', '']);
  assert.equal(refused.code, 0, refused.text);
  assert.equal(catalog(f).profiles.length, 0);
  assert.equal(contents(join(location, 'chat')), 'kept');
  assert.match(refused.text, /Retired location/);
});
for (const failed of ['Code', 'Desktop'] as const) {
  test(`T138 T060 S29 S31 partial ${failed} recovery preserves the other completed surface`, async () => {
    const f = lifecycleFixture();
    let retained = '';
    if (failed === 'Code') {
      f.services.checkpoint = stage => {
        if (stage === 'add-staged') {
          const operation = readdirSync(join(f.control, 'recovery')).find(id =>
            existsSync(join(f.control, 'recovery', id, 'code-stage')))!;
          retained = join(f.control, 'recovery', operation, 'code-stage', 'user-change');
          f.put(retained, 'concurrent');
          throw new Error('failed Code with concurrent staging edit');
        }
      };
    } else {
      f.desktop.compile = async () => {
        retained = join(f.data, 'studio/desktop/user-change');
        f.put(retained, 'concurrent');
        throw new Error('failed Desktop with concurrent data edit');
      };
    }
    const added = await f.addPaired();
    assert.equal(added.code, 74, added.text);
    const profile = f.profile();
    assert.equal(!!profile.code, failed !== 'Code');
    assert.equal(!!profile.desktop, failed !== 'Desktop');
    assert.equal(contents(retained), 'concurrent');
    const operations = readdirSync(join(f.control, 'recovery'));
    assert.equal(operations.length, 1, 'Successful surface work must not retain a backup operation.');
    unlinkSync(retained);
    delete f.services.checkpoint;
    const result = await f.invoke(['doctor', '--recover', operations[0]!], ['y']);
    assert.equal(result.code, 0, result.text);
    assert.equal(f.profile().id, profile.id);
    assert.equal(!!f.profile().code, failed !== 'Code');
    assert.equal(!!f.profile().desktop, failed !== 'Desktop');
    assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
  });
}
test('T082 T058 S01 confirmed recovery also recognizes a bound application refresh journal', async () => {
  const f = lifecycleFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const application = f.application();
  const inode = lstatSync(application).ino;
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory, profile.id);
  const backup = join(transaction.directory, 'Claude.app');
  transaction.allow(application);
  transaction.allow(backup);
  transaction.moveTree(application, backup, true, approveTree(application, f.io));
  const journal = join(dirname(application), 'refresh.json');
  f.put(journal, JSON.stringify({
    format: 'bcm-refresh/1', installationKey: session.catalog.installationKey, profileId: profile.id,
    operation: transaction.directory, phase: 'old-moved', applications: [backup],
  }));
  const result = await f.invoke(['doctor', '--recover', transaction.directory.split('/').at(-1)!], ['y']);
  assert.equal(result.code, 0, result.text);
  assert.equal(lstatSync(application).ino, inode);
  assert.equal(existsSync(journal), false);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
});
test('T119 S13 malformed connector values are refused before any destination change', () => {
  const f = lifecycleFixture();
  const source = join(f.home, 'connector-source');
  const target = join(f.home, 'connector-target');
  f.put(join(source, 'claude_desktop_config.json'), '{"mcpServers":{"bad":"invalid"}}');
  assert.throws(() => connectorInventory(source, f.io));
  f.put(join(source, 'claude_desktop_config.json'), '{"mcpServers":{"new":{"command":"fixture"}}}');
  const path = join(target, 'claude_desktop_config.json');
  const before = '{"mcpServers":{"keep":{"args":"invalid"}},"unrelated":true}';
  f.put(path, before);
  const session = new CatalogSession(f.io, f.control);
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], session.inventory);
  assert.throws(() => mergeConnectors(source, target, ['new'], transaction, f.io));
  assert.equal(contents(path), before);
  assert.equal(transaction.rollback(), 0);
});

for (const action of ['refresh', 'rename', 'remove'] as const) {
  for (const phase of ['staging', 'liveness'] as const) {
    test(`S24 S28 approved ${action} preserves a substituted tree during ${phase}`, async () => {
      const f = lifecycleFixture();
      assert.equal((await f.addDesktop()).code, 0);
      const location = action === 'refresh' ? f.application() : f.profile().desktop!.location;
      const original = location + '-approved';
      let substituted = false;
      let armed = false;
      let inode = 0;
      const swap = () => {
        if (substituted) {
          return;
        }
        renameSync(location, original);
        f.put(join(location, 'unrelated-data'), 'keep substitute');
        inode = lstatSync(location).ino;
        substituted = true;
      };
      const point = action === 'refresh' ? 'copy-staged'
        : action === 'rename' ? (phase === 'staging' ? 'rename-staged' : 'rename-before-desktop')
          : 'remove-before-desktop';
      const checkpoint = (stage: string) => {
        if (stage === point) {
          if (phase === 'staging') {
            swap();
          } else {
            armed = true;
          }
        }
      };
      f.services.checkpoint = checkpoint;
      f.desktop.checkpoint = checkpoint;
      f.desktop.census = async () => {
        if (armed) {
          swap();
        }
        return { available: true, processes: [] };
      };
      if (action === 'refresh') {
        f.put(join(f.source, 'Contents/Info.plist'), '9.0.0');
      }
      const result = action === 'refresh' ? await f.invoke(['open-profile', 'studio'], null)
        : action === 'rename' ? await f.invoke(['rename', 'studio', 'work'], ['y'])
          : await f.invoke(['remove', 'studio'], ['y', 'y']);
      assert.ok(substituted, result.text);
      assert.notEqual(result.code, 0, result.text);
      assert.equal(contents(join(location, 'unrelated-data')), 'keep substitute');
      assert.equal(lstatSync(location).ino, inode);
      assert.ok(existsSync(original));
      assert.match(result.text, /identity|substitut|changed|preserv|recovery/i);
    });
  }
}
for (const action of ['rename', 'remove']) {
  for (const parentState of ['empty', 'nonempty', 'substituted']) {
    test(`T141 T143 S24 S31 ${action} cleans only its unchanged empty label parent: ${parentState}`, async () => {
      const f = lifecycleFixture();
      const profile = installProfile(f);
      const parent = dirname(profile.code!.location);
      if (parentState === 'nonempty') {
        f.put(join(parent, 'user-note'), 'preserve this sibling');
      }
      if (parentState === 'substituted') {
        f.services.checkpoint = stage => {
          if (stage === action + '-fences') {
            renameSync(parent, parent + '-observed');
            f.io.directory(parent);
          }
        };
      }
      const result = action === 'rename'
        ? await f.invoke(['rename', 'studio', 'work'], ['y'])
        : await f.invoke(['remove', 'studio'], ['y', 'y']);
      assert.equal(result.code, 0, result.text);
      assert.equal(existsSync(parent), parentState !== 'empty');
      if (parentState === 'nonempty') {
        assert.equal(contents(join(parent, 'user-note')), 'preserve this sibling');
      }
      if (parentState === 'substituted') {
        assert.deepEqual(readdirSync(parent), []);
        assert.ok(existsSync(parent + '-observed'));
        assert.match(result.text, /changed profile parent was preserved/);
      }
      assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
      assert.deepEqual(catalog(f).recoveryClaims, []);
    });
  }
}
