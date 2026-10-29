import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireHomeIsolation } from './isolation.js';
import { execute, systemTools } from '../src/machine-services.js';
import { nativeCensus, desktopNativeCensus, codeLiveness, desktopState } from '../src/process-census.js';
import type { Profile } from '../src/profile-catalog.js';
import { Problem } from '../src/outcomes.js';

const root = requireHomeIsolation();
if (process.env.BCM_TEST_BOUNDARY !== 'native-census') {
  throw new Error('Native census checks require their separate isolated entry point.');
}
const storage = mkdtempSync(join(root, 'native-census-'));
const blocked = (value: string) =>
/Operation not permitted|not allowed|sandbox|not available|not authorized/i.test(value);
function unavailable(error: unknown): boolean {
  return error instanceof Problem && error.kind === 'tool-bound';
}
async function censusCapability(context: TestContext): Promise<boolean> {
  try {
    const probe = await execute(systemTools.ps, ['-axww', '-o', 'pid=,uid=,comm=']);
    if (probe.code !== 0 && blocked(probe.stderr)) {
      context.skip('UNAVAILABLE: the sandbox blocks native ps process inspection.');
      return false;
    }
    assert.equal(probe.code, 0, 'Native ps inventory capability failed.');
    return true;
  } catch (error) {
    if (unavailable(error) || ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('UNAVAILABLE: native ps process inspection is blocked or exceeded its bounds.');
      return false;
    }
    throw error;
  }
}
function unusedProfile(): Profile {
  return { code: { location: join(storage, 'unused-' + randomUUID()) } } as Profile;
}
test('T061 T066 S40 S41 native Code census stays available and idle for 20 unused-profile checks', async context => {
  if (!await censusCapability(context)) {
    return;
  }
  const profile = unusedProfile();
  for (let attempt = 0; attempt < 20; attempt++) {
    const census = await nativeCensus([profile]);
    assert.equal(census.available, true, `Code census unavailable on iteration ${attempt + 1}.`);
    assert.equal(codeLiveness(profile, census, process.getuid!(), process.pid).state, 'idle');
  }
});
test('T062 T066 S40 S41 native Desktop census is available and an unused location is idle', async context => {
  if (!await censusCapability(context)) {
    return;
  }
  const census = await desktopNativeCensus();
  assert.equal(census.available, true, 'Desktop census must parse the native process inventory.');
  assert.equal(desktopState(join(storage, 'unused-' + randomUUID()),
    join(storage, 'unused/Claude.app/Contents/MacOS/Claude'), census, process.getuid!()).kind, 'idle');
});
for (const name of ['claude', '2.1.999']) {
  test(`T061 S41 S42 native Code census detects its synthetic ${name} child then returns idle`, async context => {
    if (!await censusCapability(context)) {
      return;
    }
    const executable = join(storage, name);
    symlinkSync(process.execPath, executable);
    const profile = unusedProfile();
    const child = spawn(executable, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: storage, stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: profile.code!.location },
    });
    await once(child, 'spawn');
    const exited = once(child, 'exit');
    try {
      let active = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const census = await nativeCensus([profile]);
        if (!census.available) {
          await new Promise(resolve => setTimeout(resolve, 50));
          continue;
        }
        const state = codeLiveness(profile, census, process.getuid!(), process.pid);
        active = state.state === 'active' && state.pids.includes(child.pid!);
        if (active) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(active, true, 'The synthetic child must be detected without printing any environment.');
    } finally {
      // This handle belongs exclusively to the child created above, never a discovered application.
      child.kill('SIGTERM');
      await exited;
    }
    const after = await nativeCensus([profile]);
    assert.equal(after.available, true);
    assert.equal(codeLiveness(profile, after, process.getuid!(), process.pid).state, 'idle');
  });
}
