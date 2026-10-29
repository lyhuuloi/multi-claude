import { approveTree } from '../src/approved-tree.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { cpSync, existsSync, readFileSync, lstatSync, renameSync, symlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { profileFixture, catalog, save, repo, installProfile } from './support.js';
import { recordRoot } from '../src/profile-catalog.js';
import type { Profile } from '../src/profile-catalog.js';
import type { DesktopServices } from '../src/desktop-services.js';
import type { DesktopProcess } from '../src/process-census.js';
import { desktopState, desktopNativeCensus } from '../src/process-census.js';
import { verifyClaude, pinnedRequirement, compareVersions } from '../src/claude-authenticity.js';
import { launcherSource, compileLauncher, launcherIdentifier } from '../src/dock-bundles.js';
import { DesktopLaunch, openArguments } from '../src/desktop-launch.js';
import { CatalogSession } from '../src/profile-actions.js';
import { ChangeRecord } from '../src/change-records.js';
import { LeaseManager } from '../src/operation-leases.js';
import { runFront } from '../src/command-front.js';
import { executionEnvironment } from '../src/execution-policy.js';
import { Problem } from '../src/outcomes.js';
import { LocationGuard } from '../src/location-guard.js';
function desktopFixture() {
  const fixture = profileFixture();
  const calls: { file: string; args: readonly string[] }[] = [];
  const opens: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const terminated: number[] = [];
  let processes: DesktopProcess[] = [];
  const source = join(fixture.home, 'source/Claude.app');
  function write(path: string, value: string) {
    fixture.io.directory(dirname(path));
    fixture.io.write(path, value, fixture.io.snapshot(path));
  }
  write(join(source, 'Contents/Info.plist'), '4.29.0');
  write(join(source, 'Contents/MacOS/Claude'), 'signed fixture');
  const services: DesktopServices = {
    identities: fixture.services.identities,
    tool: async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    copy: async (from, to) => {
      cpSync(from, to, { recursive: true });
    },
    tint: async (path, tint) => {
      calls.push({ file: 'tint', args: [path, tint] });
    },
    version: async path => readFileSync(join(path, 'Contents/Info.plist'), 'utf8'),
    compile: async (script, target) => {
      write(join(target, 'Contents/Resources/Scripts/main.scpt'), readFileSync(script, 'utf8'));
      write(join(target, 'Contents/MacOS/applet'), 'compiled fixture');
      write(join(target, 'Contents/Info.plist'), '{}');
    },
    census: async () => ({ available: true, processes }),
    confirmWrong: async () => false,
    terminate: async process => {
      terminated.push(process.pid);
      processes = processes.filter(value => value.pid !== process.pid);
    },
    open: async (args, env) => {
      opens.push({ args, env });
    },
    notify: async () => {},
    contentionMs: 0,
  };
  const now = new Date().toISOString();
  const profile: Profile = {
    id: randomUUID(), label: 'desktop', bornAt: now, changedAt: now, code: null, credentialPolicy: 'subscription',
    rootEvidence: [], desktop: {
      location: join(fixture.data, 'desktop/desktop'), source,
      launcher: join(fixture.home, 'Applications/Claude Profiles/Claude desktop.app'), tint: 'none',
      updateMode: 'launcher', defaultLocation: true, defaultLauncher: true,
      runtime: process.execPath, cli: join(repo, 'dist/src/main.js'),
    },
  };
  const value = catalog(fixture);
  fixture.io.directory(profile.desktop!.location);
  profile.rootEvidence.push(recordRoot(profile.desktop!.location, 'desktop', value.installationKey,
    profile.id, fixture.io));
  value.profiles.push(profile);
  save(fixture, value);
  const application = join(fixture.control, 'bundles.noindex', profile.id, 'Claude.app');
  const messages: string[] = [];
  const engine = new DesktopLaunch(fixture.home, fixture.io, services, message => messages.push(message), fixture.env);
  const run = () => engine.run(join(fixture.control, 'catalog.json'), profile.id, true);
  const makeProcess = (data: string | null = profile.desktop!.location): DesktopProcess => ({
    pid: 101, uid: fixture.io.guard.uid, start: 'stable-start', bundle: application,
    executable: join(application, 'Contents/MacOS/Claude'), bundleId: 'com.anthropic.claudefordesktop',
    data, uncertain: false,
  });
  return {
    ...fixture, services, calls, opens, terminated, source, profile, application, engine, run,
    process: makeProcess, messages, write, base: fixture,
    setProcesses: (next: DesktopProcess[]) => {
      processes = next;
    },
  };
}
const kind = (value: string) => (error: unknown) => error instanceof Problem && error.kind === value;
test('T071 S01 S04 S06 signature checks pin the designated requirement and deep/strict sequence', async () => {
  const fixture = desktopFixture();
  await verifyClaude(fixture.source, true, fixture.io.guard, fixture.services.tool);
  assert.deepEqual(fixture.calls[0]!.args, ['--verify', '--deep', '--strict', '-R', '=' + pinnedRequirement,
    fixture.source]);
  await fixture.run();
  const checks = fixture.calls.filter(call => call.file === '/usr/bin/codesign');
  assert.ok(checks.some(call => call.args.includes('--strict') && call.args.at(-1) !== fixture.source));
  assert.ok(checks.at(-1)!.args.includes('--deep'));
  assert.equal(checks.at(-1)!.args.includes('--strict'), false);
  assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
});
test('T072 S01 S08 unsigned and wrong-signer sources fail before creating copy storage or opening', async () => {
  const fixture = desktopFixture();
  fixture.services.tool = async () => ({ code: 1, stdout: '', stderr: 'untrusted-sentinel' });
  await assert.rejects(fixture.run(), kind('claude-signature'));
  assert.equal(existsSync(join(fixture.control, 'bundles.noindex')), false);
  assert.deepEqual(fixture.opens, []);
});
test('T073 S02 linked source roots and linked Contents are refused before verifier execution', async () => {
  for (const contents of [false, true]) {
    const fixture = desktopFixture();
    const path = contents ? join(fixture.source, 'Contents') : fixture.source;
    renameSync(path, path + '-original');
    symlinkSync(path + '-original', path);
    await assert.rejects(fixture.run());
    assert.equal(fixture.calls.length, 0);
    assert.equal(fixture.opens.length, 0);
  }
});
test('T074 S03 private copy ownership and private parent permissions are enforced', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const fs = await import('node:fs');
  fs.chmodSync(dirname(fixture.application), 0o755);
  await assert.rejects(fixture.run(), kind('bundle-private'));
  assert.equal(fixture.opens.length, 1);
  const foreign = new LocationGuard(fixture.io.guard.uid + 1);
  foreign.chain = () => [];
  foreign.parents = () => [];
  await assert.rejects(verifyClaude(fixture.application, true, foreign, fixture.services.tool, true),
    kind('bundle-owner'));
});
test('T075 T043 S03 clone failure retries in a different empty staging directory', async () => {
  const fixture = desktopFixture();
  const targets: string[] = [];
  fixture.services.copy = async (from, to, clone) => {
    targets.push(to);
    assert.equal(existsSync(to), false);
    if (clone) {
      fixture.write(join(to, 'partial'), 'partial');
      throw new Problem('copy-command', 'clone failed');
    }
    cpSync(from, to, { recursive: true });
  };
  await fixture.run();
  assert.equal(targets.length, 2);
  assert.notEqual(targets[0], targets[1]);
  assert.equal(existsSync(join(fixture.application, 'partial')), false);
  assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
});
test('T076 T077 S15 S28 invalid fresh candidates cannot replace the valid installed application', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const original = lstatSync(fixture.application).ino;
  fixture.write(join(fixture.source, 'Contents/Info.plist'), '4.30.0');
  fixture.services.tool = async (_file, args) => ({
    code: args.at(-1)?.includes('/candidate-') ? 1 : 0, stdout: '', stderr: '',
  });
  await assert.rejects(fixture.run(), kind('claude-signature'));
  assert.equal(lstatSync(fixture.application).ino, original);
  assert.equal(fixture.opens.length, 1);
});
test('T077 S28 S31 failed installation restores the unchanged prior copy and discards pre-images', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const old = lstatSync(fixture.application).ino;
  fixture.write(join(fixture.source, 'Contents/Info.plist'), '4.30.0');
  fixture.services.checkpoint = stage => {
    if (stage === 'copy-installed') {
      throw new Error('injected failure');
    }
  };
  await assert.rejects(fixture.run());
  assert.equal(lstatSync(fixture.application).ino, old);
  assert.equal(readFileSync(join(fixture.application, 'Contents/Info.plist'), 'utf8'), '4.29.0');
  assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
});
test('T078 T079 S09 numeric versions never downgrade newer or unknown valid copies', async () => {
  assert.equal(compareVersions('4.29.10', '4.29.9'), 1);
  assert.equal(compareVersions('4.29', '4.29.0'), 0);
  assert.equal(compareVersions('9007199254740993999', '9007199254740993998'), 1);
  assert.equal(compareVersions('unknown', '4.29.0'), null);
  const fixture = desktopFixture();
  await fixture.run();
  const inode = lstatSync(fixture.application).ino;
  fixture.write(join(fixture.source, 'Contents/Info.plist'), '4.1.0');
  await fixture.run();
  assert.equal(lstatSync(fixture.application).ino, inode);
  fixture.services.version = async () => null;
  await fixture.run();
  assert.equal(lstatSync(fixture.application).ino, inode);
  assert.match(fixture.messages.join('\n'), /ordering is unknown/);
});
test('T080 S09 S38 S44 tinting is locked and never touches signed resources or a running copy', async () => {
  const fixture = desktopFixture();
  const value = catalog(fixture.base);
  value.profiles[0]!.desktop!.tint = 'mint';
  save(fixture.base, value);
  let tinted = false;
  // Finder's Icon CR is an external metadata file, not a new protected root.
  fixture.services.tint = async (path, color) => {
    assert.ok(existsSync(join(fixture.control, 'leases', `profile-${fixture.profile.id}.json`)));
    assert.equal(color, 'mint');
    const fs = await import('node:fs');
    fs.writeFileSync(join(path, 'Icon\r'), 'metadata', { mode: 0o600 });
    tinted = true;
  };
  await fixture.run();
  assert.equal(tinted, true);
  const before = fixture.calls.filter(call => call.file === 'tint').length;
  fixture.setProcesses([fixture.process()]);
  await fixture.run();
  assert.equal(fixture.calls.filter(call => call.file === 'tint').length, before);
});
test('T081 S05 S44 a running invalid copy is not opened, replaced or tinted', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  fixture.setProcesses([fixture.process()]);
  fixture.services.tool = async (_file, args) => ({ code: args.at(-1) === fixture.application ? 1 : 0,
    stdout: '', stderr: '' });
  await assert.rejects(fixture.run(), kind('desktop-running-invalid'));
  assert.equal(fixture.opens.length, 1);
});
test('T095 S05 a correct instance is deeply reverified and focused without replacement', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const inode = lstatSync(fixture.application).ino;
  fixture.write(join(fixture.source, 'Contents/Info.plist'), '4.30.0');
  fixture.setProcesses([fixture.process()]);
  await fixture.run();
  assert.deepEqual(fixture.opens.at(-1)!.args, ['-a', fixture.application]);
  assert.equal(lstatSync(fixture.application).ino, inode);
});
test('T094 S48 S49 Desktop launch applies explicit selectors before one complete data argument', () => {
  const fixture = desktopFixture();
  const selected = executionEnvironment(fixture.profile, { CLAUDE_CONFIG_DIR: 'wrong', GH_CONFIG_DIR: 'wrong' });
  assert.equal(Object.hasOwn(selected, 'CLAUDE_CONFIG_DIR'), false);
  const args = openArguments(fixture.application, '/data with spaces', { CLAUDE_CONFIG_DIR: '/code with spaces' });
  assert.ok(args.indexOf('--env') < args.indexOf('--args'));
  assert.equal(args.at(-1), '--user-data-dir=/data with spaces');
  assert.equal(args.filter(value => value === '--args').length, 1);
});
test('T062 T063 T067 S41 S42 process classification uses exact data or executable identities, not prefixes', () => {
  const fixture = desktopFixture();
  const process = fixture.process('/other');
  const executable = process.executable;
  assert.equal(desktopState(fixture.profile.desktop!.location, executable,
    { available: true, processes: [process] }, fixture.io.guard.uid).kind, 'wrong');
  process.data = fixture.profile.desktop!.location;
  process.executable = '/Applications/Claude.app/Contents/MacOS/Claude';
  assert.equal(desktopState(process.data, executable, { available: true, processes: [process] },
    fixture.io.guard.uid).kind, 'correct');
  process.data += '-prefix';
  assert.equal(desktopState(fixture.profile.desktop!.location, executable,
    { available: true, processes: [process] }, fixture.io.guard.uid).kind, 'idle');
  process.uncertain = true;
  assert.equal(desktopState(fixture.profile.desktop!.location, executable,
    { available: true, processes: [process] }, fixture.io.guard.uid).kind, 'unknown');
});
for (const changed of ['start', 'executable', 'bundle', 'uid', 'bundleId', 'data'] as const) {
  test(`T149 T150 S71 post-dialog ${changed} changes prevent termination`, async () => {
    const fixture = desktopFixture();
    await fixture.run();
    const wrong = fixture.process(null);
    fixture.setProcesses([wrong]);
    fixture.services.confirmWrong = async () => {
      const replaced = { ...wrong };
      if (changed === 'uid') {
        replaced.uid++;
      } else {
        replaced[changed] = 'changed';
      }
      fixture.setProcesses([replaced]);
      return true;
    };
    await assert.rejects(fixture.run());
    assert.deepEqual(fixture.terminated, []);
    assert.equal(fixture.opens.length, 1);
  });
}
test('T151 S71 a correct instance appearing during confirmation is focused without termination', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  fixture.setProcesses([fixture.process(null)]);
  fixture.services.confirmWrong = async () => {
    fixture.setProcesses([fixture.process()]);
    return true;
  };
  await fixture.run();
  assert.deepEqual(fixture.terminated, []);
  assert.deepEqual(fixture.opens.at(-1)!.args, ['-a', fixture.application]);
});
test('T149 S71 wrong-location confirmation defaults to leaving the application running', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  fixture.setProcesses([fixture.process(null)]);
  await fixture.run();
  assert.deepEqual(fixture.terminated, []);
  assert.equal(fixture.opens.length, 1);
});
test('S43 S71 a confirmed unchanged wrong instance is gracefully terminated and reevaluated', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  fixture.setProcesses([fixture.process(null)]);
  fixture.services.confirmWrong = async () => true;
  await fixture.run();
  assert.deepEqual(fixture.terminated, [101]);
  assert.ok(fixture.opens.at(-1)!.args.includes('-n'));
});
test('T068 S40 S43 a profile starting during staging blocks installation and preserves its state', async () => {
  const fixture = desktopFixture();
  fixture.services.checkpoint = stage => {
    if (stage === 'copy-staged') {
      fixture.setProcesses([fixture.process(null)]);
    }
  };
  await assert.rejects(fixture.run());
  assert.equal(existsSync(fixture.application), false);
  assert.deepEqual(fixture.opens, []);
});
test('T096 S38 contention permits only a verified existing copy and never copy recovery', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const manager = new LeaseManager(join(fixture.control, 'leases'), fixture.io, fixture.services.identities);
  const gate = await manager.acquire('registry');
  const held = await manager.acquire(`profile-${fixture.profile.id}`);
  gate.release();
  const copies = fixture.calls.length;
  await fixture.run();
  assert.ok(fixture.calls.length > copies);
  assert.match(fixture.messages.join('\n'), /without recovery or changes/);
  held.release();
});
test('T084 T086 T087 S07 launcher data is independently quoted and routes only a UUID and catalog', () => {
  const id = randomUUID();
  const source = launcherSource('/node/path', '/cli/curly “quote” and apostrophe\'.js',
    id, '/catalog/location.json');
  assert.match(source, /do shell script/);
  assert.match(source, /_dock-entry/);
  assert.match(source, /NODE_OPTIONS -u NODE_PATH/);
  assert.match(source, /character id 8220/);
  assert.equal(source.includes(' &\n'), false);
  assert.equal(source.includes('/usr/bin/open'), false);
  assert.ok(source.includes(id));
  assert.equal(launcherIdentifier(id), 'io.github.lyhuuloi.ben-claude-multi.p' + id.replace(/-/g, ''));
});
test('T085 S07 missing runtime, CLI, catalog and UUID fail closed without open', async () => {
  const fixture = desktopFixture();
  await assert.rejects(fixture.engine.run(join(fixture.home, 'missing/catalog.json'), fixture.profile.id, true));
  await assert.rejects(fixture.engine.run(join(fixture.control, 'catalog.json'), randomUUID(), true));
  for (const field of ['runtime', 'cli'] as const) {
    const value = catalog(fixture.base);
    value.profiles[0]!.desktop!.runtime = process.execPath;
    value.profiles[0]!.desktop!.cli = join(repo, 'dist/src/main.js');
    value.profiles[0]!.desktop![field] = '/missing/engine';
    save(fixture.base, value);
    await assert.rejects(fixture.run());
  }
  assert.deepEqual(fixture.opens, []);
});
test('T044 T045 S39 registry contention never opens stale lifecycle locations', async () => {
  const fixture = desktopFixture();
  const manager = new LeaseManager(join(fixture.control, 'leases'), fixture.io, fixture.services.identities);
  const held = await manager.acquire('registry');
  await assert.rejects(fixture.run(), kind('lease-busy'));
  assert.deepEqual(fixture.opens, []);
  held.release();
});
test('S51 T070 failed native tool output never reaches event records or dialogs', async () => {
  const fixture = desktopFixture();
  fixture.services.tool = async () => ({ code: 1, stdout: 'credential-sentinel', stderr: 'credential-sentinel' });
  let notified = '';
  fixture.services.notify = async value => {
    notified = value;
  };
  try {
    await fixture.run();
  } catch (error) {
    await fixture.engine.report(error, fixture.control);
  }
  assert.equal(notified.includes('credential-sentinel'), false);
  assert.equal(readFileSync(join(fixture.control, 'events.ndjson'), 'utf8').includes('credential-sentinel'), false);
});
test('T088 S07 compiler writes a stable identifier and synchronous script without running it', async () => {
  const fixture = desktopFixture();
  const stage = join(fixture.home, 'compile');
  fixture.io.directory(stage);
  const app = join(stage, 'Launcher.app');
  await compileLauncher(app, stage, 'curly “name”', fixture.profile.id, process.execPath,
    join(repo, 'dist/src/main.js'), join(fixture.control, 'catalog.json'), fixture.io, fixture.services);
  assert.match(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'), /LSUIElement<\/key><false\/>/);
  assert.deepEqual(fixture.opens, []);
});
test('T082 S27 S28 an interrupted refresh is recovered before an ordinary refresh', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const session = new CatalogSession(fixture.io, fixture.control);
  const profile = session.catalog.profiles[0]!;
  const transaction = ChangeRecord.begin(fixture.io, join(fixture.control, 'recovery'), [],
    session.inventory, profile.id);
  const backup = join(transaction.directory, 'Claude.app');
  transaction.allow(fixture.application);
  transaction.allow(backup);
  transaction.moveTree(fixture.application, backup, true, approveTree(fixture.application, fixture.io));
  const journal = join(dirname(fixture.application), 'refresh.json');
  fixture.io.write(journal, JSON.stringify({
    format: 'bcm-refresh/1', installationKey: session.catalog.installationKey, profileId: profile.id,
    operation: transaction.directory, phase: 'old-moved', applications: [backup],
  }), null);
  await fixture.run();
  assert.ok(existsSync(fixture.application));
  assert.equal(existsSync(journal), false);
  assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
});
test('T083 S30 earlier unrecognized staging is preserved for manual review', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  const unknown = join(dirname(fixture.application), 'unknown-stage/user-data');
  fixture.write(unknown, 'preserve');
  fixture.write(join(fixture.source, 'Contents/Info.plist'), '4.30.0');
  await fixture.run();
  assert.equal(readFileSync(unknown, 'utf8'), 'preserve');
});
test('S01 S07 Desktop-only add prepares verified resources without launching', async () => {
  const fixture = desktopFixture();
  const input = new PassThrough();
  input.end([fixture.source, '', '', 'n', 'none', 'y'].join('\n') + '\n');
  const output = new PassThrough();
  const code = await runFront(['add', 'new-desktop', '--target', 'desktop'], {
    env: fixture.env, io: fixture.io, input, output, tty: true, platform: 'darwin',
    services: { ...fixture.base.services, runtime: () => process.execPath, cli: join(repo, 'dist/src/main.js') },
    desktopServices: fixture.services,
  });
  assert.equal(code, 0);
  const profile = catalog(fixture.base).profiles.find(value => value.label === 'new-desktop')!;
  assert.ok(profile.desktop);
  assert.ok(existsSync(profile.desktop!.launcher));
  assert.equal(profile.code, null);
  assert.deepEqual(fixture.opens, []);
});
test('T066 T067 S40 native ps failures and flattened paths remain uncertain', async () => {
  const fixture = desktopFixture();
  const selected = fixture.profile.desktop!.location;
  for (const args of [
    '--user-data-dir=' + selected + ' with spaces',
    '--user-data-dir=' + selected + ' --user-data-dir=/other',
  ]) {
    const census = await desktopNativeCensus(async (file, arguments_) => {
      let stdout = '';
      if (file === '/usr/bin/plutil') {
        stdout = 'com.anthropic.claudefordesktop';
      } else if (arguments_.includes('lstart=')) {
        stdout = 'Thu Oct 29 10:00:00 2026';
      } else if (arguments_.includes('pid=,uid=,comm=')) {
        stdout = `101 ${fixture.io.guard.uid} ${fixture.application}/Contents/MacOS/Claude`;
      } else {
        stdout = `101 ${fixture.application}/Contents/MacOS/Claude ${args}`;
      }
      return { code: 0, stdout, stderr: '' };
    });
    assert.equal(desktopState(selected, fixture.process().executable, census, fixture.io.guard.uid).kind, 'unknown');
  }
  const failed = await desktopNativeCensus(async () => ({ code: 1, stdout: '', stderr: 'private-sentinel' }));
  assert.equal(failed.available, false);
  assert.equal(desktopState(selected, fixture.process().executable, failed, fixture.io.guard.uid).kind, 'unknown');
});
test('T092 S45 S46 S48 S49 public Desktop and Dock entry points share environment removals', async () => {
  const fixture = desktopFixture();
  const env = { ...fixture.env, ANTHROPIC_API_KEY: 'credential-sentinel',
    CLAUDE_CONFIG_DIR: '/wrong-code', GH_CONFIG_DIR: '/wrong-gh' };
  for (const args of [
    ['open-profile', fixture.profile.label],
    ['_dock-entry', fixture.profile.id, join(fixture.control, 'catalog.json')],
  ]) {
    const code = await runFront(args, {
      env, io: fixture.io, input: new PassThrough(), output: new PassThrough(), tty: false, platform: 'darwin',
      services: fixture.base.services, desktopServices: fixture.services,
    });
    assert.equal(code, 0);
    const launch = fixture.opens.at(-1)!;
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR']) {
      assert.equal(Object.hasOwn(launch.env, name), false);
    }
    assert.deepEqual(launch.env, executionEnvironment(fixture.profile, env));
  }
});
test('T093 S49 S51 launchd conflicts report names and unset remedies without credential values', async () => {
  const fixture = desktopFixture();
  fixture.services.launchdOverrides = async () => ['ANTHROPIC_API_KEY', 'unexpected-sentinel'];
  await assert.rejects(fixture.run(), kind('launchd-selection'));
  assert.match(fixture.messages.join('\n'), /launchctl unsetenv ANTHROPIC_API_KEY/);
  assert.equal(fixture.messages.join('\n').includes('unexpected-sentinel'), false);
  assert.deepEqual(fixture.opens, []);
});
test('T085 S05 last-moment verification failure blocks open after successful preparation', async () => {
  const fixture = desktopFixture();
  fixture.services.checkpoint = stage => {
    if (stage === 'desktop-before-open') {
      fixture.services.tool = async () => ({ code: 1, stdout: '', stderr: '' });
    }
  };
  await assert.rejects(fixture.run(), kind('claude-signature'));
  assert.deepEqual(fixture.opens, []);
});
test('T096 S38 a busy copy lock with no installed copy cannot recover or prepare one', async () => {
  const fixture = desktopFixture();
  const manager = new LeaseManager(join(fixture.control, 'leases'), fixture.io, fixture.services.identities);
  const gate = await manager.acquire('registry');
  const held = await manager.acquire(`profile-${fixture.profile.id}`);
  gate.release();
  try {
    await assert.rejects(fixture.run(), kind('desktop-contention'));
    assert.equal(existsSync(fixture.application), false);
    assert.equal(existsSync(join(fixture.control, 'recovery')), false);
    assert.deepEqual(fixture.opens, []);
  } finally {
    held.release();
  }
});
test('T149 S43 S44 graceful termination has a bounded wait and never escalates', async () => {
  const fixture = desktopFixture();
  await fixture.run();
  fixture.setProcesses([fixture.process(null)]);
  fixture.services.confirmWrong = async () => true;
  fixture.services.terminate = async process => {
    fixture.terminated.push(process.pid);
  };
  await assert.rejects(fixture.run(), kind('desktop-quit-wait'));
  assert.deepEqual(fixture.terminated, [101]);
  assert.equal(fixture.opens.length, 1);
});
test('T053 S29 S32 incomplete Desktop setup protects concurrent retained data in sibling rules', async () => {
  const fixture = desktopFixture();
  const sibling = installProfile(fixture.base, 'sibling');
  const data = join(fixture.data, 'partial/desktop');
  fixture.services.compile = async () => {
    fixture.write(join(data, 'user-change'), 'preserve');
    throw new Error('injected compiler failure');
  };
  const input = new PassThrough();
  input.end([fixture.source, '', '', 'n', 'none', 'y'].join('\n') + '\n');
  const status = await runFront(['add', 'partial', '--target', 'desktop'], {
    env: fixture.env, io: fixture.io, input, output: new PassThrough(), tty: true, platform: 'darwin',
    services: { ...fixture.base.services, runtime: () => process.execPath, cli: join(repo, 'dist/src/main.js') },
    desktopServices: fixture.services,
  });
  assert.equal(status, 74);
  assert.equal(readFileSync(join(data, 'user-change'), 'utf8'), 'preserve');
  const value = catalog(fixture.base);
  assert.equal(value.profiles.some(profile => profile.label === 'partial'), false);
  assert.ok(value.recoveryClaims.some(claim => claim.location === data));
  assert.ok(readFileSync(join(sibling.code!.location, 'settings.json'), 'utf8').includes(data));
});
test('T073 S02 candidate and installed application links are refused without following their targets', async () => {
  for (const contents of [false, true]) {
    const fixture = desktopFixture();
    fixture.services.copy = async (from, to) => {
      if (contents) {
        fixture.io.directory(to);
        symlinkSync(join(from, 'Contents'), join(to, 'Contents'));
      } else {
        symlinkSync(from, to);
      }
    };
    await assert.rejects(fixture.run());
    assert.equal(readFileSync(join(fixture.source, 'Contents/Info.plist'), 'utf8'), '4.29.0');
    assert.deepEqual(fixture.opens, []);
  }
  for (const contents of [false, true]) {
    const fixture = desktopFixture();
    await fixture.run();
    const path = contents ? join(fixture.application, 'Contents') : fixture.application;
    renameSync(path, path + '-kept');
    symlinkSync(path + '-kept', path);
    await assert.rejects(fixture.run());
    assert.equal(fixture.opens.length, 1);
    assert.ok(lstatSync(path).isSymbolicLink());
  }
});
