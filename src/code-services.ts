import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executableCandidates, nativeIdentities, execute, systemTools } from './machine-services.js';
import type { IdentityService } from './machine-services.js';
import { nativeCensus } from './process-census.js';
import type { Profile } from './profile-catalog.js';
import type { Census } from './process-census.js';
import { stableNodePath } from './shell-entries.js';
import { Exit, Problem } from './outcomes.js';
export interface StartedCode {
  started: Promise<void>;
  completion: Promise<number>;
}
export interface CodeServices {
  identities: IdentityService;
  census(profiles?: readonly Profile[]): Promise<Census>;
  sessionStart(): Promise<number | null>;
  runtime(path: string): string;
  cli: string;
  executables(name: 'claude' | 'gh', path: string): string[];
  start(file: string, args: string[], env: NodeJS.ProcessEnv): StartedCode;
  checkpoint?(stage: string): void | Promise<void>;
}
export function productionCodeServices(): CodeServices {
  return {
    identities: nativeIdentities(),
    census: profiles => nativeCensus(profiles),
    async sessionStart() {
      try {
        const value = await execute(systemTools.ps, ['-p', String(process.ppid), '-o', 'lstart='], {
          env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        });
        const time = value.code === 0 ? Date.parse(value.stdout.trim()) : NaN;
        return Number.isFinite(time) ? time : null;
      } catch {
        return null;
      }
    },
    runtime: path => stableNodePath(process.execPath, path),
    cli: fileURLToPath(new URL('./main.js', import.meta.url)),
    executables: executableCandidates,
    start(file, args, env) {
      const child = spawn(file, args, { env, stdio: 'inherit', cwd: process.cwd() });
      const started = new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(new Problem('code-start', 'Claude Code could not be started.',
          Exit.failure)));
      });
      const interrupt = () => child.kill('SIGINT');
      const terminate = () => child.kill('SIGTERM');
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      const completion = new Promise<number>(resolve => {
        const cleanup = () => {
          process.off('SIGINT', interrupt);
          process.off('SIGTERM', terminate);
        };
        child.once('error', () => {
          cleanup();
          resolve(Exit.failure);
        });
        child.once('exit', (code, signal) => {
          cleanup();
          resolve(code ?? (signal === 'SIGINT' ? Exit.interrupted : Exit.failure));
        });
      });
      return { started, completion };
    },
  };
}
