import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Problem, Exit } from './outcomes.js';
export const systemTools = Object.freeze({
  ps: '/bin/ps',
  sysctl: '/usr/sbin/sysctl',
  ls: '/bin/ls',
  open: '/usr/bin/open',
  codesign: '/usr/bin/codesign',
  osascript: '/usr/bin/osascript',
  osacompile: '/usr/bin/osacompile',
  osadecompile: '/usr/bin/osadecompile'
});
export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
  pid?: number;
}
export function toolOutputCap(file: string, args: readonly string[]): number {
  const mib = 1024 * 1024;
  if (file === systemTools.ps) {
    if (args.includes('-u') && args.some(arg => arg.includes('E'))) {
      return 32 * mib;
    }
    return args.some(arg => arg.startsWith('-a') || arg.startsWith('-x')) ? 8 * mib : mib;
  }
  // Configuration documents may reach the private reader's 16 MiB bound.
  if (['/usr/bin/plutil', '/usr/bin/git', systemTools.osadecompile].includes(file)) {
    return 16 * mib;
  }
  // Deep signature failures and copy diagnostics can enumerate many nested members.
  if ([systemTools.codesign, '/bin/cp', '/usr/bin/ditto'].includes(file) || file.endsWith('/gh')) {
    return 8 * mib;
  }
  if ([systemTools.osascript, systemTools.osacompile, '/bin/launchctl'].includes(file)
    || file.endsWith('/lsregister')) {
    return mib;
  }
  return 256 * 1024;
}
export function execute(file: string, args: readonly string[], options: {
  timeout?: number;
  cap?: number;
  env?: NodeJS.ProcessEnv
} = {}): Promise<ToolResult> {
  if (!isAbsolute(file)) {
    return Promise.reject(new Problem('tool-path', 'A tool needs an absolute executable path.'));
  }
  return new Promise((resolve, reject) => {
    const timeout = Math.min(Math.max(options.timeout ?? 5000, 1), 120000);
    const cap = Math.min(Math.max(options.cap ?? toolOutputCap(file, args), 1), 32 * 1024 * 1024);
    const child = execFile(file, [...args], {
      encoding: 'utf8',
      timeout,
      maxBuffer: cap,
      env: options.env ?? process.env
    }, (error, stdout, stderr) => {
      if (error && (error.killed || typeof error.code !== 'number')) {
        reject(new Problem('tool-bound', 'A system command failed or exceeded its execution limits.',
          Exit.failure));
      } else {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr,
          ...(child.pid === undefined ? {} : { pid: child.pid }) });
      }
    });
  });
}
export function executableCandidates(name: 'node' | 'claude' | 'gh', path: string): string[] {
  const result: string[] = [];
  for (const directory of path.split(':')) {
    if (!isAbsolute(directory)) {
      continue;
    }
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile() && !result.includes(candidate)) {
        result.push(candidate);
      }
    } catch {
      /* Unavailable PATH entry. */
    }
  }
  return result;
}
export function parentAclAllowsReplacement(path: string): boolean {
  if (process.platform !== 'darwin') {
    throw new Problem('acl-unavailable', 'macOS ACL inspection is unavailable.',
      Exit.unavailable);
  }
  const result = spawnSync(systemTools.ls, ['-lde', path], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
  });
  if (result.status !== 0) {
    throw new Problem('acl-unreadable', 'Cannot establish parent ACL safety.');
  }
  // Refuse grants conservatively, including unknown principals and inherited entries.
  return result.stdout.split('\n').slice(1).some(line => /\ballow\b/.test(line) &&
    /\b(add_file|add_subdirectory|delete_child|delete|write|writeattr|writeextattr|chown|writesecurity)\b/.test(line));
}
export interface ProcessIdentity {
  boot: string;
  start: string
}
export interface IdentityService {
  self(): Promise<ProcessIdentity>;
  inspect(pid: number): Promise<{
    state: 'dead'
  } | {
    state: 'unknown'
  } | ({ state: 'alive' } & ProcessIdentity)>;
}
export function nativeIdentities(): IdentityService {
  async function boot(): Promise<string> {
    const r = await execute(systemTools.sysctl, ['-n', 'kern.boottime']);
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Problem('boot-unreadable', 'Cannot establish boot identity.');
    }
    return r.stdout.trim();
  }
  async function start(pid: number): Promise<string | undefined> {
    const r = await execute(systemTools.ps, ['-p', String(pid), '-o', 'lstart='], {
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    });
    return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }
  return {
    async self() {
      const b = await boot(),
      s = await start(process.pid);
      if (!s) {
        throw new Problem('start-unreadable', 'Cannot establish this process identity.');
      }
      return { boot: b, start: s };
    },
    async inspect(pid) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          return { state: 'dead' };
        }
        return { state: 'unknown' };
      }
      try {
        const b = await boot(),
        s = await start(pid);
        return s ? {
          state: 'alive',
          boot: b,
          start: s
        } : { state: 'unknown' };
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}
