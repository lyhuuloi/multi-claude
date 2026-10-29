import { ChangeRecord } from '../src/change-records.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import {
  readFileSync,
  lstatSync,
  readdirSync,
  existsSync,
  symlinkSync,
  linkSync,
  renameSync,
  chmodSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { profileFixture, catalog, save, installProfile, invoke, addAnswers, repo } from './support.js';
import { executionEnvironment, authenticationOverrides, githubOverrides } from '../src/execution-policy.js';
import { editShell, shellBody, shellEntryFinding, stableNodePath } from '../src/shell-entries.js';
import { collectSetup } from '../src/setup-selection.js';
import { mapReference, migrateDocument } from '../src/reference-mapping.js';
import { expectedRules, synchronizeFences, auditFences, directorySpellings } from '../src/read-fences.js';
import { githubStorageFinding, githubGuidance } from '../src/github-configuration.js';
import { codeLiveness } from '../src/process-census.js';
import { validateReuse } from '../src/profile-actions.js';
import { Problem, Exit } from '../src/outcomes.js';
import { LeaseManager } from '../src/operation-leases.js';
import type { ProcessSnapshot } from '../src/process-census.js';
const kind = (name: string) => (error: unknown) => error instanceof Problem && error.kind === name;
function file(fixture: ReturnType<typeof profileFixture>, path: string, bytes: string): void {
  fixture.io.directory(dirname(path));
  fixture.io.write(path, bytes, fixture.io.snapshot(path));
}
function sync(fixture: ReturnType<typeof profileFixture>, value = catalog(fixture)) {
  const notices: string[] = [];
  const findings = synchronizeFences(value, fixture.control, fixture.io, (path, bytes) => {
    fixture.io.write(path, bytes, fixture.io.snapshot(path));
  }, profile => notices.push(profile.label));
  return { value, notices, findings };
}
test('S45 S46 S48 T089 subscription launches remove overrides and replace inherited selectors',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    const inherited: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/wrong', GH_CONFIG_DIR: '/wrong-gh', PATH: '/bin' };
    authenticationOverrides.forEach(name => {
      inherited[name] = 'synthetic-secret';
    });
    const selected = executionEnvironment(profile, inherited);
    authenticationOverrides.forEach(name => assert.equal(Object.hasOwn(selected, name), false));
    assert.equal(selected.CLAUDE_CONFIG_DIR, profile.code!.location);
    assert.equal(Object.hasOwn(selected, 'GH_CONFIG_DIR'), false);
    assert.equal(inherited.ANTHROPIC_API_KEY, 'synthetic-secret');
  });
test('S47 S48 S50 T090 T091 inheritance is explicit and private GitHub removes all token overrides',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    profile.credentialPolicy = 'inherit';
    profile.code!.github = join(profile.code!.location, 'github');
    const inherited: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: '/wrong', GH_CONFIG_DIR: '/wrong' };
    [...authenticationOverrides, ...githubOverrides].forEach(name => {
      inherited[name] = 'synthetic-secret';
    });
    const selected = executionEnvironment(profile, inherited);
    authenticationOverrides.forEach(name => assert.equal(selected[name], 'synthetic-secret'));
    githubOverrides.forEach(name => assert.equal(Object.hasOwn(selected, name), false));
    assert.equal(selected.GH_CONFIG_DIR, profile.code!.github);
    profile.code = null;
    const desktop = executionEnvironment(profile, inherited);
    assert.equal(Object.hasOwn(desktop, 'CLAUDE_CONFIG_DIR'), false);
    assert.equal(Object.hasOwn(desktop, 'GH_CONFIG_DIR'), false);
  });
test('S49 S51 T092 UUID and label execution agree, forward literal args and propagate child status',
  async () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    fixture.env.ANTHROPIC_API_KEY = 'never-print-this';
    fixture.services.start = (executable, args, env) => {
      fixture.launches.push({ file: executable, args, env });
      return { started: Promise.resolve(), completion: Promise.resolve(37) };
    };
    const tail = ['--model', 'literal;$(touch bad)', 'argument with spaces'];
    const label = await invoke(fixture, ['run-profile', 'studio', '--', ...tail]);
    const id = await invoke(fixture, ['run-profile', '--profile-id', profile.id, '--', ...tail]);
    assert.equal(label.code, 37);
    assert.equal(id.code, 37);
    assert.deepEqual(fixture.launches[0], fixture.launches[1]);
    assert.equal(fixture.launches[0]!.file, '/usr/local/bin/claude');
    assert.deepEqual(fixture.launches[0]!.args, tail);
    assert.equal(label.text.includes('never-print-this'), false);
    assert.match(label.text, /ANTHROPIC_API_KEY/);
  });
test('S37 S39 launch gate is held through child creation and released for the interactive session',
  async () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    let started!: () => void;
    let completed!: (code: number) => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => {
      entered = resolve;
    });
    fixture.services.start = () => {
      entered();
      return {
        started: new Promise<void>(resolve => {
          started = resolve;
        }),
        completion: new Promise<number>(resolve => {
          completed = resolve;
        }),
      };
    };
    const running = invoke(fixture, ['run-profile', '--profile-id', profile.id]);
    await ready;
    const manager = new LeaseManager(join(fixture.control, 'leases'), fixture.io, fixture.services.identities);
    await assert.rejects(manager.acquire('registry'), kind('lease-busy'));
    started();
    await new Promise(resolve => setImmediate(resolve));
    const gate = await manager.acquire('registry', 1000);
    gate.release();
    completed(0);
    assert.equal((await running).code, 0);
  });
for (const shell of ['zsh', 'bash', 'fish'] as const) {
  test(`S07 S49 T087 ${shell} entries invoke the UUID command through fixed absolute runtime paths`,
    () => {
      const fixture = profileFixture();
      const profile = installProfile(fixture);
      profile.code!.shell = shell;
      const body = shellBody(profile).toString('utf8');
      assert.match(body, /\/usr\/bin\/env -u NODE_OPTIONS -u NODE_PATH/);
      assert.match(body, /\/opt\/homebrew\/bin\/node/);
      assert.match(body, new RegExp(`run-profile --profile-id '${profile.id}' --`));
      assert.equal(body.includes(profile.code!.location), false);
      assert.ok(body.includes(shell === 'fish' ? '$argv' : '"$@"'));
    });
}
test('S13 S27 shell editing preserves binary outside bytes, CRLF and an absent final newline',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    const prefix = Buffer.concat([Buffer.from([0xff]), Buffer.from(' outside\r\nlast-line')]);
    const inserted = editShell(prefix, profile);
    assert.ok(inserted.subarray(0, prefix.length).equals(prefix));
    assert.equal(inserted.toString('latin1').replace(/\r\n/g, '').includes('\n'), false);
    assert.ok(editShell(inserted, profile, true).equals(prefix));
    assert.ok(editShell(inserted, profile).equals(inserted));
  });
test('T003 S13 malformed, nested, duplicate and stray shell markers cannot be edited',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    for (const text of [
      '# bcm-profile garbage\n', `# bcm-profile ${profile.id} end\n`,
      `# bcm-profile ${profile.id} begin 0\n`,
      editShell(Buffer.alloc(0), profile).toString().repeat(2),
    ]) {
      assert.throws(() => editShell(Buffer.from(text), profile), kind('shell-markers'));
    }
  });
test('S13 unmanaged definitions cannot be shadowed even when another managed UUID block exists',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    const prior = editShell(Buffer.from('work() { echo existing; }\n'), profile);
    profile.code!.command = 'work';
    assert.throws(() => editShell(prior, profile), kind('shell-shadow'));
  });
test('T087 shell quoting keeps apostrophes, punctuation and arguments literal and clears Node injection variables',
  () => {
    const fixture = profileFixture();
    const profile = installProfile(fixture);
    const entry = join(fixture.home, "entry 'quoted'.cjs");
    file(fixture, entry,
      'console.log(JSON.stringify([process.argv.slice(2),process.env.NODE_OPTIONS,process.env.NODE_PATH]));');
    profile.code!.runtime = process.execPath;
    profile.code!.cli = entry;
    const rc = join(fixture.home, 'quote.zsh');
    file(fixture, rc, shellBody(profile).toString());
    const child = spawnSync('/bin/zsh', ['-f', '-c', "source \"$1\"; claude-studio 'a;$(literal)'", 'zsh', rc], {
      env: { ...fixture.env, NODE_OPTIONS: '--invalid-option', NODE_PATH: 'untrusted' },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    const [args, options, path] = JSON.parse(child.stdout);
    assert.deepEqual(args, ['run-profile', '--profile-id', profile.id, '--', 'a;$(literal)']);
    assert.equal(options, null);
    assert.equal(path, null);
  });
test('S72 stable Node discovery prefers an exposed symlink over a version-specific path',
  () => {
    const fixture = profileFixture();
    const stable = join(fixture.home, 'bin');
    fixture.io.directory(stable);
    symlinkSync(process.execPath, join(stable, 'node'));
    const selected = stableNodePath(process.execPath, stable);
    assert.ok(!selected.includes('/Cellar/'));
  });
test('T100 T101 T102 S52 S54 import includes only approved setup and only mcpServers from user state',
  () => {
    const fixture = profileFixture();
    const source = join(fixture.home, '.claude');
    for (const name of ['settings.json', 'keybindings.json', 'CLAUDE.md']) {
      file(fixture, join(source, name), name.endsWith('.json') ? '{}' : 'instructions');
    }
    for (const directory of ['skills', 'commands', 'agents', 'hooks', 'output-styles']) {
      file(fixture, join(source, directory, 'approved.txt'), 'setup');
    }
    for (const name of ['installed_plugins.json', 'known_marketplaces.json', 'config.json', 'blocklist.json']) {
      file(fixture, join(source, 'plugins', name), '{}');
    }
    for (const directory of ['cache', 'marketplaces', 'repos']) {
      file(fixture, join(source, 'plugins', directory, 'approved.txt'), 'setup');
    }
    for (const name of ['credentials.json', 'history.jsonl', 'projects/a', 'sessions/a',
      'future/a', 'plugins/data/a']) {
      file(fixture, join(source, name), 'account-sentinel');
    }
    file(fixture, join(fixture.home, '.claude.json'), JSON.stringify({
      mcpServers: { synthetic: { command: 'example' } },
      account: 'account-sentinel',
      projects: {},
      usage: 'private',
    }));
    const selected = collectSetup(fixture.home, join(fixture.data, 'new/code'), fixture.io);
    assert.equal(selected.files.size, 16);
    assert.ok([...selected.files.keys()].every(name =>
      !/credentials|history|projects|sessions|future|data\//.test(name)));
    assert.deepEqual(JSON.parse(selected.files.get('.claude.json')!.toString()), {
      mcpServers: { synthetic: { command: 'example' } },
    });
  });
test('T103 T104 S53 stripped setup helpers and environment values never enter reports',
  async () => {
    const fixture = profileFixture();
    const source = join(fixture.home, '.claude');
    const names = [
      'apiKeyHelper',
      'awsCredentialExport',
      'awsAuthRefresh',
      'otelHeadersHelper',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'ANTHROPIC_BASE_URL',
    ];
    const value: Record<string, unknown> = Object.fromEntries(names.map(name => [name, 'secret-sentinel']));
    value.env = {
      API_KEY: 'secret-sentinel',
      token: 'secret-sentinel',
      SECRET: 'secret-sentinel',
      password: 'secret-sentinel',
      headers: 'secret-sentinel',
      SAFE: 'keep',
      ANTHROPIC_BASE_URL: 'secret-sentinel',
    };
    file(fixture, join(source, 'settings.json'), JSON.stringify(value));
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'y', 'y']);
    assert.equal(result.code, 0, result.text);
    assert.equal(result.text.includes('secret-sentinel'), false);
    names.forEach(name => assert.ok(result.text.includes(name)));
    const settings = JSON.parse(readFileSync(join(catalog(fixture).profiles[0]!.code!.location,
      'settings.json'), 'utf8'));
    assert.deepEqual(settings.env, { SAFE: 'keep' });
    names.forEach(name => assert.equal(Object.hasOwn(settings, name), false));
  });
test('T105 S12 S56 import rejects linked entries and never shares baseline setup', () => {
  for (const hard of [false, true]) {
    const fixture = profileFixture();
    const target = join(fixture.home, 'unrelated');
    file(fixture, target, 'private');
    fixture.io.directory(join(fixture.home, '.claude'));
    const selected = join(fixture.home, '.claude/CLAUDE.md');
    if (hard) {
      linkSync(target, selected);
    } else {
      symlinkSync(target, selected);
    }
    assert.throws(() => collectSetup(fixture.home, join(fixture.data, 'new/code'), fixture.io));
    assert.equal(readFileSync(target, 'utf8'), 'private');
  }
});
test('T106 T107 S55 declined import ignores incomplete records and arbitrary alternate source paths',
  async () => {
    const fixture = profileFixture();
    file(fixture, join(fixture.home, '.claude/CLAUDE.md'), 'baseline setup');
    file(fixture, join(fixture.control, 'recovery/unrecognized/seed.json'), JSON.stringify({
      source: '/not-approved'
    }));
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'n', 'y']);
    assert.equal(result.code, 0, result.text);
    const profile = catalog(fixture).profiles[0]!;
    assert.equal(existsSync(join(profile.code!.location, 'CLAUDE.md')), false);
    assert.equal(readFileSync(join(fixture.home, '.claude/CLAUDE.md'), 'utf8'), 'baseline setup');
  });
test('T108 T109 S28 malformed selected JSON never registers a surface or replaces prior rc bytes',
  async () => {
    const fixture = profileFixture();
    file(fixture, join(fixture.home, '.claude/settings.json'), '{malformed');
    file(fixture, join(fixture.home, '.zshrc'), '# user bytes\n');
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'y', 'y']);
    assert.equal(result.code, Exit.refusal);
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.equal(readFileSync(join(fixture.home, '.zshrc'), 'utf8'), '# user bytes\n');
    assert.equal(existsSync(join(fixture.data, 'studio/code')), false);
  });
test('T110 S58 migrations respect exact root boundaries, home forms and designated settings subtrees',
  () => {
    const mapping = {
      source: '/Users/demo/.claude',
      destination: '/Users/demo/profiles/new/code',
      home: '/Users/demo',
      required: true,
      warn: () => {
      },
    };
    const input = {
      hooks: ['~/包',
        '~/.claude/hooks/a',
        '$HOME/.claude/hooks/a',
        '${HOME}/.claude/hooks/a',
        '/Users/demo/.claude/hooks/a',
        '/Users/demo/.claude-other/hooks/a'],
      statusLine: { command: 'cat ~/.claude/CLAUDE.md' },
      claudeMdExcludes: ['~/.claude/private'],
      unrelated: '/Users/demo/.claude/hooks/a',
    };
    const result = migrateDocument('settings.json', input, mapping) as typeof input;
    assert.deepEqual(result.hooks, [
      '~/包', '~/profiles/new/code/hooks/a', '$HOME/profiles/new/code/hooks/a', '${HOME}/profiles/new/code/hooks/a',
      '/Users/demo/profiles/new/code/hooks/a', '/Users/demo/.claude-other/hooks/a',
    ]);
    assert.deepEqual(result.claudeMdExcludes, input.claudeMdExcludes);
    assert.equal(result.unrelated, input.unrelated);
  });
test('T111 T112 S57 home-relative suffix guards permit spaces in HOME and reject newly inserted shell syntax',
  () => {
    const safe = {
      source: '/Users/First Last/.claude',
      destination: '/Users/First Last/profiles/new/code',
      home: '/Users/First Last',
      required: true,
      warn: () => {
      },
    };
    assert.equal(mapReference('$HOME/.claude/hooks/a', true, safe), '$HOME/profiles/new/code/hooks/a');
    for (const suffix of ['has space', 'quote\'x', 'back`tick', '$(command)', 'semi;colon', 'glob*', 'escape\\x']) {
      assert.throws(() => mapReference('~/.claude/hooks/a', true, {
        ...safe,
        destination: safe.home + '/profiles/' + suffix,
      }), kind('mapping-command'));
    }
    const warnings: string[] = [];
    assert.equal(mapReference('~/.claude/hooks/a', true, {
      ...safe,
      destination: safe.home + '/unsafe suffix',
      required: false,
      warn: value => warnings.push(value),
    }), '~/.claude/hooks/a');
    assert.equal(warnings.length, 1);
  });
test('T113 T114 S58 plugin data paths allow spaces and seeding rebases only copied destinations',
  () => {
    const mapping = {
      source: '/Users/demo/.claude',
      destination: '/Users/demo/new profile/code',
      home: '/Users/demo',
      required: false,
      warn: () => {
      },
    };
    const value = migrateDocument('plugins/installed_plugins.json', {
      path: '/Users/demo/.claude/plugins/cache/a'
    }, mapping);
    assert.deepEqual(value, { path: '/Users/demo/new profile/code/plugins/cache/a' });
    assert.equal(mapReference('/Users/demo/.claude/unselected', false, { ...mapping, copied: () => false }),
      '/Users/demo/.claude/unselected');
  });
test('T120 T121 T122 S59 S60 read rules cover every sibling surface, control and recovery spellings',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const sibling = installProfile(fixture, 'other');
    const value = catalog(fixture);
    const desktop = value.profiles.find(profile => profile.id === sibling.id)!;
    desktop.desktop = {
      location: '/Users/synthetic/desktop',
      source: '/Applications/Claude.app',
      launcher: '/Users/synthetic/Entry.app',
      tint: 'none',
      updateMode: 'launcher',
      defaultLocation: false,
      defaultLauncher: false,
    };
    value.recoveryClaims.push({
      operationId: randomUUID(),
      profileId: own.id,
      location: '/Users/synthetic/recovery'
    });
    const rules = expectedRules(value, own, fixture.control);
    for (const root of [sibling.code!.location, desktop.desktop.location, desktop.desktop.location + '-3p',
      fixture.control, '/Users/synthetic/recovery']) {
      for (const spelling of directorySpellings(root)) {
        assert.ok(rules.includes(`Read(/${spelling})`));
        assert.ok(rules.includes(`Read(/${spelling}/**)`));
      }
    }
    assert.ok(rules.includes('Read(//System/Volumes/Data/Users/synthetic/desktop-3p/**)'));
    assert.equal(rules.includes(`Read(/${own.code!.location}/**)`), false);
    assert.equal(rules.includes(`Read(/${fixture.data}/**)`), false);
  });
test('T123 T125 T126 S61 S67 retired kept folders stay denied while identical user rules remain unclaimed',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const value = catalog(fixture);
    const retired = join(fixture.home, 'retired');
    fixture.io.directory(retired);
    value.releasedLocations.push({
      id: randomUUID(),
      location: retired,
      role: 'code',
      formerProfileId: randomUUID(),
      formerLabel: 'former',
      retiredAt: new Date().toISOString(),
      reason: 'kept',
      reusedBy: null,
    });
    const userRule = `Read(/${fixture.control})`;
    file(fixture, join(own.code!.location, 'settings.json'), JSON.stringify({
      permissions: { deny: [userRule, 'Read(//personal/**)'], allow: ['Bash(echo *)'] },
      theme: 'user',
    }));
    const first = sync(fixture, value);
    assert.deepEqual(first.findings, []);
    assert.equal(first.value.ruleClaims[0]!.rules.includes(userRule), false);
    assert.ok(first.value.ruleClaims[0]!.rules.includes(`Read(/${retired}/**)`));
    value.fencePolicy = 'disabled';
    const disabled = sync(fixture, value);
    const after = JSON.parse(readFileSync(join(own.code!.location, 'settings.json'), 'utf8'));
    assert.deepEqual(after.permissions.deny, [userRule, 'Read(//personal/**)']);
    assert.deepEqual(after.permissions.allow, ['Bash(echo *)']);
    assert.equal(after.theme, 'user');
    assert.equal(disabled.value.ruleClaims.length, 0);
    assert.deepEqual(disabled.notices, ['studio']);
  });
test('T127 S62 malformed, linked, hard-linked and substituted settings roots produce findings without overwrite',
  () => {
    for (const variation of ['malformed', 'structure', 'link', 'hard-link', 'root']) {
      const fixture = profileFixture();
      const own = installProfile(fixture);
      const path = join(own.code!.location, 'settings.json');
      if (variation === 'malformed') {
        file(fixture, path, '{broken');
      } else if (variation === 'structure') {
        file(fixture, path, '{"permissions":{"deny":"wrong"}}');
      } else if (variation === 'root') {
        renameSync(own.code!.location, own.code!.location + '-old');
        fixture.io.directory(own.code!.location);
        file(fixture, path, '{"user":"replacement"}');
      } else {
        const target = join(fixture.home, 'user-settings');
        file(fixture, target, '{"user":"keep"}');
        if (variation === 'link') {
          symlinkSync(target, path);
        } else {
          linkSync(target, path);
        }
      }
      const before = readFileSync(path);
      const result = sync(fixture);
      assert.equal(result.findings.length, 1, variation);
      assert.deepEqual(readFileSync(path), before, variation);
    }
  });
test('T128 S62 unsafe legacy paths are visible coverage findings rather than literal read patterns',
  () => {
    const fixture = profileFixture();
    installProfile(fixture);
    const other = installProfile(fixture, 'other');
    const value = catalog(fixture);
    value.profiles.find(profile => profile.id === other.id)!.code!.location = '/unsafe[pattern]';
    const result = sync(fixture, value);
    assert.ok(result.findings.length > 0);
    assert.equal(result.value.ruleClaims.some(claim => claim.rules.some(rule => rule.includes('[pattern]'))),
      false);
  });
test('T129 T130 S27 S63 synchronization is byte-idempotent and its post-audit detects residual drift',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const first = sync(fixture);
    const path = join(own.code!.location, 'settings.json');
    const before = lstatSync(path, { bigint: true });
    const again = sync(fixture, first.value);
    assert.deepEqual(again.notices, []);
    assert.equal(lstatSync(path, { bigint: true }).mtimeNs, before.mtimeNs);
    const value = catalog(fixture);
    const findings = synchronizeFences(value, fixture.control, fixture.io, (target, bytes) => {
      fixture.io.write(target, bytes, fixture.io.snapshot(target));
      fixture.io.write(target, '{}', fixture.io.snapshot(target));
    }, () => {
    });
    // Force another required rule so the injected write path is actually exercised.
    if (!findings.length) {
      value.recoveryClaims.push({ operationId: randomUUID(), profileId: own.id, location: '/Users/synthetic/new' });
      const injected = synchronizeFences(value, fixture.control, fixture.io, (target, bytes) => {
        fixture.io.write(target, bytes, fixture.io.snapshot(target));
        fixture.io.write(target, '{}', fixture.io.snapshot(target));
      }, () => {
      });
      assert.equal(injected.length, 1);
    } else {
      assert.equal(findings.length, 1);
    }
  });
test('T131 T152 T153 S63 rule additions, removals and later session overwrites stay visible',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const added = await invoke(fixture, ['doctor', '--apply']);
    assert.equal(added.code, 0, added.text);
    assert.match(added.text, /Restart running or uncertain Code sessions/);
    assert.match(added.text, /does not establish enforcement/);
    const value = catalog(fixture);
    value.fencePolicy = 'disabled';
    save(fixture, value);
    const removed = await invoke(fixture, ['doctor', '--apply']);
    assert.match(removed.text, /Restart running or uncertain Code sessions/);
    const enabled = catalog(fixture);
    enabled.fencePolicy = 'enabled';
    save(fixture, enabled);
    await invoke(fixture, ['doctor', '--apply']);
    file(fixture, join(own.code!.location, 'settings.json'), '{}');
    const doctor = await invoke(fixture, ['doctor']);
    assert.equal(doctor.code, Exit.findings);
    assert.match(doctor.text, /Read rules need synchronization/);
  });
test('S50 S51 private gh guidance specifies plaintext login and warns about keyring-backed hosts',
  () => {
    const fixture = profileFixture();
    const location = join(fixture.home, "github 'quoted'");
    file(fixture, join(location, 'hosts.yml'), 'github.example:\n    user: synthetic\n    git_protocol: https\n');
    assert.match(githubStorageFinding(location, fixture.io)!, /shared Keychain/);
    file(fixture, join(location, 'hosts.yml'), 'github.example:\n    oauth_token: ghp_synthetic\n');
    assert.equal(githubStorageFinding(location, fixture.io), null);
    file(fixture, join(location, 'hosts.yml'), 'github.example: { user: unknown }\n');
    assert.match(githubStorageFinding(location, fixture.io)!, /unknown/);
    const guidance = githubGuidance(location).join('\n');
    assert.match(guidance, /--insecure-storage/);
    assert.match(guidance, /plaintext/);
    assert.equal(guidance.includes('ghp_synthetic'), false);
  });
test('S41 S42 T061 T064 T065 exact Code selectors identify ancestors without confusing alias words',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const process: ProcessSnapshot = {
      pid: 100,
      uid: fixture.io.guard.uid,
      executable: '/usr/local/bin/claude',
      environment: { CLAUDE_CONFIG_DIR: own.code!.location },
      argv: [],
    };
    assert.deepEqual(codeLiveness(own, { available: true, processes: [process] }, fixture.io.guard.uid, 100),
      { state: 'idle', pids: [] });
    assert.deepEqual(codeLiveness(own, { available: true, processes: [process] }, fixture.io.guard.uid, 101),
      { state: 'active', pids: [100] });
    process.environment = {};
    process.executable = '/opt/homebrew/bin/node';
    process.argv = [join(repo, 'dist/src/main.js'), 'run-profile', 'claude-studio'];
    assert.equal(codeLiveness(own, {
      available: true,
      processes: [process]
    }, fixture.io.guard.uid, 101).state, 'idle');
  });
test('S40 S41 T066 T067 failures, unreadable candidates, spaces and prefix-related selectors never prove false idle',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    own.code!.location = join(fixture.home, 'profile with spaces');
    assert.equal(codeLiveness(own, { available: false, processes: [] }, fixture.io.guard.uid, 101).state, 'unknown');
    const process: ProcessSnapshot = {
      pid: 100,
      uid: fixture.io.guard.uid,
      executable: '/usr/local/bin/claude',
      environment: null,
      argv: [],
    };
    assert.equal(codeLiveness(own, {
      available: true,
      processes: [process]
    }, fixture.io.guard.uid, 101).state, 'unknown');
    process.environment = { CLAUDE_CONFIG_DIR: own.code!.location };
    assert.equal(codeLiveness(own, {
      available: true,
      processes: [process]
    }, fixture.io.guard.uid, 101).state, 'active');
    process.environment.CLAUDE_CONFIG_DIR += '-longer';
    assert.equal(codeLiveness(own, {
      available: true,
      processes: [process]
    }, fixture.io.guard.uid, 101).state, 'active');
  });
test('S27 S31 Code add commits completed resources and retains no operation backups', async () => {
  const fixture = profileFixture();
  const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
  assert.equal(result.code, 0, result.text);
  const value = catalog(fixture);
  assert.equal(value.profiles.length, 1);
  const own = value.profiles[0]!;
  assert.equal(own.code!.location, join(fixture.data, 'studio/code'));
  assert.equal(own.code!.command, 'claude-studio');
  assert.equal(own.desktop, null);
  assert.ok(readFileSync(own.code!.rc, 'utf8').includes(own.id));
  assert.deepEqual(value.recoveryClaims, []);
  assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
  assert.deepEqual(auditFences(value, fixture.control, fixture.io), []);
  assert.equal((await invoke(fixture, ['status', 'studio'])).code, 0);
});
test('T005 T006 non-TTY and refused Code plans do not create profiles or shell entries',
  async () => {
    const fixture = profileFixture();
    assert.equal((await invoke(fixture, ['add', 'studio', '--target', 'terminal'])).code,
      Exit.usage);
    const declined = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'n']);
    assert.equal(declined.code, 0, declined.text);
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.equal(existsSync(join(fixture.data, 'studio/code')), false);
    assert.equal(existsSync(join(fixture.home, '.zshrc')), false);
  });
test('S25 adoption is explicit, preserves modes and content, and never seeds over existing setup',
  async () => {
    const fixture = profileFixture();
    const root = join(fixture.data, 'studio/code');
    file(fixture, join(root, 'user-data'), 'preserve');
    chmodSync(root, 0o755);
    file(fixture, join(fixture.home, '.claude/CLAUDE.md'), 'do not import');
    const refused = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'n']);
    assert.equal(refused.code, 0);
    assert.equal(catalog(fixture).profiles.length, 0);
    const accepted = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['',
      '', '', '', '', 'y', 'y']);
    assert.equal(accepted.code, 0, accepted.text);
    assert.equal(readFileSync(join(root, 'user-data'), 'utf8'), 'preserve');
    assert.equal(lstatSync(root).mode & 0o777, 0o755);
    assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  });
test('S50 enabling gh on an existing Code profile updates its catalog and both token selectors',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    fixture.services.executables = name => name === 'gh' ? ['/usr/local/bin/gh'] : ['/usr/local/bin/claude'];
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['y', 'y']);
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /--insecure-storage/);
    const selected = catalog(fixture).profiles[0]!;
    assert.equal(selected.id, own.id);
    assert.equal(selected.code!.github, join(own.code!.location, 'github'));
    assert.equal(lstatSync(selected.code!.github!).mode & 0o777, 0o700);
    fixture.env.GH_TOKEN = 'synthetic-token';
    const run = await invoke(fixture, ['run-profile', '--profile-id', own.id]);
    assert.equal(run.code, 0);
    assert.equal(fixture.launches[0]!.env.GH_CONFIG_DIR, selected.code!.github);
    assert.equal(Object.hasOwn(fixture.launches[0]!.env, 'GH_TOKEN'), false);
  });
test('T146 shell status uses its recorded rc and meaningful entry time, never unrelated rc mtime',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    assert.equal(shellEntryFinding(own, fixture.io, Date.now() + 10000), null);
    const prior = readFileSync(own.code!.rc);
    file(fixture, own.code!.rc, prior.toString() + '# unrelated edit\n');
    assert.equal(shellEntryFinding(own, fixture.io, Date.now() + 10000), null);
    assert.match(shellEntryFinding(own, fixture.io, 0)!, /Reload/);
    assert.match(shellEntryFinding(own, fixture.io, null)!, /unknown/);
  });
test('T124 T141 S24 S58 Code rename preserves UUID and files, migrates only eligible paths and retires old locations',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    file(fixture, join(own.code!.location, 'user-data'), 'keep this');
    file(fixture, join(own.code!.location, 'settings.json'), JSON.stringify({
      statusLine: { command: 'cat $HOME/.local/share/ben-claude-multi/studio/code/CLAUDE.md' },
      claudeMdExcludes: [own.code!.location],
      unrelated: own.code!.location,
    }));
    const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, 0, result.text);
    const value = catalog(fixture);
    const renamed = value.profiles[0]!;
    assert.equal(renamed.id, own.id);
    assert.equal(renamed.code!.command, 'claude-work');
    assert.equal(existsSync(own.code!.location), false);
    assert.equal(readFileSync(join(renamed.code!.location, 'user-data'), 'utf8'), 'keep this');
    const settings = JSON.parse(readFileSync(join(renamed.code!.location, 'settings.json'),
      'utf8'));
    assert.ok(settings.statusLine.command.includes('/work/code/'));
    assert.deepEqual(settings.claudeMdExcludes, [own.code!.location]);
    assert.equal(settings.unrelated, own.code!.location);
    assert.ok(value.releasedLocations.some(record => record.location === own.code!.location));
    assert.match(result.text, /reauthentication/);
    assert.equal((await invoke(fixture, ['run-profile', '--profile-id', own.id])).code, 0);
    assert.equal(fixture.launches[0]!.env.CLAUDE_CONFIG_DIR, renamed.code!.location);
  });
test('S25 custom intent remains explicit even when paths or command names resemble generated defaults',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const value = catalog(fixture);
    value.profiles[0]!.code!.defaultLocation = false;
    value.profiles[0]!.code!.defaultCommand = false;
    save(fixture, value);
    const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, 0, result.text);
    assert.equal(catalog(fixture).profiles[0]!.code!.location, own.code!.location);
    assert.equal(catalog(fixture).profiles[0]!.code!.command, 'claude-studio');
  });
test('T141 S13 S57 rename preflights shell collisions and unsafe required command insertions',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    file(fixture, own.code!.rc, readFileSync(own.code!.rc, 'utf8') + 'claude-work() { echo unmanaged; }\n');
    const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, Exit.refusal);
    assert.ok(existsSync(own.code!.location));
    assert.equal(catalog(fixture).profiles[0]!.label, 'studio');
  });
for (const stage of ['rename-staged', 'rename-moved', 'rename-shell', 'rename-fences']) {
  test(`T142 S27 S28 S31 failure at ${stage} restores owned results and discards pre-images`,
    async () => {
      const fixture = profileFixture();
      const own = installProfile(fixture);
      const before = readFileSync(own.code!.rc);
      fixture.services.checkpoint = at => {
        if (at === stage) {
          throw new Error('injected failure');
        }
      };
      const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
      assert.equal(result.code, Exit.failure, result.text);
      assert.ok(existsSync(own.code!.location));
      assert.equal(existsSync(join(fixture.data, 'work/code')), false);
      assert.deepEqual(readFileSync(own.code!.rc), before);
      assert.equal(catalog(fixture).profiles[0]!.label, 'studio');
      assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
    });
}
test('T051 S27 S29 S32 a concurrent rc edit survives failed rename with private cataloged recovery',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const sibling = installProfile(fixture, 'other');
    fixture.services.checkpoint = stage => {
      if (stage === 'rename-shell') {
        file(fixture, own.code!.rc, '# concurrent user edit\n');
        throw new Error('injected failure');
      }
    };
    const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, Exit.recovery, result.text);
    assert.equal(readFileSync(own.code!.rc, 'utf8'), '# concurrent user edit\n');
    const value = catalog(fixture);
    assert.ok(value.recoveryClaims.length > 0);
    const recovery = value.recoveryClaims.find(claim => claim.location.includes('/recovery/'))!.location;
    assert.equal(lstatSync(recovery).mode & 0o777, 0o700);
    assert.ok(readdirSync(recovery).some(name => name.startsWith('prior-')));
    const rules = JSON.parse(readFileSync(join(sibling.code!.location, 'settings.json'),
      'utf8')).permissions.deny;
    assert.ok(rules.includes(`Read(/${fixture.control}/**)`));
  });
test('T053 S29 S30 changed moved data is retained and protected rather than erased during rollback',
  async () => {
    const fixture = profileFixture();
    installProfile(fixture);
    const sibling = installProfile(fixture, 'other');
    const destination = join(fixture.data, 'work/code');
    fixture.services.checkpoint = stage => {
      if (stage === 'rename-moved') {
        file(fixture, join(destination, 'concurrent'), 'preserve');
        throw new Error('injected failure');
      }
    };
    const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(result.code, Exit.recovery, result.text);
    assert.equal(readFileSync(join(destination, 'concurrent'), 'utf8'), 'preserve');
    const value = catalog(fixture);
    assert.ok(value.recoveryClaims.some(claim => claim.location === destination));
    const rules = JSON.parse(readFileSync(join(sibling.code!.location, 'settings.json'),
      'utf8')).permissions.deny;
    assert.ok(rules.includes(`Read(/${destination}/**)`));
  });
test('T007 S28 S31 SIGINT during Code mutation rolls back and returns interruption status',
  async () => {
    const fixture = profileFixture();
    fixture.services.checkpoint = stage => {
      if (stage === 'add-shell') {
        process.emit('SIGINT');
      }
    };
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
    assert.equal(result.code, Exit.interrupted, result.text);
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.equal(existsSync(join(fixture.data, 'studio/code')), false);
    assert.equal(existsSync(join(fixture.home, '.zshrc')), false);
    assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
  });
test('T068 T069 S40 S43 sessions starting during staging block moves while overrides retain identity checks',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    let active = false;
    fixture.services.checkpoint = stage => {
      active ||= stage === 'rename-staged';
    };
    fixture.services.census = async () => ({
      available: true,
      processes: active ? [{
        pid: 100,
        uid: fixture.io.guard.uid,
        executable: '/usr/local/bin/claude',
        argv: [],
        environment: { CLAUDE_CONFIG_DIR: own.code!.location },
      }] : [],
    });
    const blocked = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
    assert.equal(blocked.code, Exit.refusal, blocked.text);
    assert.ok(existsSync(own.code!.location));
    const overridden = await invoke(fixture, ['rename', 'studio', 'work', '--ignore-process-check'],
      ['y']);
    assert.equal(overridden.code, 0, overridden.text);
    assert.match(overridden.text, /Process override/);
  });
test('T143 S24 S67 removal keeps user data by default, retires it and denies it from remaining profiles',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const sibling = installProfile(fixture, 'other');
    await invoke(fixture, ['doctor', '--apply']);
    file(fixture, join(own.code!.location, 'user-data'), 'keep');
    const result = await invoke(fixture, ['remove', 'studio'], ['', 'y']);
    assert.equal(result.code, 0, result.text);
    assert.equal(readFileSync(join(own.code!.location, 'user-data'), 'utf8'), 'keep');
    const value = catalog(fixture);
    assert.equal(value.profiles.length, 1);
    assert.ok(value.releasedLocations.some(record =>
      record.location === own.code!.location && record.reason === 'kept'));
    const rules = JSON.parse(readFileSync(join(sibling.code!.location, 'settings.json'),
      'utf8')).permissions.deny;
    assert.ok(rules.includes(`Read(/${own.code!.location}/**)`));
    assert.equal(readFileSync(own.code!.rc, 'utf8').includes(own.id), false);
    assert.equal((await invoke(fixture, ['run-profile', '--profile-id', own.id])).code, Exit.refusal);
  });
test('T143 T144 S24 S31 approved Code deletion is staged and gh logout guidance precedes deletion',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const value = catalog(fixture);
    value.profiles[0]!.code!.github = join(own.code!.location, 'github');
    fixture.io.directory(value.profiles[0]!.code!.github!);
    save(fixture, value);
    file(fixture, join(own.code!.location, 'user-data'), 'delete only this owned data');
    const result = await invoke(fixture, ['remove', 'studio'], ['y', 'y']);
    assert.equal(result.code, 0, result.text);
    assert.ok(result.text.indexOf('gh auth logout') < result.text.indexOf('Delete this profile'));
    assert.match(result.text, /Keychain entries are left untouched/);
    assert.equal(existsSync(own.code!.location), false);
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.ok(catalog(fixture).releasedLocations.some(record => record.reason === 'deleted'));
    assert.deepEqual(readdirSync(join(fixture.control, 'recovery')), []);
  });
test('S26 substituted Code root links require separate unlink-only consent and preserve registration',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const target = join(fixture.home, 'unrelated');
    file(fixture, join(target, 'private'), 'keep');
    renameSync(own.code!.location, own.code!.location + '-old');
    symlinkSync(target, own.code!.location);
    const declined = await invoke(fixture, ['remove', 'studio'], ['n']);
    assert.equal(declined.code, 0);
    assert.ok(lstatSync(own.code!.location).isSymbolicLink());
    const accepted = await invoke(fixture, ['remove', 'studio'], ['y']);
    assert.equal(accepted.code, 0, accepted.text);
    assert.equal(existsSync(own.code!.location), false);
    assert.equal(catalog(fixture).profiles[0]!.id, own.id);
    assert.equal(readFileSync(join(target, 'private'), 'utf8'), 'keep');
  });
test('T032 T033 S67 reuse confirmation is tied to exact paths and catalog serials', () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const value = catalog(fixture);
  const record = {
    id: randomUUID(),
    location: join(fixture.data, 'former/code'),
    role: 'code' as const,
    formerProfileId: own.id,
    formerLabel: 'studio',
    retiredAt: new Date().toISOString(),
    reason: 'deleted' as const,
    reusedBy: null,
  };
  value.releasedLocations.push(record);
  const consent = { serial: value.serial, location: record.location, retirementIds: [record.id] };
  assert.doesNotThrow(() => validateReuse(value, record.location, consent));
  value.serial++;
  assert.throws(() => validateReuse(value, record.location, consent), kind('retired-consent'));
  assert.throws(() => validateReuse(value, record.location, {
    ...consent,
    serial: value.serial,
    location: '/wrong'
  }),
    kind('retired-consent'));
});
test('T032 S59 S67 retired reuse defaults to refusal and accepted reuse excludes the new owner only',
  async () => {
    const fixture = profileFixture();
    const former = installProfile(fixture);
    const sibling = installProfile(fixture, 'other');
    await invoke(fixture, ['remove', 'studio'], ['n', 'y']);
    const refused = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['',
      '', '', '', '', 'y', 'n']);
    assert.equal(refused.code, 0, refused.text);
    assert.equal(catalog(fixture).profiles.some(profile => profile.label === 'studio'), false);
    const accepted = await invoke(fixture, ['add', 'studio', '--target', 'terminal'],
      ['', '', '', '', '', 'y', 'y', 'y']);
    assert.equal(accepted.code, 0, accepted.text);
    const value = catalog(fixture);
    const own = value.profiles.find(profile => profile.label === 'studio')!;
    assert.notEqual(own.id, former.id);
    assert.ok(value.releasedLocations.some(record => record.reusedBy === own.id));
    assert.equal(expectedRules(value, own, fixture.control).includes(`Read(/${own.code!.location}/**)`),
      false);
    const other = value.profiles.find(profile => profile.id === sibling.id)!;
    assert.ok(expectedRules(value, other, fixture.control).includes(`Read(/${own.code!.location}/**)`));
  });
test('S72 the runner exits nonzero when a nested boundary fails without explicit outer-sandbox authorization', {
  skip: process.env.BCM_TEST_BOUNDARY !== 'outer-seatbelt' ? 'Requires the authorized outer sandbox.' : false,
}, () => {
  const fixture = profileFixture();
  const env = { ...fixture.env };
  delete env.BCM_TEST_OUTER_SANDBOX;
  const child = spawnSync(process.execPath, [join(repo, 'dist/scripts/run-tests.js')],
    { env, encoding: 'utf8', timeout: 10000, });
  assert.equal(child.status, Exit.unavailable);
  assert.match(child.stderr, /no tests ran/);
});
test('S27 T021 an rc edit during add staging is preserved instead of being overwritten by the preview',
  async () => {
    const fixture = profileFixture();
    const rc = join(fixture.home, '.zshrc');
    file(fixture, rc, '# original\n');
    fixture.services.checkpoint = stage => {
      if (stage === 'add-staged') {
        file(fixture, rc, '# concurrent\n');
      }
    };
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
    assert.equal(result.code, Exit.refusal, result.text);
    assert.equal(readFileSync(rc, 'utf8'), '# concurrent\n');
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.equal(existsSync(join(fixture.data, 'studio/code')), false);
  });
test('S27 T021 a migration source edited during rename staging is never overwritten', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const path = join(own.code!.location, 'settings.json');
  file(fixture, path, JSON.stringify({ hooks: { command: `cat ${own.code!.location}/CLAUDE.md` } }));
  fixture.services.checkpoint = stage => {
    if (stage === 'rename-staged') {
      file(fixture, path, '{"user":"concurrent"}');
    }
  };
  const result = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
  assert.equal(result.code, Exit.refusal, result.text);
  assert.equal(readFileSync(path, 'utf8'), '{"user":"concurrent"}');
  assert.equal(catalog(fixture).profiles[0]!.label, 'studio');
});
test('S24 T069 process overrides cannot authorize a substituted root inode', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  renameSync(own.code!.location, own.code!.location + '-old');
  fixture.io.directory(own.code!.location);
  const result = await invoke(fixture, ['rename', 'studio', 'work', '--ignore-process-check'],
    ['y']);
  assert.equal(result.code, Exit.refusal);
  assert.equal(catalog(fixture).profiles[0]!.label, 'studio');
  assert.equal(readdirSync(own.code!.location).length, 0);
});
test('S31 T057 post-commit deletion cleanup failure keeps registration removed and reports retained data',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    fixture.services.checkpoint = stage => {
      if (stage === 'remove-fences') {
        const operation = catalog(fixture).recoveryClaims.find(claim => claim.profileId === own.id)!.location;
        file(fixture, join(operation, 'removed-code/concurrent'), 'preserve after commit');
      }
    };
    const result = await invoke(fixture, ['remove', 'studio'], ['y', 'y']);
    assert.equal(result.code, Exit.recovery, result.text);
    const value = catalog(fixture);
    assert.equal(value.profiles.length, 0);
    assert.equal(existsSync(own.code!.location), false);
    const operation = value.recoveryClaims.find(claim => claim.profileId === own.id)!.location;
    assert.equal(readFileSync(join(operation, 'removed-code/concurrent'), 'utf8'), 'preserve after commit');
    assert.match(result.text, /cleanup is pending/);
    assert.equal(result.text.includes('Code data deleted'), false);
  });
test('S63 existing Code add is a no-op when no additional selection is eligible', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const before = readFileSync(own.code!.rc);
  const serial = catalog(fixture).serial;
  const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], []);
  assert.equal(result.code, 0);
  assert.deepEqual(readFileSync(own.code!.rc), before);
  assert.equal(catalog(fixture).serial, serial);
});
test('T146 doctor refreshes captured engine paths and status uses the recorded rc despite the current shell',
  async () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const value = catalog(fixture);
    value.profiles[0]!.code!.runtime = '/old/node';
    file(fixture, own.code!.rc, editShell(readFileSync(own.code!.rc), value.profiles[0]!).toString());
    save(fixture, value);
    fixture.env.SHELL = '/bin/bash';
    const before = await invoke(fixture, ['status', 'studio']);
    assert.equal(before.code, Exit.findings);
    assert.match(before.text, /Node or CLI path moved/);
    const repaired = await invoke(fixture, ['doctor', '--apply']);
    assert.equal(repaired.code, 0, repaired.text);
    assert.equal(catalog(fixture).profiles[0]!.code!.runtime, '/opt/homebrew/bin/node');
    assert.equal(catalog(fixture).profiles[0]!.code!.rc, own.code!.rc);
    assert.equal((await invoke(fixture, ['status', 'studio'])).code, 0);
    assert.equal(existsSync(join(fixture.home, '.bash_profile')), false);
  });
test('S13 shell separators survive removing either of two profiles after a prefix without a newline',
  () => {
    const fixture = profileFixture();
    const first = installProfile(fixture);
    const second = installProfile(fixture, 'other');
    const original = Buffer.from('# user prefix without newline');
    const both = editShell(editShell(original, first), second);
    const onlySecond = editShell(both, first, true);
    assert.ok(onlySecond.subarray(0, original.length).equals(original));
    assert.ok(editShell(onlySecond, second, true).equals(original));
    const onlyFirst = editShell(both, second, true);
    assert.ok(editShell(onlyFirst, first, true).equals(original));
  });
test('S67 retired ancestry cannot be accepted as an exact-root reuse plan', () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const value = catalog(fixture);
  const record = {
    id: randomUUID(),
    location: join(fixture.home, 'retired'),
    role: 'code' as const,
    formerProfileId: own.id,
    formerLabel: 'studio',
    retiredAt: new Date().toISOString(),
    reason: 'kept' as const,
    reusedBy: null,
  };
  value.releasedLocations.push(record);
  const child = join(record.location, 'child');
  assert.throws(() => validateReuse(value, child, {
    serial: value.serial,
    location: child,
    retirementIds: [record.id],
  }), kind('retired-overlap'));
});
test('S41 S42 non-Claude ancestors do not become unknown Code sessions',
  () => {
    const fixture = profileFixture();
    const own = installProfile(fixture);
    const result = codeLiveness(own, {
      available: true,
      processes: [{
        pid: 100,
        uid: fixture.io.guard.uid,
        executable: '/bin/zsh',
        argv: [],
        environment: null,
      }],
    }, fixture.io.guard.uid, 101);
    assert.equal(result.state, 'idle');
  });
test('S20 baseline overlap is refused before control leases or profile data can be created',
  async () => {
    const fixture = profileFixture();
    fixture.env.XDG_CONFIG_HOME = join(fixture.home, '.claude');
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
    assert.equal(result.code, Exit.refusal);
    assert.equal(existsSync(join(fixture.home, '.claude')), false);
    assert.equal(existsSync(fixture.data), false);
  });
test('T108 S27 S30 staging changes refuse installation and a seed retry uses a fresh operation',
  async () => {
    const fixture = profileFixture();
    file(fixture, join(fixture.home, '.claude/CLAUDE.md'), 'selected baseline');
    let previous = '';
    fixture.services.checkpoint = stage => {
      if (stage === 'add-staged') {
        previous = catalog(fixture).recoveryClaims.at(-1)!.location;
        file(fixture, join(previous, 'code-stage/concurrent'), 'keep modified staging');
      }
    };
    const failed = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'y', 'y']);
    assert.equal(failed.code, Exit.recovery, failed.text);
    assert.equal(catalog(fixture).profiles.length, 0);
    assert.equal(existsSync(join(fixture.data, 'studio/code')), false);
    assert.equal(readFileSync(join(previous, 'code-stage/concurrent'), 'utf8'), 'keep modified staging');
    fixture.services.checkpoint = () => {
    };
    const retried = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], ['',
      '', '', '', '', 'y', 'y']);
    assert.equal(retried.code, 0, retried.text);
    assert.equal(readFileSync(join(fixture.data, 'studio/code/CLAUDE.md'), 'utf8'), 'selected baseline');
    assert.equal(existsSync(join(fixture.data, 'studio/code/concurrent')), false);
    assert.equal(readFileSync(join(previous, 'code-stage/concurrent'), 'utf8'), 'keep modified staging');
  });
test('S27 S29 a concurrent tree child created during a settings write never becomes cleanup-owned',
  async () => {
    const fixture = profileFixture();
    const ioModule = await import('../src/private-io.js');
    const fsModule = await import('node:fs');
    let injected = false;
    fixture.io = new ioModule.PrivateIO(fixture.io.guard, {
      beforeRename: path => {
        if (!injected && path === join(fixture.data, 'studio/code/settings.json')) {
          injected = true;
          fsModule.writeFileSync(join(dirname(path), 'concurrent'), 'preserve user file',
            { mode: 0o600 });
        }
      },
    });
    const result = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
    assert.equal(result.code, Exit.recovery, result.text);
    assert.equal(readFileSync(join(fixture.data, 'studio/code/concurrent'), 'utf8'), 'preserve user file');
    assert.ok(catalog(fixture).recoveryClaims.length > 0);
    assert.match((await invoke(fixture, ['doctor'])).text, /Pending recovery/);
  });
test('S13 S50 missing GitHub directories can be explicitly repaired but linked selections never launch', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const value = catalog(fixture);
  const github = join(own.code!.location, 'github');
  value.profiles[0]!.code!.github = github;
  save(fixture, value);
  assert.equal((await invoke(fixture, ['run-profile', 'studio'])).code, Exit.refusal);
  const repaired = await invoke(fixture, ['doctor', '--apply']);
  assert.equal(repaired.code, Exit.findings, repaired.text);
  assert.match(repaired.text, /token separation is unverified/);
  assert.equal(lstatSync(github).mode & 0o777, 0o700);
  renameSync(github, github + '-owned');
  const unrelated = join(fixture.home, 'unrelated-github');
  file(fixture, join(unrelated, 'hosts.yml'), 'example.test:\n    oauth_token: synthetic-private\n');
  symlinkSync(unrelated, github);
  const result = await invoke(fixture, ['run-profile', '--profile-id', own.id]);
  assert.equal(result.code, Exit.refusal);
  assert.equal(fixture.launches.length, 0);
  assert.equal(result.text.includes('synthetic-private'), false);
});
test('S13 S50 a linked hosts file cannot route a private GitHub selection into another configuration', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  const value = catalog(fixture);
  const github = join(own.code!.location, 'github');
  value.profiles[0]!.code!.github = github;
  fixture.io.directory(github);
  const unrelated = join(fixture.home, 'unrelated-hosts.yml');
  file(fixture, unrelated, 'example.test:\n    oauth_token: synthetic-private\n');
  symlinkSync(unrelated, join(github, 'hosts.yml'));
  save(fixture, value);
  assert.equal((await invoke(fixture, ['run-profile', 'studio'])).code, Exit.refusal);
  assert.equal(fixture.launches.length, 0);
  assert.equal(readFileSync(unrelated, 'utf8'), 'example.test:\n    oauth_token: synthetic-private\n');
});
test('S13 T146 rc modes survive edits and label-only rename keeps the meaningful route time', async () => {
  const fixture = profileFixture();
  const own = installProfile(fixture);
  chmodSync(own.code!.rc, 0o640);
  const changed = await invoke(fixture, ['rename', 'studio', 'work'], ['y']);
  assert.equal(changed.code, 0, changed.text);
  assert.equal(lstatSync(own.code!.rc).mode & 0o777, 0o640);
  const value = catalog(fixture);
  value.profiles[0]!.code!.defaultLocation = false;
  value.profiles[0]!.code!.defaultCommand = false;
  save(fixture, value);
  const routeTime = value.profiles[0]!.code!.entryChangedAt;
  const renamed = await invoke(fixture, ['rename', 'work', 'renamed'], ['y']);
  assert.equal(renamed.code, 0, renamed.text);
  assert.equal(catalog(fixture).profiles[0]!.code!.entryChangedAt, routeTime);
  assert.equal(lstatSync(own.code!.rc).mode & 0o777, 0o640);
});
test('T131 S63 live sibling sessions are identified when rule additions and removals require restart', async () => {
  const fixture = profileFixture();
  const sibling = installProfile(fixture, 'other');
  fixture.services.census = async () => ({
    available: true, processes: [{
      pid: 100, uid: fixture.io.guard.uid, executable: '/usr/local/bin/claude', argv: [],
      environment: { CLAUDE_CONFIG_DIR: sibling.code!.location },
    }],
  });
  const added = await invoke(fixture, ['add', 'studio', '--target', 'terminal'], addAnswers);
  assert.equal(added.code, 0, added.text);
  assert.match(added.text, /other: observed sessions active; PIDs: 100/);
  assert.match(added.text, /Restart running or uncertain Code sessions/);
  const removed = await invoke(fixture, ['remove', 'studio'], ['y', 'y']);
  assert.equal(removed.code, 0, removed.text);
  assert.match(removed.text, /other: observed sessions active; PIDs: 100/);
  assert.match(removed.text, /Restart running or uncertain Code sessions/);
});

test('S25 adoption approval refuses a replacement before final confirmation without writing a receipt', async () => {
  const f = profileFixture();
  const location = join(f.data, 'studio/code');
  file(f, join(location, 'original'), 'approved');
  let swapped = false;
  f.services.executables = name => {
    if (name === 'gh' && !swapped) {
      renameSync(location, location + '-approved');
      file(f, join(location, 'unrelated'), 'preserve replacement');
      swapped = true;
    }
    return [];
  };
  const result = await invoke(f, ['add', 'studio', '--target', 'terminal'], ['', '', '', '', '', 'y', 'y']);
  assert.ok(swapped);
  assert.notEqual(result.code, 0, result.text);
  assert.equal(existsSync(join(location, '.bcm-root.json')), false);
  assert.equal(readFileSync(join(location, 'unrelated'), 'utf8'), 'preserve replacement');
  assert.equal(catalog(f).profiles.length, 0);
});

test('S27 S29 fence writes preserve settings edited after inspection and report the conflict', () => {
  const f = profileFixture();
  const own = installProfile(f);
  const settings = join(own.code!.location, 'settings.json');
  file(f, settings, '{}');
  const transaction = ChangeRecord.begin(f.io, join(f.control, 'recovery'), [], () => {}, own.id);
  const findings = synchronizeFences(catalog(f), f.control, f.io, (path, bytes, expected, root) => {
    file(f, path, '{"user":"concurrent edit"}');
    transaction.pinRoot(root.location, root.device, root.inode);
    transaction.allow(path);
    transaction.write(path, bytes, undefined, expected);
  }, () => {});
  assert.equal(findings.length, 1);
  assert.match(findings[0]!.message, /changed|expected|conflict/i);
  assert.equal(readFileSync(settings, 'utf8'), '{"user":"concurrent edit"}');
  assert.equal(transaction.rollback(), 0);
  assert.equal(readFileSync(settings, 'utf8'), '{"user":"concurrent edit"}');
});

test('S57 S58 migrations normalize paths and leave reported source-root escapes unchanged', () => {
  const warnings: string[] = [];
  const mapping = {
    source: '/old/code', destination: '/new/code', home: '/home/synthetic', required: true,
    warn: (message: string) => warnings.push(message),
  };
  for (const value of ['/old/code/../hooks/start.js', '/old/code/a/../../hooks/start.js']) {
    assert.equal(mapReference(value, true, mapping), value);
  }
  assert.equal(mapReference('/old/code/./hooks/start.js', true, mapping), '/old/code/./hooks/start.js');
  assert.equal(mapReference('/old/code//hooks///start.js', true, mapping), '/new/code/hooks/start.js');
  assert.equal(mapReference('/old//code/hooks/start.js', true, mapping), '/new/code/hooks/start.js');
  assert.equal(mapReference('/old/./code/hooks/start.js', true, mapping), '/new/code/hooks/start.js');
  const escape = '/old//code/../hooks/start.js';
  assert.equal(mapReference(escape, true, mapping), escape);
  assert.equal(warnings.length, 4);
});
