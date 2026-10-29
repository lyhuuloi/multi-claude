import { cpSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { profileFixture, catalog, repo } from './support.js';
import { PrivateIO } from '../src/private-io.js';
import type { HealthServices } from '../src/health-services.js';
import type { IOHooks } from '../src/private-io.js';
import { runFront } from '../src/command-front.js';
import type { DesktopServices } from '../src/desktop-services.js';
import type { DesktopProcess } from '../src/process-census.js';
export function lifecycleFixture(hooks: IOHooks = {}) {
  const fixture = profileFixture();
  fixture.io = new PrivateIO(fixture.io.guard, hooks);
  fixture.services.runtime = () => process.execPath;
  const health: { services?: HealthServices } = { services: fixture.healthServices };
  const calls: { kind: string; value: string }[] = [];
  let processes: DesktopProcess[] = [];
  const put = (path: string, value: string) => {
    fixture.io.directory(dirname(path));
    fixture.io.write(path, value, fixture.io.snapshot(path));
  };
  const source = join(fixture.home, 'source/Claude.app');
  put(join(source, 'Contents/Info.plist'), '4.29.0');
  put(join(source, 'Contents/MacOS/Claude'), 'fixture signed executable');
  const desktop: DesktopServices = {
    identities: fixture.services.identities,
    tool: async (_file, args) => {
      calls.push({ kind: 'verify', value: args.at(-1)! });
      return { code: 0, stdout: '', stderr: '' };
    },
    copy: async (from, to) => {
      cpSync(from, to, { recursive: true });
    },
    tint: async () => {},
    icon: async () => {},
    version: async path => readFileSync(join(path, 'Contents/Info.plist'), 'utf8'),
    compile: async (script, target) => {
      put(join(target, 'Contents/Info.plist'), '{}');
      put(join(target, 'Contents/MacOS/applet'), 'compiled fixture');
      put(join(target, 'Contents/Resources/Scripts/main.scpt'), readFileSync(script, 'utf8'));
    },
    census: async () => ({ available: true, processes }),
    confirmWrong: async () => false,
    terminate: async () => {
      throw new Error('Lifecycle tests must not terminate processes');
    },
    open: async args => {
      calls.push({ kind: 'open', value: JSON.stringify(args) });
    },
    notify: async () => {},
    register: async path => {
      calls.push({ kind: 'register', value: path });
      return true;
    },
    unregister: async path => {
      calls.push({ kind: 'unregister', value: path });
      return true;
    },
    refreshDock: async path => {
      calls.push({ kind: 'dock-refresh', value: path });
    },
    contentionMs: 0,
  };
  const invoke = async (args: string[], answers: string[] | null = []) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', bytes => {
      text += String(bytes);
    });
    if (answers !== null) {
      input.end(answers.join('\n') + '\n');
    }
    const code = await runFront(args, {
      env: fixture.env, io: fixture.io, input, output, tty: answers !== null, platform: 'darwin',
      services: fixture.services, desktopServices: desktop,
      ...(health.services ? { healthServices: health.services } : {}),
    });
    return { code, text };
  };
  const desktopAnswers = [source, '', '', 'n', 'none'];
  const pairedAnswers = ['', '', '', '', '', ...desktopAnswers];
  const addDesktop = (label = 'studio') => invoke(['add', label, '--target', 'desktop'], [...desktopAnswers, 'y']);
  const addPaired = (label = 'studio') => invoke(['add', label, '--target', 'paired'], [...pairedAnswers, 'y']);
  const profile = (label = 'studio') => catalog(fixture).profiles.find(value => value.label === label)!;
  const application = (label = 'studio') => join(fixture.control, 'bundles.noindex', profile(label).id, 'Claude.app');
  return {
    ...fixture, desktop, health, calls, put, source, invoke, addDesktop, addPaired, profile, application,
    desktopAnswers, pairedAnswers, repo,
    setProcesses: (next: DesktopProcess[]) => {
      processes = next;
    },
  };
}
