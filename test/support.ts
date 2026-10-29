import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { requireIsolation } from './isolation.js';
import { PrivateIO } from '../src/private-io.js';
import { readCatalog, emptyCatalog, recordRoot, writeCatalog } from '../src/profile-catalog.js';
import type { Catalog, Profile } from '../src/profile-catalog.js';
import { editShell } from '../src/shell-entries.js';
import { runFront } from '../src/command-front.js';
import { productionHealthServices } from '../src/health-services.js';
import type { CodeServices } from '../src/code-services.js';
const testRoot = requireIsolation();
export const repo = process.env.BCM_TEST_REPO!;
export function profileFixture() {
  const root = realpathSync(mkdtempSync(join(testRoot, 'code-')));
  const home = join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const io = new PrivateIO();
  const control = join(home, '.config/ben-claude-multi');
  const data = join(home, '.local/share/ben-claude-multi');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    SHELL: '/bin/zsh',
  };
  const launches: {
    file: string;
    args: string[];
    env: NodeJS.ProcessEnv
  }[] = [];
  const services: CodeServices = {
    identities: {
      self: async () => ({ boot: 'test-boot', start: 'test-start' }),
      inspect: async () => ({ state: 'alive', boot: 'test-boot', start: 'test-start' }),
    },
    census: async () => ({ available: true, processes: [] }),
    sessionStart: async () => Date.now() + 10000,
    runtime: () => '/opt/homebrew/bin/node',
    cli: join(repo, 'dist/src/main.js'),
    executables: name => name === 'claude' ? ['/usr/local/bin/claude'] : [],
    start: (file, args, env) => {
      launches.push({ file, args, env });
      return { started: Promise.resolve(), completion: Promise.resolve(0) };
    },
  };
  const healthServices = { ...productionHealthServices(env), codeVersion: async () => null };
  return { root, home, io, control, data, env, services, launches, healthServices };
}
export type Fixture = ReturnType<typeof profileFixture>;
export function catalog(fixture: Fixture): Catalog {
  return readCatalog(join(fixture.control, 'catalog.json'), fixture.io).catalog;
}
export function save(fixture: Fixture, value: Catalog): void {
  fixture.io.directory(fixture.control);
  const current = readCatalog(join(fixture.control, 'catalog.json'), fixture.io);
  value.serial = current.kind === 'present' ? current.catalog.serial + 1 : value.serial;
  writeCatalog(join(fixture.control, 'catalog.json'), value, current.image, fixture.io);
}
export function installProfile(fixture: Fixture, label = 'studio'): Profile {
  const current = readCatalog(join(fixture.control, 'catalog.json'), fixture.io);
  const value = current.kind === 'present' ? current.catalog : emptyCatalog();
  const now = new Date().toISOString();
  const profile: Profile = {
    id: randomUUID(),
    label,
    bornAt: now,
    changedAt: now,
    credentialPolicy: 'subscription',
    desktop: null,
    rootEvidence: [],
    code: {
      location: join(fixture.data, label, 'code'),
      shell: 'zsh',
      rc: join(fixture.home, '.zshrc'),
      command: `claude-${label}`,
      github: null,
      defaultLocation: true,
      defaultCommand: true,
      entryChangedAt: now,
      runtime: '/opt/homebrew/bin/node',
      cli: fixture.services.cli,
    },
  };
  fixture.io.directory(profile.code!.location);
  profile.rootEvidence.push(recordRoot(profile.code!.location, 'code', value.installationKey,
    profile.id, fixture.io));
  const rc = fixture.io.read(profile.code!.rc);
  fixture.io.write(profile.code!.rc, editShell(rc?.bytes ?? Buffer.alloc(0), profile),
    rc?.image ?? null);
  value.profiles.push(profile);
  save(fixture, value);
  return profile;
}
export async function invoke(fixture: Fixture, args: string[], answers: string[] | null = null) {
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
    env: fixture.env,
    io: fixture.io,
    input,
    output,
    tty: answers !== null,
    platform: 'darwin',
    services: fixture.services,
    healthServices: fixture.healthServices,
  });
  return { code, text };
}
export const addAnswers = ['', '', '', '', '', 'y'];
