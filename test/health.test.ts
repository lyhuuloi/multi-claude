import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { healthFixture } from './health-support.js';
import { installProfile, catalog, save } from './support.js';
import { launcherRouteMatches } from '../src/launcher-review.js';
import { localExecutableVersion } from '../src/health-services.js';
import { maintenanceFinding } from '../src/maintenance-state.js';
import { resourceRevision } from '../src/release.js';
import { auditFences } from '../src/read-fences.js';
import { launcherSource } from '../src/dock-bundles.js';
import { execute } from '../src/machine-services.js';
const text = (path: string) => readFileSync(path, 'utf8');
function snapshot(root: string): unknown[] {
  const result: unknown[] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path);
    result.push([path, stat.ino, stat.mode, stat.mtimeMs, stat.isFile() ? text(path) : 'directory']);
    if (stat.isDirectory()) {
      readdirSync(path).sort().forEach(name => walk(join(path, name)));
    }
  };
  walk(root);
  return result;
}
test('T130 S62 full doctor verifies resource evidence without writing or claiming effective isolation', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const before = snapshot(f.home);
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 0, result.text);
  assert.deepEqual(snapshot(f.home), before);
  assert.match(result.text, /installation:/);
  assert.match(result.text, /deep strict pinned verification/);
  assert.match(result.text, /fixed UUID route and synchronous wait match/);
  assert.match(result.text, /Disk contents do not prove effective permissions/);
  assert.match(result.text, /Grep\/Glob coverage is best-effort/);
  assert.equal(f.calls.some(call => ['open', 'dock-refresh', 'register', 'unregister'].includes(call.kind)), false);
});
test('T147 T148 S51 S69 S70 Git diagnostics read disposable config without invoking helpers or SSH', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const marker = join(f.home, 'helper-must-not-run');
  const config = '[credential]\n'
  + `  helper = "!touch ${marker} credential-sentinel"\n`
  + '[core]\n'
  + `  sshCommand = "touch ${marker}"\n`
  + '[user]\n  name = identity-sentinel\n  email = identity-sentinel@example.test\n';
  f.put(join(f.home, '.gitconfig'), config);
  f.env.SSH_AUTH_SOCK = 'agent-sentinel';
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /global credential helpers: 1 configured/);
  assert.match(result.text, /SSH transport: configuration observed/);
  assert.match(result.text, /SSH-agent sharing: SSH_AUTH_SOCK is present/);
  assert.match(result.text, /global commit identity/);
  for (const sentinel of ['credential-sentinel', 'identity-sentinel', 'agent-sentinel']) {
    assert.equal(result.text.includes(sentinel), false);
  }
  assert.equal(existsSync(marker), false);
  assert.equal(text(join(f.home, '.gitconfig')), config);
  for (const call of f.healthTools.filter(call => call.file === '/usr/bin/git')) {
    assert.deepEqual(call.args.slice(0, 2), ['config', '--file']);
    assert.ok(call.args.includes('--no-includes'));
    assert.equal(call.args.some(arg => ['fill', 'approve', 'reject', '--get-urlmatch'].includes(arg)), false);
  }
});
test('T148 S69 executable version inspection reads bound package metadata without running a program', () => {
  const f = healthFixture();
  const executable = join(f.home, 'local-package/bin/claude');
  const marker = join(f.home, 'program-must-not-run');
  f.put(executable, '#!/bin/sh\ntouch ' + marker + '\n');
  f.put(join(f.home, 'local-package/package.json'), JSON.stringify({
    version: '2.3.4', bin: { claude: 'bin/claude' },
  }));
  assert.equal(localExecutableVersion(executable), '2.3.4');
  assert.equal(existsSync(marker), false);
});
test('T130 S07 S25 doctor --apply replaces a foreign launcher only through a new verified destination', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const original = f.profile().desktop!.launcher;
  renameSync(original, original + '-owned');
  f.put(join(original, 'Contents/Info.plist'), 'foreign canary');
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 0, result.text);
  assert.equal(text(join(original, 'Contents/Info.plist')), 'foreign canary');
  assert.notEqual(f.profile().desktop!.launcher, original);
  assert.match(result.text, /Post-repair audit/);
  assert.equal(f.calls.some(call => call.kind === 'dock-refresh'), false);
});
test('T130 S24 S25 an unsafe profile is skipped while independent safe shell resources are repaired', async () => {
  const f = healthFixture();
  const unsafe = installProfile(f, 'unsafe');
  const safe = installProfile(f, 'safe');
  renameSync(unsafe.code!.location, unsafe.code!.location + '-original');
  f.put(join(unsafe.code!.location, 'foreign-canary'), 'preserve');
  const value = catalog(f);
  value.profiles.find(profile => profile.id === safe.id)!.code!.runtime = '/missing/node';
  save(f, value);
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 2, result.text);
  assert.equal(text(join(unsafe.code!.location, 'foreign-canary')), 'preserve');
  assert.equal(catalog(f).profiles.find(profile => profile.id === safe.id)!.code!.runtime, process.execPath);
  assert.match(result.text, /unsafe: skipped Code repair/);
  assert.match(result.text, /Maintenance was not recorded as fully applied/);
});
test('T130 S62 post-repair audit detects injected residual drift and does not advance maintenance', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const maintenance = join(f.control, 'maintenance.json');
  const old = JSON.parse(text(maintenance));
  old.revision = 'older-resource-revision';
  f.put(maintenance, JSON.stringify(old));
  f.services.checkpoint = stage => {
    if (stage === 'doctor-before-post-audit') {
      f.put(join(f.profile().code!.location, 'settings.json'), '{}');
    }
  };
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /Post-repair audit/);
  assert.match(result.text, /Read rules need synchronization/);
  assert.equal(JSON.parse(text(maintenance)).revision, old.revision);
});
test('T152 T153 S63 session notices distinguish changed disk rules from a live session and later overwrite',
  async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const profile = f.profile();
    const settings = join(profile.code!.location, 'settings.json');
    f.services.census = async () => ({ available: true, processes: [{
      pid: 901, uid: f.io.guard.uid, executable: '/fixture/claude', argv: [],
      environment: { CLAUDE_CONFIG_DIR: profile.code!.location },
    }] });
    f.put(settings, '{}');
    const changed = await f.invoke(['doctor', '--apply'], null);
    assert.equal(changed.code, 0, changed.text);
    assert.match(changed.text, /observed sessions active; PIDs: 901/);
    assert.match(changed.text, /Restart running or uncertain Code sessions/);
    assert.match(changed.text, /does not establish enforcement/);
    f.put(settings, '{}');
    const later = await f.invoke(['doctor'], null);
    assert.equal(later.code, 2, later.text);
    assert.match(later.text, /Read rules need synchronization/);
  });
test('S69 maintenance notices remain local, disappear after successful audit and do not mislabel first setup',
  async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    assert.equal(maintenanceFinding(catalog(f), f.control, f.services.cli, f.io), null);
    assert.equal((await f.invoke(['status', 'studio'], null)).text.includes('Generated resources need review'), false);
    const path = join(f.control, 'maintenance.json');
    const record = JSON.parse(text(path));
    record.revision = 'older-resource-revision';
    f.put(path, JSON.stringify(record));
    assert.match((await f.invoke(['list'], null)).text, /Generated resources need review/);
    assert.equal((await f.invoke(['doctor', '--apply'], null)).code, 0);
    assert.equal(JSON.parse(text(path)).revision, resourceRevision);
    assert.equal(JSON.parse(text(path)).reason, 'audited');
    assert.equal(maintenanceFinding(catalog(f), f.control, f.services.cli, f.io), null);
    assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
  });
test('S51 doctor compares account identifiers by equality without printing IDs or connector values', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const baseline = join(f.home, 'Library/Application Support/Claude');
  f.put(join(baseline, 'config.json'), '{"lastKnownAccountUuid":"account-sentinel"}');
  f.put(join(f.profile().desktop!.location, 'config.json'), '{"lastKnownAccountUuid":"account-sentinel"}');
  f.put(join(baseline, 'claude_desktop_config.json'), '{"mcpServers":{"baseline-name":{"command":"token-sentinel"}}}');
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /baseline, studio: account comparison/);
  assert.match(result.text, /intentional sharing is possible/);
  assert.match(result.text, /baseline-name/);
  assert.equal(result.text.includes('account-sentinel'), false);
  assert.equal(result.text.includes('token-sentinel'), false);
});
test('S51 S66 doctor never imports baseline connectors or extensions even when safe repairs are requested',
  async () => {
    const f = healthFixture();
    assert.equal((await f.addDesktop()).code, 0);
    const baseline = join(f.home, 'Library/Application Support/Claude');
    f.put(join(baseline, 'claude_desktop_config.json'), '{"mcpServers":{"baseline-name":{"command":"sentinel"}}}');
    f.put(join(baseline, 'Claude Extensions/extension/manifest.json'), '{"name":"extension","version":"1.0.0"}');
    const result = await f.invoke(['doctor', '--apply'], null);
    assert.equal(result.code, 0, result.text);
    const root = f.profile().desktop!.location;
    assert.equal(existsSync(join(root, 'claude_desktop_config.json')), false);
    assert.equal(existsSync(join(root, 'Claude Extensions')), false);
    assert.match(result.text, /Information only/);
  });
test('S07 S49 doctor detects direct-copy Dock pins and validates only the fixed synchronous launch route', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const path = join(f.home, 'Library/Preferences/com.apple.dock.plist');
  f.put(path, JSON.stringify({ 'persistent-apps': [{
    'tile-data': { 'file-data': { _CFURLString: pathToFileURL(f.application()).href } },
  }] }));
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /dedicated copy is pinned directly/);
  const profile = f.profile();
  const source = launcherSource(profile.desktop!.runtime!, profile.desktop!.cli!, profile.id, join(f.control,
    'catalog.json'));
  assert.equal(launcherRouteMatches(source, profile, join(f.control, 'catalog.json')), true);
  assert.equal(launcherRouteMatches(source.replace('do shell script', 'run script'), profile, join(f.control,
    'catalog.json')), false);
  assert.equal(launcherRouteMatches(source.replace('_dock-entry', 'open-profile'), profile, join(f.control,
    'catalog.json')), false);
});
for (const scenario of ['bookmarks', 'missing URL', 'excess count', 'changed image']) {
  test(`T163 S07 S62 Dock inventory extracts bounded keys with ${scenario}`, async () => {
    const f = healthFixture();
    const path = join(f.home, 'Library/Preferences/com.apple.dock.plist');
    const tile = '<dict><key>tile-data</key><dict><key>file-data</key><dict>'
      + '<key>_CFURLString</key><string>file:///Applications/Other.app/</string>'
      + '</dict></dict></dict>';
    const contents = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
      + '<key>bookmark</key><data>YWJj</data><key>modified</key><date>2026-01-01T00:00:00Z</date>'
      + '<key>persistent-apps</key><array>'
      + (scenario === 'excess count' ? '<dict/>'.repeat(501)
        : scenario === 'missing URL' ? '<dict/><dict/>' : tile + '<dict/>')
      + '</array></dict></plist>';
    f.put(path, contents);
    const services = f.health.services!;
    const original = services.tool;
    const keys: string[] = [];
    services.tool = async (file, args) => {
      if (args.at(-1) !== path) {
        return original(file, args);
      }
      assert.equal(file, '/usr/bin/plutil');
      assert.equal(args[0], '-extract');
      assert.deepEqual(args.slice(2, -1), ['raw', '-o', '-']);
      keys.push(args[1]!);
      const result = await execute(file, args);
      if (scenario === 'changed image') {
        f.put(path, contents + '\n');
      }
      return result;
    };
    const result = await f.invoke(['doctor'], null);
    assert.equal(result.code, ['excess count', 'changed image'].includes(scenario) ? 2 : 0, result.text);
    assert.equal(keys[0], 'persistent-apps');
    if (scenario === 'excess count') {
      assert.equal(keys.length, 1);
      assert.match(result.text, /exceeds the inspection limit/);
    } else if (scenario !== 'changed image') {
      assert.equal(keys.length, 3);
      assert.equal(result.text.includes('Dock pins:'), false);
      assert.equal(text(path), contents);
    }
  });
}

test('S09 S38 S44 doctor restores tint under the profile mutex without downgrading a newer valid copy', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const application = f.application();
  f.put(join(application, 'Contents/Info.plist'), '5.10.0');
  const inode = lstatSync(application).ino;
  const executable = text(join(application, 'Contents/MacOS/Claude'));
  const value = catalog(f);
  value.profiles[0]!.desktop!.tint = 'sky';
  save(f, value);
  const tint = f.desktop.tint;
  f.desktop.tint = async (path, color) => {
    assert.ok(existsSync(join(f.control, 'leases', `profile-${f.profile().id}.json`)));
    await tint(path, color);
  };
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 0, result.text);
  assert.equal(lstatSync(application).ino, inode);
  assert.equal(text(join(application, 'Contents/Info.plist')), '5.10.0');
  assert.equal(text(join(application, 'Contents/MacOS/Claude')), executable);
  assert.equal(text(join(application, 'Icon\r')), 'synthetic sky');
});
test('S44 T080 running-copy tint repair is skipped and remains visible after the audit', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const profile = f.profile();
  const value = catalog(f);
  value.profiles[0]!.desktop!.tint = 'rose';
  save(f, value);
  const application = f.application();
  f.setProcesses([{
    pid: 902, uid: f.io.guard.uid, start: 'stable', bundle: application,
    executable: join(application, 'Contents/MacOS/Claude'), bundleId: 'com.anthropic.claudefordesktop',
    data: profile.desktop!.location, uncertain: false,
  }]);
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 2, result.text);
  assert.equal(existsSync(join(application, 'Icon\r')), false);
  assert.match(result.text, /skipped Desktop repair/);
});
test('S25 S64 doctor establishes an absent owned update policy and preserves foreign libraries', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  assert.equal((await f.invoke(['desktop-updates', 'studio', 'application'], ['y'])).code, 0);
  const value = catalog(f);
  value.profiles[0]!.desktop!.updateMode = 'launcher';
  save(f, value);
  const repaired = await f.invoke(['doctor', '--apply'], null);
  assert.equal(repaired.code, 0, repaired.text);
  const policy = f.profile().desktop!.location + '-3p';
  f.put(join(policy, 'configLibrary/_meta.json'), '{}');
  const before = snapshot(policy);
  const foreign = await f.invoke(['doctor', '--apply'], null);
  assert.equal(foreign.code, 2, foreign.text);
  assert.deepEqual(snapshot(policy), before);
  assert.match(foreign.text, /skipped external or changed policy/);
});
test('S58 S63 doctor rebases only existing eligible setup references and preserves exclusion intent', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const root = f.profile().code!.location;
  const baseline = join(f.home, '.claude');
  f.put(join(root, 'hook'), 'copied setup');
  const path = join(root, 'settings.json');
  const settings = JSON.parse(text(path));
  settings.hooks = { command: baseline + '/hook' };
  settings.claudeMdExcludes = [baseline];
  settings.unrelated = baseline;
  f.put(path, JSON.stringify(settings));
  const result = await f.invoke(['doctor', '--apply'], null);
  assert.equal(result.code, 0, result.text);
  const actual = JSON.parse(text(path));
  assert.equal(actual.hooks.command, root + '/hook');
  assert.deepEqual(actual.claudeMdExcludes, [baseline]);
  assert.equal(actual.unrelated, baseline);
  assert.deepEqual(auditFences(catalog(f), f.control, f.io), []);
});
test('S32 S62 doctor reports retained recovery and suspicious transcript names without deleting either', async () => {
  const f = healthFixture();
  assert.equal((await f.addPaired()).code, 0);
  const code = f.profile().code!.location;
  f.put(join(code, 'copied-transcript.jsonl'), 'credential-sentinel');
  const recovery = join(f.control, 'recovery/unrecognized');
  f.put(join(recovery, 'canary'), 'credential-sentinel');
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 2, result.text);
  assert.match(result.text, /transcript\/history filenames/);
  assert.match(result.text, /Uninventoried material/);
  assert.equal(result.text.includes('credential-sentinel'), false);
  assert.ok(existsSync(join(recovery, 'canary')));
});
test('S51 S62 unsafe or malformed state never becomes an empty healthy doctor result', async () => {
  const f = healthFixture();
  f.put(join(f.control, 'catalog.json'), '{bad credential-sentinel');
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 1);
  assert.match(result.text, /installation:/);
  assert.equal(result.text.includes('credential-sentinel'), false);
  assert.equal(result.text.includes('No managed profiles'), false);
});
test('T130 S01 S51 doctor inventories failed signatures, moved runtimes and override names without raw values',
  async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    f.services.executables = name => name === 'claude' ? ['/fixture/claude', '/fixture/older-claude'] : [];
    f.env.ANTHROPIC_API_KEY = 'environment-secret-sentinel';
    f.desktop.launchdOverrides = async () => ['GH_TOKEN'];
    f.desktop.tool = async () => ({ code: 1, stdout: 'process-secret-sentinel', stderr: 'signature-secret-sentinel' });
    const current = catalog(f);
    current.profiles[0]!.desktop!.runtime = join(f.home, 'missing-node');
    save(f, current);
    const result = await f.invoke(['doctor'], null);
    assert.equal(result.code, 2, result.text);
    for (const message of ['Shadowed alternatives: /fixture/older-claude', 'version: 2.3.4',
      'runtime:', 'source signature:', 'copy signature:', 'ANTHROPIC_API_KEY', '/bin/launchctl unsetenv GH_TOKEN']) {
      assert.ok(result.text.includes(message), message);
    }
    assert.equal(result.text.includes('secret-sentinel'), false);
    assert.equal(f.calls.some(call => call.kind === 'open'), false);
  });
test('T148 S51 S70 Git includes stay unread and invalid global config produces unknown sharing evidence', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  const outsideConfig = join(f.home, 'included-config');
  f.put(outsideConfig, '[user]\nname = include-secret-sentinel\n');
  f.put(join(f.home, '.gitconfig'), '[include]\npath = ' + outsideConfig + '\n');
  const result = await f.invoke(['doctor'], null);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /include files were not followed/);
  assert.equal(result.text.includes('include-secret-sentinel'), false);
  assert.equal(f.healthTools.some(call => call.args.includes(outsideConfig)), false);
  f.put(join(f.home, '.gitconfig'), '[invalid secret-sentinel');
  const unknown = await f.invoke(['doctor'], null);
  assert.equal(unknown.code, 2);
  assert.match(unknown.text, /sharing details are unknown/);
  assert.equal(unknown.text.includes('secret-sentinel'), false);
});
test('T148 S51 S69 S70 absent developer tools skip the Git shim and report unknown sharing evidence', async () => {
  const f = healthFixture();
  assert.equal((await f.addDesktop()).code, 0);
  f.put(join(f.home, '.gitconfig'), '[user]\nname = identity-secret-sentinel\n');
  const original = f.health.services!.tool;
  for (const failure of ['exit', 'throw']) {
    const calls: string[] = [];
    f.health.services!.tool = async (file, args) => {
      calls.push(file);
      if (file === '/usr/bin/xcode-select') {
        assert.deepEqual(args, ['-p']);
        if (failure === 'throw') {
          throw new Error('tool-secret-sentinel');
        }
        return { code: 1, stdout: 'tool-secret-sentinel', stderr: 'tool-secret-sentinel' };
      }
      return original(file, args);
    };
    const result = await f.invoke(['doctor'], null);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, /Developer tools are not installed or available/);
    assert.match(result.text, /Git was not invoked and sharing evidence is unknown/);
    assert.equal(result.text.includes('secret-sentinel'), false);
    assert.ok(calls.includes('/usr/bin/xcode-select'));
    assert.equal(calls.includes('/usr/bin/git'), false);
  }
});
test('T099 S10 S69 compiled runtime has no quarantine deletion or built-in network client', () => {
  const f = healthFixture();
  const runtime = join(f.repo, 'dist/src');
  const modules = readdirSync(runtime).filter(name => name.endsWith('.js'));
  assert.ok(modules.length > 0);
  for (const name of modules) {
    const source = text(join(runtime, name));
    assert.equal(/(?:quarantine|\/xattr|removeExtendedAttribute)/i.test(source), false, name);
    assert.equal(/node:(?:https?|net|tls|dns|dgram|http2)\b/.test(source), false, name);
    assert.equal(/\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(/.test(source), false, name);
  }
});
test('T007 S28 S31 doctor interruption rolls back changed shell bytes and releases the shared registry gate',
  async () => {
    const f = healthFixture();
    assert.equal((await f.addPaired()).code, 0);
    const rc = f.profile().code!.rc;
    const previous = '# user-selected rc before generated-route repair\n';
    f.put(rc, previous);
    let interrupted = false;
    f.services.checkpoint = async stage => {
      if (stage === 'doctor-code-written') {
        interrupted = true;
        process.emit('SIGINT');
      }
    };
    const result = await f.invoke(['doctor', '--apply'], null);
    assert.ok(interrupted);
    assert.equal(result.code, 130, result.text);
    assert.equal(text(rc), previous);
    assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
    assert.equal(existsSync(join(f.control, 'leases/registry.json')), false);
  });
