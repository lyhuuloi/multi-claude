import { realpathSync, lstatSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep, join, dirname, resolve } from 'node:path';
import { userInfo } from 'node:os';
export function inside(root: string, value: string): boolean {
  const r = relative(root, value);
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
}
// Import this before a test can create fixtures, including direct node --test use.
export function requireHomeIsolation(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BCM_TEST_ROOT;
  if (!root || !isAbsolute(root)) {
    throw new Error('Tests require a declared temporary profile directory.');
  }
  const actualRoot = realpathSync(root);
  const accountHome = userInfo().homedir;
  const stat = lstatSync(actualRoot);
  if (!actualRoot.startsWith('/private/tmp/bcm-test-') || !stat.isDirectory() || stat.uid !== process.getuid!() ||
    (stat.mode & 0o777) !== 0o700) {
    throw new Error('Tests require a private temporary profile directory.');
  }
  for (const key of ['HOME', 'CFFIXED_USER_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TMPDIR',
    'TMP', 'TEMP', 'npm_config_cache']) {
    const value = env[key];
    if (!value || !isAbsolute(value) || resolve(value) === accountHome) {
      throw new Error(`Unsafe test ${key}.`);
    }
    const actual = realpathSync(value);
    if (actual === accountHome || !inside(actualRoot, actual)) {
      throw new Error(`Test ${key} escaped its temporary profile.`);
    }
  }
  return actualRoot;
}
export function requireIsolation(env: NodeJS.ProcessEnv = process.env): string {
  const actualRoot = requireHomeIsolation(env);
  if (env.BCM_TEST_BOUNDARY === 'outer-seatbelt' && env.BCM_TEST_OUTER_SANDBOX === '1') {
    const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)',
      '/usr/bin/true'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, });
    if (probe.status === 71 && probe.stderr.includes('sandbox_apply: Operation not permitted')) {
      return actualRoot;
    }
    throw new Error('The authorized outer sandbox could not be confirmed.');
  }
  if (env.BCM_TEST_BOUNDARY !== 'seatbelt') {
    throw new Error('The macOS test boundary is required.');
  }
  // A harness flag alone cannot certify the kernel write boundary.
  const outside = join(dirname(actualRoot), `.bcm-boundary-${randomUUID()}`);
  try {
    writeFileSync(outside, '', { flag: 'wx', mode: 0o600 });
  }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return actualRoot;
    }
    throw error;
  }
  unlinkSync(outside);
  throw new Error('The kernel test write boundary is absent.');
}
