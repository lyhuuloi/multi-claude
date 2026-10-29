import { accessSync, constants, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { PrivateIO } from './private-io.js';
import { CatalogSession } from './profile-actions.js';
import { LeaseManager } from './operation-leases.js';
import { ApplicationVault } from './application-vault.js';
import { verifyClaude } from './claude-authenticity.js';
import { desktopState, sameDesktopProcess } from './process-census.js';
import type { DesktopCensus, DesktopProcess, DesktopState } from './process-census.js';
import type { DesktopServices } from './desktop-services.js';
import { executionEnvironment, authenticationOverrides, githubOverrides } from './execution-policy.js';
import { validateLocations, verifyRoot, uuid } from './profile-catalog.js';
import type { Profile } from './profile-catalog.js';
import { assertGithubDirectory } from './github-configuration.js';
import { Problem, Exit, terminalText } from './outcomes.js';
export function openArguments(application: string, data: string, env: NodeJS.ProcessEnv, focus = false): string[] {
  if (focus) {
    return ['-a', application];
  }
  const assignments = ['CLAUDE_CONFIG_DIR', 'GH_CONFIG_DIR'].flatMap(name =>
    env[name] === undefined ? [] : ['--env', `${name}=${env[name]}`]);
  return ['-n', '-a', application, ...assignments, '--args', '--user-data-dir=' + data];
}
export class DesktopLaunch {
  constructor(
    private readonly home: string,
    private readonly io: PrivateIO,
    private readonly services: DesktopServices,
    private readonly out: (message: string) => void,
    private readonly env: NodeJS.ProcessEnv,
  ) {}
  private async census(): Promise<DesktopCensus> {
    try {
      return await this.services.census();
    } catch {
      return { available: false, processes: [] };
    }
  }
  async run(catalogFile: string, selector: string, byId: boolean): Promise<number> {
    const control = dirname(catalogFile);
    const initial = new CatalogSession(this.io, control);
    if (!initial.image || initial.file !== catalogFile) {
      throw new Problem('desktop-catalog', 'The recorded Desktop catalog is missing or invalid.');
    }
    validateLocations(initial.catalog, this.home, control);
    const manager = new LeaseManager(join(control, 'leases'), this.io, this.services.identities);
    const gate = await manager.acquire('registry', this.services.contentionMs ?? 20000);
    try {
      const session = new CatalogSession(this.io, control);
      const profile = session.catalog.profiles.find(value => byId ? value.id === selector : value.label === selector);
      if (!profile?.desktop || (byId && !uuid(selector))) {
        throw new Problem('desktop-profile', 'The Desktop profile is no longer registered.');
      }
      if (!profile.desktop.runtime || !profile.desktop.cli) {
        throw new Problem('desktop-engine', 'The Desktop engine paths are unrecorded; repair is required.');
      }
      enginePaths(profile.desktop.runtime, profile.desktop.cli);
      const data = profile.rootEvidence.find(value => value.role === 'desktop');
      if (!data || data.location !== profile.desktop.location) {
        throw new Problem('desktop-data', 'The Desktop data root has no matching ownership evidence.');
      }
      verifyRoot(data, this.io);
      if (profile.code) {
        const code = profile.rootEvidence.find(value => value.role === 'code');
        if (!code) {
          throw new Problem('desktop-code', 'The selected Code root is unrecorded.');
        }
        verifyRoot(code, this.io);
        if (profile.code.github) {
          assertGithubDirectory(profile.code.github, this.io);
        }
      }
      const path = join(control, 'bundles.noindex', profile.id, 'Claude.app');
      const executable = join(path, 'Contents/MacOS/Claude');
      const inspect = async () => desktopState(
        profile.desktop!.location, executable, await this.census(), this.io.guard.uid,
      );
      const idle = async () => {
        const state = await inspect();
        if (state.kind !== 'idle') {
          throw new Problem('desktop-busy',
            'The application is live or uncertain; replacement and tinting are blocked.');
        }
      };
      const vault = new ApplicationVault(control, this.io, this.services, session, profile, idle, this.out);
      await vault.source();
      let lease;
      try {
        lease = await manager.acquire(`profile-${profile.id}`, this.services.contentionMs ?? 20000);
      } catch (error) {
        if (!(error instanceof Problem) || error.kind !== 'lease-busy') {
          throw error;
        }
        const state = await inspect();
        if (state.kind === 'unknown' || state.kind === 'wrong' || !await vault.existing()) {
          throw new Problem('desktop-contention', 'Copy maintenance is busy; retry after it finishes.');
        }
        this.out('Maintenance lock timed out; using only the already verified copy without recovery or changes.');
        return await this.open(profile, state, path);
      }
      try {
        let state = await inspect();
        if (state.kind === 'unknown') {
          throw new Problem('desktop-unknown', 'Desktop process evidence is ambiguous; no application was opened.');
        }
        if (state.kind !== 'idle') {
          if (!await vault.existing()) {
            throw new Problem('desktop-running-invalid', 'A running invalid copy cannot be opened or replaced.');
          }
          if (state.kind === 'correct') {
            return await this.open(profile, state, path);
          }
          state = await this.correctWrong(profile, inspect, state);
          if (state.kind === 'correct') {
            return await this.open(profile, state, path);
          }
          if (state.kind !== 'idle') {
            return Exit.ok;
          }
        }
        const application = await vault.ensure();
        await this.services.checkpoint?.('desktop-before-open');
        state = await inspect();
        if (state.kind === 'wrong' || state.kind === 'unknown') {
          throw new Problem('desktop-race', 'Desktop process state changed before opening; retry the profile request.');
        }
        return await this.open(profile, state, application);
      } finally {
        lease.release();
      }
    } finally {
      gate.release();
    }
  }
  private async correctWrong(
    profile: Profile, inspect: () => Promise<DesktopState>, state: DesktopState,
  ): Promise<DesktopState> {
    const confirmed = structuredClone(state.wrong);
    if (!await this.services.confirmWrong(profile.label, confirmed)) {
      this.out('The existing application was left running.');
      return state;
    }
    const current = await inspect();
    if (current.kind === 'correct') {
      return current;
    }
    if (current.kind === 'unknown' || current.wrong.length !== confirmed.length
      || confirmed.some(value => !current.wrong.some(item => sameDesktopProcess(value, item)))) {
      throw new Problem('desktop-dialog-race', 'The confirmed process changed; no termination was requested.');
    }
    for (const process of confirmed) {
      const latest = await inspect();
      if (latest.kind === 'correct') {
        return latest;
      }
      const target = latest.wrong.find(value => sameDesktopProcess(process, value));
      if (latest.kind === 'unknown' || !target) {
        throw new Problem('desktop-identity', 'Process identity changed before graceful termination.');
      }
      await this.services.terminate(target);
    }
    const deadline = Date.now() + (this.services.contentionMs ?? 5000);
    for (;;) {
      const next = await inspect();
      if (next.kind === 'idle' || next.kind === 'correct') {
        return next;
      }
      if (next.kind === 'unknown' || Date.now() >= deadline) {
        throw new Problem('desktop-quit-wait', 'Graceful termination did not establish idle state; no force was used.');
      }
      await pause(50);
    }
  }
  private async open(profile: Profile, state: DesktopState, application: string): Promise<number> {
    const correct: DesktopProcess | undefined = state.correct[0];
    const target = correct?.bundle ?? application;
    const selected = executionEnvironment(profile, this.env);
    const launchd = await this.services.launchdOverrides?.() ?? [];
    const forbidden: string[] = [
      ...(profile.credentialPolicy === 'subscription' ? authenticationOverrides : []),
      ...(profile.code?.github ? githubOverrides : []),
      ...(!profile.code ? ['CLAUDE_CONFIG_DIR'] : []),
      ...(!profile.code?.github ? ['GH_CONFIG_DIR'] : []),
    ];
    const conflicting = launchd.filter(name => forbidden.includes(name));
    if (conflicting.length) {
      for (const name of conflicting) {
        this.out(`Launchd override ${name}: use /bin/launchctl unsetenv ${name} before retrying.`);
      }
      throw new Problem('launchd-selection', 'Launchd overrides prevent confirming the required launch environment.');
    }
    await verifyClaude(target, false, this.io.guard, this.services.tool, target === application);
    await this.services.open(openArguments(target, profile.desktop!.location, selected, !!correct), selected);
    this.out(correct ? `Focused profile ${profile.label}.` : `Opened profile ${profile.label}.`);
    return Exit.ok;
  }
  async report(error: unknown, control: string): Promise<number> {
    const status = error instanceof Problem ? error.status : Exit.failure;
    const message = terminalText(error instanceof Problem ? error.message : 'Desktop launch failed.');
    this.out(message);
    try {
      this.io.directory(control);
      this.io.append(join(control, 'events.ndjson'), JSON.stringify({
        time: new Date().toISOString(), action: 'desktop-launch', status, message,
      }) + '\n');
    } catch {
      this.out('The private event record could not be written.');
    }
    try {
      await this.services.notify(message);
    } catch {
      this.out('The native failure dialog was unavailable.');
    }
    return status;
  }
}
export function enginePaths(runtime: string, cli: string): void {
  accessSync(runtime, constants.X_OK);
  accessSync(cli, constants.R_OK);
  if (!lstatSync(cli).isFile()) {
    throw new Problem('desktop-engine', 'The compiled launch engine is unavailable.');
  }
}
