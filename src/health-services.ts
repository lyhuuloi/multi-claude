import { openSync, fstatSync, closeSync, readFileSync, realpathSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execute } from './machine-services.js';
import type { NativeTool } from './claude-authenticity.js';
export interface HealthServices {
  tool: NativeTool;
  codeVersion(executable: string): Promise<string | null>;
}
export function localExecutableVersion(executable: string): string | null {
  try {
    const target = realpathSync(executable);
    let parent = dirname(target);
    for (let level = 0; level < 3; level++) {
      const path = join(parent, 'package.json');
      try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024
            || (stat.uid !== 0 && stat.uid !== process.getuid!())) {
            return null;
          }
          const value = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
          const bins = typeof value.bin === 'string' ? [value.bin]
          : value.bin && typeof value.bin === 'object' ? Object.values(value.bin) : [];
          if (bins.some(bin => typeof bin === 'string' && resolve(parent, bin) === target)) {
            return typeof value.version === 'string' ? value.version : null;
          }
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return null;
        }
      }
      parent = dirname(parent);
    }
  } catch {
    return null;
  }
  return null;
}
export function productionHealthServices(env: NodeJS.ProcessEnv): HealthServices {
  return {
    tool: (file, args) => execute(file, args, {
      timeout: 15000,
      env: {
        HOME: env.HOME ?? '', XDG_CONFIG_HOME: env.XDG_CONFIG_HOME ?? '',
        CFFIXED_USER_HOME: env.HOME ?? '', TMPDIR: env.TMPDIR ?? '/private/tmp',
        PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      },
    }),
    codeVersion: async executable => localExecutableVersion(executable),
  };
}
