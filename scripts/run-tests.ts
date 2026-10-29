import { scratchIdentity, removeScratch } from './scratch-directory.js';
import { mkdtempSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
if (process.platform !== 'darwin') {
  console.error('UNAVAILABLE: macOS sandbox-exec is required; no tests ran.');
  process.exitCode = 69;
} else {
  const profileRoot = realpathSync(mkdtempSync(join('/private/tmp', 'bcm-test-')));
  const scratch = scratchIdentity(profileRoot);
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    BCM_TEST_ROOT: profileRoot,
    BCM_TEST_BOUNDARY: 'seatbelt',
    BCM_TEST_REPO: repo,
    BCM_TEST_NPM: process.env.npm_execpath ?? '',
  };
  const redirected = {
    HOME: 'home',
    CFFIXED_USER_HOME: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
    npm_config_cache: 'npm',
  };
  for (const [key, name] of Object.entries(redirected)) {
    env[key] = join(profileRoot, name);
    mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  const policy = [
    '(version 1) (allow default) (deny network*) (deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(profileRoot)}))`,
  ].join(' ');
  try {
    const probe = spawnSync('/usr/bin/sandbox-exec', [
      '-p', policy, process.execPath, '-e', 'process.stdout.write("boundary-ready")',
    ], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    const inner = probe.status === 0 && probe.stdout === 'boundary-ready';
    const nestedRefusal = probe.status === 71
    && probe.stderr?.includes('sandbox_apply: Operation not permitted');
    // Development-only fallback relies on an existing outer seatbelt, never on this flag alone.
    const outer = !inner && nestedRefusal && process.env.BCM_TEST_OUTER_SANDBOX === '1';
    if (!inner && !outer) {
      console.error('UNAVAILABLE: sandbox-exec could not establish the boundary; no tests ran.');
      process.exitCode = 69;
    } else {
      if (outer) {
        console.error('WARNING: INNER WRITE AND NETWORK BOUNDARY NOT APPLIED; using authorized outer seatbelt.');
        env.BCM_TEST_BOUNDARY = 'outer-seatbelt';
        env.BCM_TEST_OUTER_SANDBOX = '1';
      }
      const directory = resolve(repo, 'dist/test');
      const native = process.argv[2] === 'native';
      const suites = native
      ? ['native.test.js']
      : readdirSync(directory).filter(name =>
        name.endsWith('.test.js') && !['native.test.js', 'native-census.test.js'].includes(name));
      if (!suites.length) {
        throw new Error('No compiled test suites were found.');
      }
      const testArgs = ['--test',
        ...suites.map(name => join(directory, name))];
      const result = inner
      ? spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, ...testArgs],
        { env, stdio: 'inherit', timeout: 300000, })
      : spawnSync(process.execPath, testArgs, { env, stdio: 'inherit', timeout: 300000 });
      process.exitCode = result.status ?? 1;
      if (native) {
        console.error('NATIVE CENSUS: running without the inner seatbelt because setuid ps cannot execute there.');
        console.error('Temporary HOME/XDG/TMPDIR and the real-home guard remain; checks read process tables '
          + 'and spawn only their own child.');
        const census = spawnSync(process.execPath, ['--test', join(directory, 'native-census.test.js')], {
          env: { ...env, BCM_TEST_BOUNDARY: 'native-census' }, stdio: 'inherit', timeout: 300000,
        });
        process.exitCode ||= census.status ?? 1;
      }
    }
  } finally {
    removeScratch(profileRoot, scratch);
  }
}
