import assert from 'node:assert/strict';
import { readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-support.js';
import { execute } from '../src/machine-services.js';
import type { HealthServices } from '../src/health-services.js';
function plist(text: string): Record<string, unknown> {
  if (text.startsWith('{')) {
    return JSON.parse(text) as Record<string, unknown>;
  }
  const result: Record<string, unknown> = {};
  for (const match of text.matchAll(/<key>([^<]+)<\/key>(?:<string>([^<]*)<\/string>|<(true|false)\/>)/g)) {
    result[match[1]!] = match[3] ? match[3] === 'true' : match[2];
  }
  return result;
}
export function healthFixture() {
  const fixture = lifecycleFixture();
  const tools: { file: string; args: readonly string[] }[] = [];
  const compiler = fixture.desktop.compile;
  fixture.desktop.compile = async (source, target) => {
    await compiler(source, target);
    chmodSync(join(target, 'Contents/MacOS/applet'), 0o755);
  };
  fixture.desktop.tint = async (path, tint) => {
    if (tint !== 'none') {
      fixture.put(join(path, 'Icon\r'), 'synthetic ' + tint);
    }
  };
  fixture.desktop.clearTint = async path => {
    const file = fixture.io.snapshot(join(path, 'Icon\r'));
    if (file) {
      fixture.io.remove(join(path, 'Icon\r'), file);
    }
  };
  const health: HealthServices = {
    codeVersion: async () => '2.3.4',
    tool: async (file, args) => {
      tools.push({ file, args });
      if (file === '/usr/bin/xcode-select') {
        assert.deepEqual(args, ['-p']);
        return { code: 0, stdout: '/fixture/developer-tools', stderr: '' };
      }
      assert.ok(['/usr/bin/git', '/usr/bin/plutil', '/usr/bin/osadecompile'].includes(file));
      if (file === '/usr/bin/git') {
        assert.deepEqual(args.slice(0, 2), ['config', '--file']);
        return execute(file, args, { env: {
          HOME: fixture.home, XDG_CONFIG_HOME: fixture.env.XDG_CONFIG_HOME!, PATH: '/usr/bin:/bin',
          LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
        } });
      }
      assert.ok(args.at(-1)!.startsWith(fixture.root + '/'));
      const text = readFileSync(args.at(-1)!, 'utf8');
      if (file === '/usr/bin/plutil' && args[0] === '-extract') {
        let value: unknown = plist(text);
        for (const key of args[1]!.split('.')) {
          value = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
        }
        return value === undefined ? { code: 1, stdout: '', stderr: 'Missing key' }
        : { code: 0, stderr: '', stdout: String(Array.isArray(value) ? value.length : value) + '\n' };
      }
      return { code: 0, stderr: '', stdout: file === '/usr/bin/plutil' ? JSON.stringify(plist(text)) : text };
    },
  };
  fixture.health.services = health;
  return { ...fixture, healthTools: tools };
}
