import { join, isAbsolute, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { PrivateIO } from './private-io.js';
import { readCatalog, verifyRoot, validateLocations, validLabel, uuid } from './profile-catalog.js';
import { protectedPath, refuseOverlap, baselineLocations } from './location-guard.js';
import { Dialogue } from './terminal-dialogue.js';
import { Exit, Problem, terminalText, isMissing } from './outcomes.js';
import { ProfileActions } from './profile-actions.js';
import type { ProfileLocations } from './profile-actions.js';
import { productionCodeServices } from './code-services.js';
import type { CodeServices } from './code-services.js';
import { shellEntryFinding } from './shell-entries.js';
import { githubStorageFinding } from './github-configuration.js';
import { DesktopLaunch } from './desktop-launch.js';
import { LifecycleActions } from './lifecycle-actions.js';
import { RecoveryActions } from './recovery-actions.js';
import { TransferActions } from './transfer-actions.js';
import { SetupActions } from './setup-actions.js';
import { productionDesktopServices } from './desktop-services.js';
import type { DesktopServices } from './desktop-services.js';
import { HealthReview } from './health-review.js';
import type { HealthServices } from './health-services.js';
import { productionHealthServices } from './health-services.js';
import { releaseVersion } from './release.js';
import { maintenanceFinding } from './maintenance-state.js';
export interface FrontContext {
  env: NodeJS.ProcessEnv;
  io: PrivateIO;
  input: Readable;
  output: Writable;
  tty: boolean;
  platform: string;
  services?: CodeServices;
  desktopServices?: DesktopServices;
  healthServices?: HealthServices;
}
interface CommandSpec {
  max: number;
  min?: number;
  options?: Record<string, 'switch' | 'target' | 'uuid'>;
  tail?: boolean;
}
const commands: Readonly<Record<string, CommandSpec>> = Object.freeze({
  help: { max: 0 },
  version: { max: 0 },
  list: { max: 0 },
  status: { max: 1 },
  add: { max: 1, options: { '--target': 'target' } },
  doctor: { max: 0, options: { '--apply': 'switch', '--recover': 'uuid' } },
  remove: { max: 1, options: { '--ignore-process-check': 'switch' } },
  rename: { max: 2, options: { '--ignore-process-check': 'switch' } },
  repair: { max: 1, options: { '--refresh-dock': 'switch' } },
  'copy-setup': { max: 2, options: { '--replace-selected': 'switch' } },
  'desktop-updates': { max: 2 },
  'open-profile': { max: 1 },
  'run-profile': { max: 1, tail: true, options: { '--profile-id': 'uuid' } },
  '_dock-entry': { min: 2, max: 2 },
  '_run-profile-id': { min: 1, max: 1, tail: true },
});
export interface Invocation {
  positional: string[];
  options: Map<string, string | true>;
  tail: string[];
}
export function invocation(command: string, args: readonly string[]): Invocation {
  const spec = commands[command]!;
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  let tail: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--' && spec.tail) {
      tail = args.slice(index + 1);
      break;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    if (!spec.options || !Object.hasOwn(spec.options, arg) || options.has(arg)) {
      throw new Problem('arguments', 'Unknown or repeated option.', Exit.usage);
    }
    const type = spec.options[arg];
    if (type === 'switch') {
      options.set(arg, true);
    } else {
      const value = args[++index];
      if (type === 'uuid' ? !uuid(value) : !value || !['desktop', 'terminal', 'paired'].includes(value)) {
        throw new Problem('arguments', 'The option value is invalid or missing.', Exit.usage);
      }
      options.set(arg, value!);
    }
  }
  if (positional.length > spec.max || positional.length < (spec.min ?? 0)
    || (options.has('--apply') && options.has('--recover'))) {
    throw new Problem('arguments', 'Conflicting options or an incorrect argument count.',
      Exit.usage);
  }
  if (command === 'run-profile' && positional.length + Number(options.has('--profile-id')) !== 1) {
    throw new Problem('arguments', 'Supply exactly one label or --profile-id UUID.', Exit.usage);
  }
  if (command === 'desktop-updates' && positional[1] && !['launcher', 'application'].includes(positional[1])) {
    throw new Problem('arguments', 'Choose launcher or application update mode.', Exit.usage);
  }
  if (command === '_dock-entry') {
    if (!uuid(positional[0])) {
      throw new Problem('arguments', 'A Dock entry requires a profile UUID.', Exit.usage);
    }
    protectedPath(positional[1]!);
  }
  if (command === '_run-profile-id' && !uuid(positional[0])) {
    throw new Problem('arguments', 'A shell entry requires a profile UUID.', Exit.usage);
  }
  return { positional, options, tail };
}
const help =
`ben-claude-multi ${releaseVersion}
Usage: ben-claude-multi <command>
  add [label] [--target desktop|terminal|paired]     Create or link selected surfaces
  run-profile <label> [-- ...]                       Start the shared Claude Code executable
  run-profile --profile-id UUID [-- ...]             Resolve a stable shell entry
  open-profile [label]                               Launch or focus a verified Desktop profile
  rename [old] [new]                                 Rename a profile and its generated defaults
  remove [label]                                     Remove a registration; keep user data by default
  list                                               Show profiles and baseline locations
  status [label]                                     Inspect recorded roots and shell entries
  doctor [--apply | --recover UUID]                  Audit health, apply safe repairs, or review unfinished work
  repair [label] [--refresh-dock]                    Repair the verified Desktop launcher
  copy-setup [source] [target] [--replace-selected]  Transfer selected Desktop setup
  desktop-updates [label] [launcher|application]     Inspect or change owned update policy
  help | version                                     Show usage or release information
Rename and remove accept --ignore-process-check; ownership checks still apply.
Setup transfer requires explicit item selection. Doctor reports disk evidence and session uncertainty separately.
`;
export function locations(env: NodeJS.ProcessEnv): ProfileLocations {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) {
    throw new Problem('home-path', 'HOME must identify an absolute directory.');
  }
  protectedPath(home);
  const config = env.XDG_CONFIG_HOME ?? join(home, '.config');
  const data = env.XDG_DATA_HOME ?? join(home, '.local/share');
  protectedPath(config);
  protectedPath(data);
  const control = join(config, 'ben-claude-multi');
  const dataParent = join(data, 'ben-claude-multi');
  refuseOverlap(control, baselineLocations(home));
  refuseOverlap(dataParent, [...baselineLocations(home), control]);
  return { home, control, data: dataParent };
}
function exists(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw new Problem('resource-unreadable', 'A registered resource cannot be inspected.',
      Exit.findings);
  }
}
async function inspect(
  command: 'list' | 'status',
  label: string | undefined,
  ctx: FrontContext,
  services: CodeServices,
): Promise<number> {
  const where = locations(ctx.env);
  const catalogPath = join(where.control, 'catalog.json');
  const catalog = readCatalog(catalogPath, ctx.io).catalog;
  const out = (value: string) => ctx.output.write(terminalText(value) + '\n');
  out(`Catalog: ${catalogPath}`);
  let findings = false;
  try {
    validateLocations(catalog, where.home, where.control);
  } catch (error) {
    out(error instanceof Problem ? error.message : 'Location checks failed.');
    findings = true;
  }
  if (label && !catalog.profiles.some(profile => profile.label === label)) {
    out(`Profile ${label} is not registered.`);
    return Exit.findings;
  }
  const sessionStart = command === 'list' ? null : await services.sessionStart();
  for (const profile of catalog.profiles.filter(value => !label || value.label === label)) {
    const surfaces = [profile.code ? 'Code' : '', profile.desktop ? 'Desktop' : ''].filter(Boolean).join(', ');
    out(`${profile.label}: ${surfaces}; created ${profile.bornAt}`);
    if (profile.code) {
      out(`Code root: ${profile.code.location}; command: ${profile.code.command}; rc: ${profile.code.rc}`);
    }
    if (profile.desktop) {
      out(`Desktop root: ${profile.desktop.location}; launcher: ${profile.desktop.launcher}`);
    }
    if (command !== 'list') {
      const required = [
        ...(profile.code ? [{ location: profile.code.location, role: 'code' }] : []),
        ...(profile.desktop ? [
          { location: profile.desktop.location, role: 'desktop' },
          { location: profile.desktop.launcher, role: 'launcher' },
        ] : []),
      ];
      for (const root of required) {
        const evidence = profile.rootEvidence.find(value => value.role === root.role && value.location ===
          root.location);
        try {
          if (!evidence) {
            throw new Problem('unrecorded-root', 'Root identity has not been recorded.');
          }
          verifyRoot(evidence, ctx.io);
          out(`${root.role}: identity matches`);
        } catch {
          findings = true;
          out(`${root.role}: missing or inconsistent at ${root.location}`);
        }
      }
      if (profile.desktop && !exists(profile.desktop.source)) {
        findings = true;
        out(`Source application missing: ${profile.desktop.source}`);
      }
      if (profile.code) {
        try {
          if (profile.code.runtime && (profile.code.runtime !== services.runtime(ctx.env.PATH ?? '')
            || profile.code.cli !== services.cli)) {
            findings = true;
            out('The captured Node or CLI path moved; run doctor --apply to refresh the shell route.');
          }
          const shell = shellEntryFinding(profile, ctx.io, sessionStart);
          if (shell) {
            out(shell);
            findings ||= !shell.startsWith('Session age');
          } else {
            out('Recorded shell route matches this UUID and command.');
          }
          if (profile.code.github) {
            const github = githubStorageFinding(profile.code.github, ctx.io);
            if (github) {
              findings = true;
              out(github);
            }
          }
        } catch (error) {
          findings = true;
          out(error instanceof Problem ? error.message : 'The recorded shell or GitHub file is unreadable.');
        }
      }
    }
  }
  if (command === 'list') {
    if (!catalog.profiles.length) {
      out('No managed profiles are registered.');
    }
    out(`Unmanaged baseline Code: ${join(where.home, '.claude')}`);
    const baselineData = exists(join(where.home, 'Library/Application Support/Claude'));
    const baselineApp = exists('/Applications/Claude.app') || exists(join(where.home, 'Applications/Claude.app'));
    out(`Unmanaged baseline Desktop data: ${baselineData ? 'present' : 'absent'}`);
    out(`Baseline Desktop application: ${baselineApp ? 'installed' : 'not found'}`);
    const candidates = services.executables('claude', ctx.env.PATH ?? '');
    let version: string | null = null;
    if (candidates[0]) {
      try {
        const health = ctx.healthServices ?? productionHealthServices(ctx.env);
        version = await health.codeVersion(candidates[0]);
      } catch {
        version = null;
      }
    }
    const shown = version && /^\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/.test(version) ? version : 'unavailable';
    out(`Shared Claude Code executable: ${candidates[0] ?? 'not found'}; version: ${shown}`);
    if (candidates.length > 1) {
      out(`Shadowed alternatives: ${candidates.slice(1).join(', ')}`);
    }
  } else {
    out('Basic inspection only; doctor supplies Code read-rule and GitHub storage findings.');
  }
  return findings ? Exit.findings : Exit.ok;
}
export async function runFront(argv: readonly string[], ctx: FrontContext): Promise<number> {
  const dialogue = new Dialogue(ctx.input, ctx.output, ctx.tty);
  try {
    let args = [...argv];
    if (!args.length && ctx.tty) {
      const selection = await dialogue.choose('Choose an action', [
        'List profiles', 'Inspect status', 'Add a Code profile', 'Rename a Code profile',
        'Remove a Code profile',
      ]);
      if (!selection.length) {
        return Exit.ok;
      }
      args = [['list'], ['status'], ['add', '--target', 'terminal'], ['rename'], ['remove']][selection[0]!]!;
    }
    const command = args[0] === '--help' ? 'help' : args[0] === '--version' ? 'version' : args[0] ?? 'help';
    if (!Object.hasOwn(commands, command)) {
      throw new Problem('command', 'Unknown command. Use help to see available actions.',
        Exit.usage);
    }
    const parsed = invocation(command, args.slice(1));
    if (command === 'help') {
      ctx.output.write(help);
      return Exit.ok;
    }
    if (command === 'version') {
      ctx.output.write(`ben-claude-multi ${releaseVersion}\n`);
      return Exit.ok;
    }
    if (ctx.platform !== 'darwin') {
      throw new Problem('platform', 'This tool requires macOS.', Exit.unavailable);
    }
    const services = ctx.services ?? productionCodeServices();
    const {
      positional,
      options,
      tail
    } = parsed;
    if (!command.startsWith('_') && command !== 'doctor') {
      const where = locations(ctx.env);
      const catalog = readCatalog(join(where.control, 'catalog.json'), ctx.io).catalog;
      const maintenance = maintenanceFinding(catalog, where.control, services.cli, ctx.io);
      if (maintenance) {
        ctx.output.write(maintenance + '\n');
      }
    }
    if (command === 'list' || command === 'status') {
      if (positional[0] !== undefined && !validLabel(positional[0])) {
        throw new Problem('label', 'The profile label is invalid.', Exit.usage);
      }
      return await inspect(command, positional[0], ctx, services);
    }
    const out = (message: string) => {
      ctx.output.write(terminalText(message) + '\n');
    };
    if (command === 'open-profile' || command === '_dock-entry') {
      const where = locations(ctx.env);
      const catalogFile = command === '_dock-entry' ? positional[1]! : join(where.control, 'catalog.json');
      refuseOverlap(dirname(catalogFile), baselineLocations(where.home));
      const desktop = ctx.desktopServices ?? productionDesktopServices();
      const engine = new DesktopLaunch(where.home, ctx.io, desktop, out, ctx.env);
      try {
        let selector = positional[0];
        if (!selector) {
          const profiles = readCatalog(catalogFile, ctx.io).catalog.profiles.filter(profile => profile.desktop);
          const choices = await dialogue.choose('Select a Desktop profile', profiles.map(profile => profile.label));
          if (!choices.length) {
            return Exit.ok;
          }
          selector = profiles[choices[0]!]!.label;
        }
        return await engine.run(catalogFile, selector, command === '_dock-entry');
      } catch (error) {
        return await engine.report(error, dirname(catalogFile));
      }
    }
    const actions = new ProfileActions(locations(ctx.env), ctx.io, services, dialogue, out, ctx.env);
    if (command === 'add') {
      return await new SetupActions(locations(ctx.env), ctx.io, services,
        ctx.desktopServices ?? productionDesktopServices(), dialogue, out, ctx.env)
      .add(positional[0], options.get('--target') as string | undefined);
    }
    const lifecycle = new LifecycleActions(locations(ctx.env), ctx.io, services,
      ctx.desktopServices ?? productionDesktopServices(), dialogue, out, ctx.env);
    if (command === 'rename') {
      return await lifecycle.rename(positional[0], positional[1], options.has('--ignore-process-check'));
    }
    if (command === 'remove') {
      return await lifecycle.remove(positional[0], options.has('--ignore-process-check'));
    }
    if (command === 'repair') {
      return await lifecycle.repair(positional[0], options.has('--refresh-dock'));
    }
    if (command === 'desktop-updates') {
      return await lifecycle.updates(positional[0], positional[1]);
    }
    if (command === 'copy-setup') {
      return await new TransferActions(lifecycle).copy(positional[0], positional[1], options.has('--replace-selected'));
    }
    if (command === 'doctor' && options.has('--recover')) {
      out(`ben-claude-multi ${releaseVersion}; installation: ${services.cli}`);
      const recovery = new RecoveryActions(lifecycle, ctx.healthServices ?? productionHealthServices(ctx.env));
      return await recovery.recover(options.get('--recover') as string);
    }
    if (command === 'doctor') {
      const review = new HealthReview(lifecycle, ctx.healthServices ?? productionHealthServices(ctx.env));
      if (options.has('--apply')) {
        return await review.apply();
      }
      const report = await review.inventory();
      return report.issues.length ? Exit.findings : Exit.ok;
    }
    if (command === 'run-profile' || command === '_run-profile-id') {
      const byId = options.has('--profile-id') || command === '_run-profile-id';
      const selector = (options.get('--profile-id') as string | undefined) ?? positional[0]!;
      return await actions.run(selector, byId, tail);
    }
    throw new Problem('pass-unavailable', 'This command is reserved for a later implementation pass.',
      Exit.unavailable);
  } catch (error) {
    const message = error instanceof Problem ? error.message : 'The operation failed; no completion is claimed.';
    ctx.output.write(terminalText(message) + '\n');
    return error instanceof Problem ? error.status : Exit.failure;
  } finally {
    dialogue.close();
  }
}
