import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { healthFixture } from './health-support.js';
import { catalog } from './support.js';

type Fixture = ReturnType<typeof healthFixture>;

function fixture(github: boolean): Fixture {
  const f = healthFixture();
  f.services.executables = name => {
    if (name === 'gh') {
      return github ? ['/fixture/gh'] : [];
    }
    return name === 'claude' ? ['/fixture/claude'] : [];
  };
  const health = f.health.services!;
  const tool = health.tool;
  health.tool = async (file, args) => file === '/usr/bin/git'
    ? { code: 0, stdout: '', stderr: '' }
    : tool(file, args);
  return f;
}

function clean(f: Fixture): void {
  assert.deepEqual(catalog(f).recoveryClaims, []);
  assert.deepEqual(readdirSync(join(f.control, 'recovery')), []);
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.doesNotMatch(entry.name, /^(code-stage|candidate-|launcher-stage|operation\.json|refresh\.json)/);
      if (entry.isDirectory()) {
        walk(join(directory, entry.name));
      }
    }
  };
  walk(f.home);
}

function answers(f: Fixture, target: string, github: boolean, imported?: boolean): string[] {
  const result: string[] = [];
  if (target !== 'desktop') {
    result.push('', '', '', '', '');
    if (imported !== undefined) {
      result.push(imported ? 'y' : 'n');
    }
    result.push(github ? 'y' : 'n');
  }
  if (target !== 'terminal') {
    result.push(...f.desktopAnswers);
    if (imported !== undefined) {
      result.push(imported ? '1' : '');
    }
  }
  result.push('y');
  return result;
}

for (const target of ['terminal', 'desktop', 'paired']) {
  for (const github of [false, true]) {
    for (const imported of [false, true]) {
      const name = `T138 S25 S31 first add ${target}, gh ${github}, import ${imported}`;
      test(name, async () => {
        const f = fixture(target === 'desktop' ? github : true);
        f.put(join(f.home, '.claude/CLAUDE.md'), 'synthetic setup instructions\n');
        const baseline = join(f.home, 'Library/Application Support/Claude/claude_desktop_config.json');
        f.put(baseline, JSON.stringify({ mcpServers: { sample: { command: '/fixture/connector' } } }));
        const result = await f.invoke(['add', 'studio', '--target', target], answers(f, target, github, imported));
        assert.equal(result.code, 0, result.text);
        const profile = f.profile();
        assert.equal(!!profile.code, target !== 'desktop');
        assert.equal(!!profile.desktop, target !== 'terminal');
        assert.equal(!!profile.code?.github, github && target !== 'desktop');
        if (profile.code) {
          assert.equal(existsSync(join(profile.code.location, 'CLAUDE.md')), imported);
          if (github) {
            assert.deepEqual(readdirSync(profile.code.github!), []);
          }
        } else {
          assert.doesNotMatch(result.text, /Enable a private GitHub CLI directory/);
        }
        if (profile.desktop) {
          const file = join(profile.desktop.location, 'claude_desktop_config.json');
          assert.equal(existsSync(file), imported);
          if (imported) {
            assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers,
              { sample: { command: '/fixture/connector' } });
          }
        }
        clean(f);
      });
    }
  }
}

test('T138 T141 T143 S31 paired GitHub happy lifecycle keeps and deletes data without residual work', async () => {
  const f = fixture(true);
  const step = async (args: string[], input: string[] | null = null) => {
    const result = await f.invoke(args, input);
    assert.equal(result.code, 0, result.text);
    clean(f);
    return result;
  };
  await step(['add', 'studio', '--target', 'paired'], answers(f, 'paired', true));
  // Synthetic user login state avoids an intentional unconfigured-token diagnostic.
  f.put(join(f.profile().code!.github!, 'hosts.yml'), 'github.com:\n    oauth_token: synthetic-token\n');
  await step(['rename', 'studio', 'work'], ['y']);
  const kept = f.profile('work');
  await step(['status', 'work']);
  await step(['list']);
  await step(['doctor']);
  await step(['remove', 'work'], ['', '', 'y']);
  assert.equal(catalog(f).profiles.length, 0);
  assert.ok(existsSync(kept.code!.location));
  assert.ok(existsSync(kept.desktop!.location));
  assert.equal(existsSync(kept.desktop!.launcher), false);
  await step(['add', 'second', '--target', 'paired'], answers(f, 'paired', true));
  const deleted = f.profile('second');
  await step(['remove', 'second'], ['y', 'y', 'y']);
  assert.equal(catalog(f).profiles.length, 0);
  assert.equal(existsSync(deleted.code!.location), false);
  assert.equal(existsSync(deleted.desktop!.location), false);
  assert.equal(existsSync(deleted.desktop!.launcher), false);
});

test('T001 help lists aligned Desktop launch command before its notes', async () => {
  const f = fixture(false);
  const result = await f.invoke(['help'], null);
  assert.equal(result.code, 0);
  const lines = result.text.split('\n');
  const open = lines.find(line => line.startsWith('  open-profile'))!;
  const list = lines.find(line => line.startsWith('  list '))!;
  assert.equal(open.indexOf('Launch'), list.indexOf('Show'));
  assert.ok(lines.indexOf(open) < lines.findIndex(line => line.startsWith('Rename and remove accept')));
});
