import { basename, dirname, isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLocation } from './location-guard.js';
import { execute, systemTools } from './machine-services.js';
import type { Profile } from './profile-catalog.js';
import type { NativeTool } from './claude-authenticity.js';
import type { ToolResult } from './machine-services.js';
export interface ProcessSnapshot {
  pid: number;
  uid: number;
  executable: string;
  environment: Record<string, string> | null;
  argv: string[];
}
export interface Census {
  available: boolean;
  processes: ProcessSnapshot[];
  observations?: {
    id: string;
    label: string;
    location: string;
    uid: number;
    active: number[];
    unknown: number[];
  }[];
}
export interface Liveness {
  state: 'idle' | 'active' | 'unknown';
  pids: number[];
}
function codePath(executable: string): boolean {
  const path = executable.replace(/\/$/, '');
  return basename(path) === 'claude' || basename(dirname(path)).toLowerCase() === 'claude'
    || /(?:^|\/)claude(?:\/[^/]+)*\/versions\/\d+\.\d+\.\d+(?:[-+][^/]+)?$/i.test(path);
}
function codeCandidate(executable: string, argv: readonly string[]): boolean {
  return codePath(executable) || (basename(executable) === 'node' && argv.some(arg => codePath(arg)
    || /(?:^|\/)claude-code(?:\/|$)/.test(arg)))
    || (/\/Claude\.app\/Contents\//i.test(executable)
      && /claude[- ]?code/i.test([executable, ...argv].join(' ')));
}
function comparablePath(path: string): string | null {
  try {
    if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)
      || path.split('/').some(part => part === '.' || part === '..')) {
      return null;
    }
    const spelling = posix.normalize(path).replace(/\/$/, '').replace(/^\/System\/Volumes\/Data(?=\/)/, '') || '/';
    return canonicalLocation(spelling).replace(/^\/System\/Volumes\/Data(?=\/)/, '').replace(/\/$/, '');
  } catch {
    return null;
  }
}
function selections(location: string): string[] {
  const canonical = comparablePath(location);
  if (!canonical) {
    return [];
  }
  return [...new Set([location.replace(/\/$/, ''), canonical, '/System/Volumes/Data' + canonical])];
}
const currentCli = fileURLToPath(new URL('./main.js', import.meta.url));
function profileRoute(profile: Profile, argv: readonly string[], command = argv.join(' ')): boolean {
  const routes = [currentCli, profile.code?.cli, profile.desktop?.cli,
    ...argv.filter(arg => ['multi-claude', 'ben-claude-multi'].includes(basename(arg)))];
  const spellings = routes.filter((path): path is string => typeof path === 'string').flatMap(path => {
    const base = path.replace(/^\/System\/Volumes\/Data(?=\/)/, '');
    return isAbsolute(base) ? [path, base, '/System/Volumes/Data' + base] : [path];
  });
  for (const cli of spellings) {
    const prefix = cli + ' run-profile ';
    const position = command.indexOf(prefix);
    if (position < 0 || (position > 0 && !/\s/.test(command[position - 1]!))) {
      continue;
    }
    const tail = command.slice(position + prefix.length).split(/\s+/);
    const end = tail.indexOf('--');
    const args = end < 0 ? tail : tail.slice(0, end);
    if (args[0] === profile.label
      || args.some((arg, index) => arg === '--profile-id' && args[index + 1] === profile.id)) {
      return true;
    }
  }
  return false;
}
export function codeLiveness(profile: Profile, census: Census, uid: number, currentPid: number): Liveness {
  if (!profile.code || !census.available) {
    return { state: 'unknown', pids: [] };
  }
  if (!selections(profile.code.location).length) {
    return { state: 'unknown', pids: [] };
  }
  if (census.observations) {
    const observation = census.observations.find(item => item.id === profile.id && item.label === profile.label
      && item.location === profile.code!.location && item.uid === uid);
    if (!observation) {
      return { state: 'unknown', pids: [] };
    }
    const pids = observation.active.filter(pid => pid !== currentPid);
    const unknown = observation.unknown.some(pid => pid !== currentPid);
    return { state: pids.length ? 'active' : unknown ? 'unknown' : 'idle', pids };
  }
  let unknown = false;
  const pids: number[] = [];
  for (const item of census.processes) {
    if (item.pid === currentPid || item.uid !== uid) {
      continue;
    }
    const selected = item.environment?.CLAUDE_CONFIG_DIR;
    const matches = selections(profile.code.location).some(root => selected?.startsWith(root));
    if (profileRoute(profile, item.argv) || matches) {
      pids.push(item.pid);
    } else if (item.environment === null && codeCandidate(item.executable, item.argv)) {
      unknown = true;
    }
  }
  return { state: pids.length ? 'active' : unknown ? 'unknown' : 'idle', pids };
}
const censusTool: NativeTool = (file, args) => execute(file, args, {
  env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
});
export type CodeCensusTool = (file: string, args: readonly string[], limits: {
  timeout: number;
  cap: number;
}) => Promise<ToolResult>;
interface BoundProcess {
  uid: number;
  start: string;
  value: string;
}
// Classify the requested profiles before returning; no environment bytes leave this collector.
export async function nativeCensus(
  profiles: readonly Profile[] = [],
  tool: CodeCensusTool = (file, args, limits) => execute(file, args, {
    ...limits, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
  }),
  deadlineMs = 10000,
): Promise<Census> {
  const uid = process.getuid!();
  const deadline = performance.now() + deadlineMs;
  const unavailable = (): Census => ({ available: false, processes: [] });
  async function sample(): Promise<{ census: Census; retry: boolean } | null> {
    const snapshots: Map<number, BoundProcess>[] = [];
    const raw: ToolResult[] = [];
    try {
      for (const field of ['comm', 'command', 'environment', 'start']) {
        const remaining = Math.floor(deadline - performance.now());
        if (remaining < 1) {
          return null;
        }
        const expanded = field === 'environment';
        const columns = 'pid=,uid=,lstart=' + (field === 'start' ? '' : ',' + (expanded ? 'command' : field) + '=');
        // -a would union other users into the selection; -x includes this uid's processes without terminals.
        const args = [expanded ? '-xwwE' : '-xww', '-u', String(uid), '-o', columns];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: ToolResult;
        try {
          result = await Promise.race([
            tool(systemTools.ps, args, { timeout: remaining, cap: (expanded ? 32 : 8) * 1024 * 1024 }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Process census deadline exceeded.')), remaining);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        raw.push(result);
        if (result.code !== 0 || performance.now() >= deadline) {
          return null;
        }
        const records = new Map<number, BoundProcess>();
        snapshots.push(records);
        for (const row of result.stdout.split('\n').filter(line => line.trim())) {
          const head = row.match(/^\s*(\d+)\s+(-?\d+)(?:\s+(.*))?$/);
          if (!head) {
            return null;
          }
          if (Number(head[2]) !== uid) {
            continue;
          }
          const body = head[3]?.match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})(?:\s+(.*))?$/);
          if (!body || !Number.isFinite(Date.parse(body[1]!)) || records.has(Number(head[1]))
            || (field === 'comm' && !body[2]?.trim())) {
            return null;
          }
          records.set(Number(head[1]), { uid, start: body[1]!.replace(/\s+/g, ' '), value: body[2] ?? '' });
        }
        result.stdout = '';
        result.stderr = '';
      }
      const [names, plain, expanded, starts] = snapshots;
      const observations = profiles.filter(profile => profile.code).map(profile => ({
        id: profile.id, label: profile.label, location: profile.code!.location, uid, active: [] as number[],
        unknown: [] as number[],
      }));
      const targets = observations.map(observation => ({
        observation, profile: profiles.find(profile => profile.id === observation.id)!,
        roots: selections(observation.location), persistent: new Set<number>(), transient: new Set<number>(),
      }));
      // Processes first seen after the environment snapshot are outside this check.
      // The shared lease serializes launches.
      const pids = new Set(snapshots.slice(0, 3).flatMap(snapshot => [...snapshot.keys()]));
      for (const pid of pids) {
        if (performance.now() >= deadline) {
          return null;
        }
        const identity = names!.get(pid);
        const commandRow = plain!.get(pid);
        const environmentRow = expanded!.get(pid);
        const peers = [identity, commandRow, environmentRow, starts!.get(pid)];
        const complete = !!identity && peers.every(peer => peer
          && peer.uid === identity.uid && peer.start === identity.start);
        const command = commandRow?.value.trimEnd() ?? '';
        const line = environmentRow?.value.trimEnd() ?? '';
        const readable = command.length > 0 && line.startsWith(command) && line.length > command.length;
        const commands = [command, line].filter(Boolean);
        const argumentsSeen = commands.map(value => ({ value, argv: value.split(/\s+/) }));
        const candidate = argumentsSeen.some(item => codeCandidate(item.argv[0] ?? '', item.argv))
          || (!!identity && codeCandidate(identity.value, argumentsSeen.flatMap(item => item.argv)));
        for (const { observation, profile, roots, persistent, transient } of targets) {
          if (performance.now() >= deadline) {
            return null;
          }
          const selected = roots.some(root => line.includes('CLAUDE_CONFIG_DIR=' + root));
          const routed = argumentsSeen.some(item => profileRoute(profile, item.argv, item.value));
          if (selected || (complete && profileRoute(profile, command.split(/\s+/), command))) {
            observation.active.push(pid);
          } else if (!roots.length || (complete && !readable && candidate)) {
            observation.unknown.push(pid);
            persistent.add(pid);
          } else if (!complete && (candidate || routed)) {
            observation.unknown.push(pid);
            transient.add(pid);
          }
        }
      }
      const retry = targets.some(({ observation, persistent, transient }) =>
        !observation.active.some(pid => pid !== process.pid) && [...transient].some(pid => pid !== process.pid)
        && ![...persistent].some(pid => pid !== process.pid));
      return { census: { available: true, processes: [], observations }, retry };
    } finally {
      for (const result of raw) {
        result.stdout = '';
        result.stderr = '';
      }
      snapshots.forEach(snapshot => snapshot.clear());
    }
  }
  const activeByProfile = new Map<string, Set<number>>();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sample();
      if (!result || performance.now() >= deadline) {
        return unavailable();
      }
      for (const observation of result.census.observations ?? []) {
        const active = activeByProfile.get(observation.id) ?? new Set<number>();
        observation.active.forEach(pid => active.add(pid));
        activeByProfile.set(observation.id, active);
        observation.active = [...active];
      }
      if (!result.retry || attempt === 2) {
        return result.census;
      }
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

export interface DesktopProcess {
  pid: number;
  uid: number;
  start: string;
  executable: string;
  bundle: string;
  bundleId: string;
  data: string | null;
  uncertain: boolean;
}
export interface DesktopCensus {
  available: boolean;
  processes: DesktopProcess[];
}
export interface DesktopState {
  kind: 'idle' | 'correct' | 'wrong' | 'unknown';
  correct: DesktopProcess[];
  wrong: DesktopProcess[];
}
export function desktopState(
  data: string, executable: string, census: DesktopCensus, uid: number, currentPid = process.pid,
): DesktopState {
  const correct: DesktopProcess[] = [];
  const wrong: DesktopProcess[] = [];
  const expectedData = comparablePath(data);
  const expectedExecutable = comparablePath(executable);
  let unknown = !census.available || !expectedData || !expectedExecutable;
  for (const item of census.processes) {
    if (item.pid === currentPid || item.uid !== uid) {
      continue;
    }
    const observedExecutable = comparablePath(item.executable);
    const observedData = item.data === null ? null : comparablePath(item.data);
    if (item.bundleId === 'com.anthropic.claudefordesktop'
      && (!observedExecutable || (item.data !== null && !observedData))) {
      unknown = true;
      continue;
    }
    const dedicated = observedExecutable !== null && observedExecutable === expectedExecutable;
    const selected = observedData !== null && observedData === expectedData;
    if (!dedicated && !(selected && item.bundleId === 'com.anthropic.claudefordesktop')) {
      unknown ||= item.uncertain && (!item.bundleId || item.bundleId === 'com.anthropic.claudefordesktop');
      continue;
    }
    if (item.uncertain || !item.start || item.uid !== uid
      || item.bundleId !== 'com.anthropic.claudefordesktop') {
      unknown = true;
    } else if (selected) {
      correct.push(item);
    } else {
      wrong.push(item);
    }
  }
  return { kind: unknown ? 'unknown' : correct.length ? 'correct' : wrong.length ? 'wrong' : 'idle', correct, wrong };
}
export function sameDesktopProcess(left: DesktopProcess, right: DesktopProcess): boolean {
  return !right.uncertain && left.pid === right.pid && left.uid === right.uid && left.start === right.start
  && left.executable === right.executable && left.bundle === right.bundle && left.bundleId === right.bundleId
  && left.data === right.data;
}
export async function desktopNativeCensus(
  tool: NativeTool = censusTool,
): Promise<DesktopCensus> {
  try {
    const names = await tool(systemTools.ps, ['-axww', '-o', 'pid=,uid=,comm=']);
    const argumentsList = await tool(systemTools.ps, ['-axww', '-o', 'pid=,command=']);
    if (names.code !== 0 || argumentsList.code !== 0) {
      return { available: false, processes: [] };
    }
    const argumentsByPid = new Map<number, string>();
    for (const row of argumentsList.stdout.split('\n').filter(line => line.trim())) {
      const fields = row.match(/^\s*(\d+)\s+(.*)$/);
      if (fields) {
        argumentsByPid.set(Number(fields[1]), fields[2]!);
      }
    }
    const processes: DesktopProcess[] = [];
    for (const row of names.stdout.split('\n').filter(line => line.trim())) {
      const fields = row.match(/^\s*(\d+)\s+(-?\d+)(?:\s+(.*))?$/);
      if (!fields) {
        return { available: false, processes: [] };
      }
      if (Number(fields[2]) !== process.getuid!()) {
        continue;
      }
      const executable = fields[3] ?? '';
      if (!executable.includes('/Contents/MacOS/') || basename(executable) !== 'Claude') {
        continue;
      }
      const pid = Number(fields[1]);
      const bundle = executable.slice(0, executable.indexOf('/Contents/MacOS/'));
      const start = await tool(systemTools.ps, ['-p', String(pid), '-o', 'lstart=']);
      const identifier = await tool('/usr/bin/plutil', [
        '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', bundle + '/Contents/Info.plist',
      ]);
      const args = argumentsByPid.get(pid);
      const selected = args?.match(/(?:^|\s)--user-data-dir(?:=|\s+)(\/[^\s]+)(?=\s--|$)/);
      const hasSelector = args?.includes('--user-data-dir') ?? false;
      processes.push({
        pid, uid: Number(fields[2]), start: start.code === 0 ? start.stdout.trim() : '', executable, bundle,
        bundleId: identifier.code === 0 ? identifier.stdout.trim() : '', data: selected?.[1] ?? null,
        uncertain: args === undefined || (hasSelector && !selected) || start.code !== 0 || identifier.code !== 0
        || (args?.match(/--user-data-dir/g)?.length ?? 0) > 1,
      });
    }
    return { available: true, processes };
  } catch {
    return { available: false, processes: [] };
  }
}
