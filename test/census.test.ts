import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeLiveness, desktopState, nativeCensus, desktopNativeCensus } from '../src/process-census.js';
import { execute, systemTools, toolOutputCap } from '../src/machine-services.js';
import type { CodeCensusTool } from '../src/process-census.js';
import { installProfile, profileFixture } from './support.js';

interface Candidate {
  pid: number;
  executable: string;
  command: string;
  suffix: string | null;
}
const started = 'Fri Oct 30 10:00:00 2026';
function toolFor(entries: Candidate[], extraNames = '') {
  const uid = process.getuid!();
  const calls: string[][] = [];
  const tool: CodeCensusTool = async (file, args, limits) => {
    assert.equal(file, systemTools.ps);
    assert.deepEqual(args.slice(1, 3), ['-u', String(uid)]);
    assert.equal(args.some(arg => arg.startsWith('-a')), false, 'Never union other users into the environment read');
    assert.ok(limits.timeout > 0 && limits.timeout <= 10000);
    const expanded = args[0] === '-xwwE';
    assert.equal(limits.cap, (expanded ? 32 : 8) * 1024 * 1024);
    calls.push([...args]);
    const names = args.at(-1)!.endsWith('comm=');
    const startOnly = args.at(-1)!.endsWith('lstart=');
    const rows = entries.map(item => {
      const value = names ? item.executable : startOnly ? '' : item.command + (expanded ? item.suffix ?? '' : '');
      return `${item.pid} ${uid} ${started} ${value}`;
    });
    return { code: 0, stdout: extraNames + rows.join('\n') + '\n', stderr: '' };
  };
  return { tool, calls };
}

test('T061 T066 S40 S41 busy inventories skip negative and foreign uids before reading environments', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const foreign = `17 -2 /usr/sbin/distnoted\n18 -2 /usr/libexec/dhcp6d\n19 -2\n`
    + Array.from({ length: 12000 }, (_, index) => `${index + 10000} -2 /foreign/process-${index}\n`).join('');
  assert.ok(Buffer.byteLength(foreign) > 256 * 1024);
  const { tool, calls } = toolFor([
    { pid: 101, executable: '/native/claude.app/Contents/MacOS/claude', command: 'claude',
      suffix: ' HOME=/synthetic CLAUDE_CONFIG_DIR=' + profile.code!.location },
    { pid: 102, executable: '/usr/bin/node', command: 'node /project/unrelated-cli.js', suffix: null },
  ], foreign);
  const census = await nativeCensus([profile], tool);
  assert.equal(census.available, true);
  assert.deepEqual(codeLiveness(profile, census, f.io.guard.uid, 999), { state: 'active', pids: [101] });
  assert.equal(census.processes.length, 0);
  assert.equal(calls.filter(args => args.includes('-xwwE')).length, 1);
  assert.equal(calls.some(args => args.at(-1) === '17' || args.at(-1) === '19'), false);
});

for (const entry of ['native', 'node']) {
  for (const selection of ['own', 'data-volume', 'trailing-slash', 'prefix', 'other', 'baseline', 'unreadable']) {
    test(`T061 T066 T067 S40 S41 ${entry} environment ${selection} classifies safely`, async () => {
      const f = profileFixture();
      const profile = installProfile(f);
      const location = profile.code!.location;
      const values: Record<string, string | null> = {
        own: ' CLAUDE_CONFIG_DIR=' + location + ' API_TOKEN=private-sentinel',
        'data-volume': ' CLAUDE_CONFIG_DIR=/System/Volumes/Data' + location + '/',
        'trailing-slash': ' CLAUDE_CONFIG_DIR=' + location + '/ ',
        prefix: ' CLAUDE_CONFIG_DIR=' + location + '-longer/child',
        other: ' CLAUDE_CONFIG_DIR=/another/profile HOME=/synthetic',
        baseline: ' HOME=/synthetic PATH=/usr/bin:/bin',
        unreadable: null,
      };
      const command = entry === 'node'
        ? '/usr/bin/node /opt/npm/@anthropic-ai/claude-code/cli.js --resume'
        : '/apps/claude.app/Contents/MacOS/claude --resume';
      const { tool } = toolFor([{
        pid: 103, executable: entry === 'node' ? '/usr/bin/node' : '/apps/claude.app/Contents/MacOS/claude',
        command, suffix: values[selection]!,
      }]);
      const census = await nativeCensus([profile], tool);
      assert.equal(census.available, true);
      const state = codeLiveness(profile, census, f.io.guard.uid, 999);
      const expected = selection === 'unreadable' ? 'unknown'
        : ['other', 'baseline'].includes(selection) ? 'idle' : 'active';
      assert.equal(state.state, expected);
      assert.deepEqual(state.pids, expected === 'active' ? [103] : []);
    });
  }
}

test('T066 S40 failed environment snapshots and changed command prefixes never claim idle', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  for (const mode of ['error', 'throw', 'changed', 'identity']) {
    const base = toolFor([{ pid: 104, executable: '/usr/bin/claude', command: 'claude', suffix: ' HOME=/test' }]);
    const tool: CodeCensusTool = async (file, args, limits) => {
      if (mode === 'identity' && args.at(-1)!.endsWith('comm=')) {
        return { code: 0, stdout: `104 ${f.io.guard.uid} ${started}`, stderr: '' };
      }
      if (args.includes('-xwwE')) {
        if (mode === 'throw') {
          throw new Error('private-sentinel');
        }
        return { code: mode === 'error' ? 1 : 0,
          stdout: `104 ${f.io.guard.uid} ${started} changed HOME=/test`, stderr: '' };
      }
      return base.tool(file, args, limits);
    };
    const census = await nativeCensus([profile], tool);
    assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'unknown');
  }
});

test('T061 S41 selectors in flattened snapshot lines conservatively block arbitrary executables', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const { tool } = toolFor([{
    pid: 105, executable: '/unrelated/wrapper', command: 'wrapper CLAUDE_CONFIG_DIR=' + profile.code!.location,
    suffix: ' HOME=/synthetic',
  }]);
  const census = await nativeCensus([profile], tool);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'active');
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 105).state, 'idle');
  assert.equal(codeLiveness(profile, census, f.io.guard.uid + 1, 999).state, 'unknown');
});

test('T066 S40 Desktop inventory tolerates negative uids and busy full command output', async () => {
  const uid = process.getuid!();
  const executable = '/applications/Claude.app/Contents/MacOS/Claude';
  const padding = Array.from({ length: 12000 }, (_, index) => `${index + 10000} /foreign/process-${index}\n`).join('');
  assert.ok(Buffer.byteLength(padding) > 256 * 1024);
  const census = await desktopNativeCensus(async (file, args) => {
    let stdout = '';
    if (args.includes('pid=,uid=,comm=')) {
      stdout = `17 -2 /usr/sbin/distnoted\n18 -2\n19 -2 /foreign/Claude.app/Contents/MacOS/Claude\n`
        + `106 ${uid} ${executable}\n`;
    } else if (args.includes('pid=,command=')) {
      stdout = padding + `106 ${executable} --user-data-dir=/different/profile\n`;
    } else if (file === '/usr/bin/plutil') {
      stdout = 'com.anthropic.claudefordesktop';
    } else {
      assert.ok(args.includes('lstart='));
      assert.equal(args[1], '106');
      stdout = 'Thu Oct 29 10:00:00 2026';
    }
    return { code: 0, stdout, stderr: '' };
  });
  assert.equal(census.available, true);
  assert.equal(census.processes.length, 1);
  assert.equal(desktopState('/unused/profile', '/unused/Claude', census, uid).kind, 'idle');
  assert.equal(desktopState('/different/profile', executable, census, uid).kind, 'correct');
});

test('S51 bounded machine tools allow busy inventories and realistic document diagnostics', async () => {
  const mib = 1024 * 1024;
  const table: [string, string[], number][] = [
    [systemTools.ps, ['-axww', '-o', 'pid=,uid=,comm='], 8 * mib],
    [systemTools.ps, ['-axww', '-o', 'pid=,command='], 8 * mib],
    [systemTools.ps, ['-xwwE', '-u', String(process.getuid!()), '-o', 'pid=,uid=,lstart=,command='], 32 * mib],
    [systemTools.ps, ['-wwE', '-o', 'command=', '-p', '1'], mib],
    [systemTools.ps, ['-ww', '-o', 'command=', '-p', '1'], mib],
    [systemTools.codesign, [], 8 * mib],
    ['/usr/bin/plutil', [], 16 * mib],
    [systemTools.osadecompile, [], 16 * mib],
    ['/usr/bin/git', [], 16 * mib],
    ['/fixture/gh', [], 8 * mib],
    ['/fixture/lsregister', ['-f'], mib],
    ['/usr/bin/ditto', [], 8 * mib],
  ];
  for (const [file, args, expected] of table) {
    assert.equal(toolOutputCap(file, args), expected);
  }
  const result = await execute(process.execPath, ['-e', 'process.stdout.write("x".repeat(17*1024*1024))'], {
    cap: toolOutputCap(systemTools.ps, ['-xwwE', '-u', String(process.getuid!())]),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 17 * mib);
  assert.equal(typeof result.pid, 'number');
});

for (const executable of [
  '/local/share/claude/versions/2.1.309',
  '/local/share/claude/current',
  '/unrelated/wrapper-child',
]) {
  test(`T061 S41 S42 environment selection detects ${executable} without a name filter`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    const { tool } = toolFor([{
      pid: 201, executable, command: executable, suffix: ' CLAUDE_CONFIG_DIR=' + profile.code!.location,
    }]);
    const census = await nativeCensus([profile], tool);
    assert.equal(census.available, true);
    assert.deepEqual(codeLiveness(profile, census, f.io.guard.uid, 999), { state: 'active', pids: [201] });
    assert.equal(codeLiveness(profile, {
      available: true, processes: [{ pid: 201, uid: f.io.guard.uid, executable, argv: [],
        environment: { CLAUDE_CONFIG_DIR: profile.code!.location } }],
    }, f.io.guard.uid, 999).state, 'active');
  });
}
for (const selector of ['uuid', 'label']) {
  test(`T061 T065 S41 S42 a waiting run-profile parent alone is active by ${selector}`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    profile.code!.cli = f.home + '/tool with  spaces/main.js';
    const argument = selector === 'uuid' ? '--profile-id ' + profile.id : profile.label;
    const { tool } = toolFor([{
      pid: 202, executable: process.execPath,
      command: `${process.execPath} ${profile.code!.cli} run-profile ${argument}`, suffix: null,
    }]);
    const census = await nativeCensus([profile], tool);
    assert.deepEqual(codeLiveness(profile, census, f.io.guard.uid, 999), { state: 'active', pids: [202] });
  });
}
for (const [executable, command] of [
  ['/local/share/claude/versions/2.1.309', '/local/share/claude/versions/2.1.309'],
  ['/local/share/claude/current', '/local/share/claude/current'],
  ['/usr/bin/node', 'node /opt/@anthropic-ai/claude-code/cli.js'],
  ['/usr/bin/node', 'node /opt/@anthropic-ai/claude-code/dist/entry.mjs'],
  ['/usr/bin/node', 'node /local/share/claude/versions/2.1.309'],
  ['/Applications/Claude.app/Contents/Helpers/Code', 'Code --claude-code'],
  ['/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
    'Claude Helper --claude-code'],
]) {
  test(`T066 S40 unreadable Code evidence is unknown for ${command}`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    const { tool } = toolFor([{ pid: 203, executable: executable!, command: command!, suffix: null }]);
    const census = await nativeCensus([profile], tool);
    assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'unknown');
  });
}

test('T065 S41 S42 a different profile launch parent and readable baseline do not block this profile', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const { tool } = toolFor([
    { pid: 204, executable: process.execPath,
      command: `${process.execPath} ${profile.code!.cli} run-profile another`, suffix: null },
    { pid: 205, executable: '/local/share/claude/versions/2.1.309', command: 'claude', suffix: ' HOME=/synthetic' },
  ]);
  assert.equal(codeLiveness(profile, await nativeCensus([profile], tool), f.io.guard.uid, 999).state, 'idle');
});

for (const columns of ['comm=', 'command=', 'lstart=']) {
  test(`T066 T150 S34 S40 an irrelevant reused process in ${columns} remains idle`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    const base = toolFor([{
      pid: 206, executable: '/unrelated/wrapper', command: 'wrapper', suffix: ' HOME=/synthetic',
    }]);
    const tool: CodeCensusTool = async (file, args, limits) => {
      const result = await base.tool(file, args, limits);
      if (args.at(-1)!.endsWith(columns)) {
        result.stdout = result.stdout.replace(started, 'Fri Oct 30 10:00:01 2026');
      }
      return result;
    };
    const census = await nativeCensus([profile], tool);
    assert.equal(census.available, true);
    assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'idle');
  });
}

test('T066 S40 the census has one overall deadline even when a tool does not complete', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const census = await nativeCensus([profile], async () => new Promise(() => {}), 20);
  assert.equal(census.available, false);
});

test('S40 S51 classification drops all raw environments and ignores only its own ps children', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const base = toolFor([{
    pid: 207, executable: '/unrelated/wrapper', command: 'wrapper',
    suffix: ' API_TOKEN=private-sentinel CLAUDE_CONFIG_DIR=' + profile.code!.location,
  }]);
  const results: { stdout: string; stderr: string }[] = [];
  let probe = 900;
  const tool: CodeCensusTool = async (file, args, limits) => {
    const result = await base.tool(file, args, limits);
    const pid = ++probe;
    result.stdout += `${pid} ${f.io.guard.uid} ${started} /bin/ps\n`;
    const owned = { ...result, pid };
    results.push(owned);
    return owned;
  };
  const census = await nativeCensus([profile], tool);
  assert.equal(census.available, true);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'active');
  assert.deepEqual(census.processes, []);
  assert.equal(JSON.stringify(census).includes('private-sentinel'), false);
  assert.ok(results.every(result => result.stdout === '' && result.stderr === ''));
});

for (const aliases of ['executable', 'data', 'both', 'trailing-slash']) {
  test(`T062 T063 T067 S21 S41 Desktop compares canonical and ${aliases} spellings`, () => {
    const f = profileFixture();
    const bundle = f.home + '/Claude.app';
    const executable = bundle + '/Contents/MacOS/Claude';
    const data = f.home + '/desktop';
    f.io.directory(bundle + '/Contents/MacOS');
    f.io.write(executable, 'synthetic executable', null);
    f.io.directory(data);
    const aliased = (path: string) => '/System/Volumes/Data' + path;
    const process = {
      pid: 208, uid: f.io.guard.uid, start: started, bundle, bundleId: 'com.anthropic.claudefordesktop',
      executable: ['executable', 'both'].includes(aliases) ? aliased(executable)
        : aliases === 'trailing-slash' ? executable + '/' : executable,
      data: ['data', 'both'].includes(aliases) ? aliased(data) : aliases === 'trailing-slash' ? data + '/' : data,
      uncertain: false,
    };
    const census = { available: true, processes: [process] };
    assert.equal(desktopState(data, executable, census, f.io.guard.uid).kind, 'correct');
    assert.equal(desktopState(aliased(data), aliased(executable), census, f.io.guard.uid).kind, 'correct');
    process.data = '/another/profile';
    assert.equal(desktopState(data, executable, census, f.io.guard.uid).kind, 'wrong');
  });
}
for (const field of ['executable', 'data'] as const) {
  test(`T066 T067 S40 a Claude bundle with ambiguous ${field} is unknown`, () => {
    const f = profileFixture();
    const bundle = f.home + '/Claude.app';
    const executable = bundle + '/Contents/MacOS/Claude';
    const data = f.home + '/desktop';
    const process = { pid: 209, uid: f.io.guard.uid, start: started, bundle,
      executable, data, uncertain: false, bundleId: 'com.anthropic.claudefordesktop' };
    process[field] = '/unresolved/../ambiguous';
    assert.equal(desktopState(data, executable, { available: true, processes: [process] }, f.io.guard.uid).kind,
      'unknown');
  });
}


test('T061 T065 S41 the current run-profile parent is active when recorded CLI metadata is absent', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  delete profile.code!.cli;
  const argv = [process.execPath, '/System/Volumes/Data' + f.services.cli, 'run-profile', '--profile-id', profile.id];
  const { tool } = toolFor([{
    pid: 210, executable: process.execPath, command: argv.join(' '), suffix: null,
  }]);
  const census = await nativeCensus([profile], tool);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'active');
  assert.equal(codeLiveness(profile, { available: true, processes: [{
    pid: 210, uid: f.io.guard.uid, executable: process.execPath, argv, environment: null,
  }] }, f.io.guard.uid, 999).state, 'active');
});

test('T061 S41 S51 one snapshot classifies every requested profile before discarding environments', async () => {
  const f = profileFixture();
  const first = installProfile(f);
  const second = installProfile(f, 'second');
  const { tool, calls } = toolFor([
    { pid: 211, executable: '/wrapper/first', command: 'first',
      suffix: ' CLAUDE_CONFIG_DIR=' + first.code!.location + ' PRIVATE_TOKEN=private-sentinel' },
    { pid: 212, executable: '/wrapper/second', command: 'second',
      suffix: ' CLAUDE_CONFIG_DIR=' + second.code!.location },
  ]);
  const census = await nativeCensus([first, second], tool);
  assert.equal(census.available, true);
  assert.deepEqual(codeLiveness(first, census, f.io.guard.uid, 999).pids, [211]);
  assert.deepEqual(codeLiveness(second, census, f.io.guard.uid, 999).pids, [212]);
  assert.deepEqual(codeLiveness(first, census, f.io.guard.uid, 999).pids, [211]);
  assert.equal(calls.filter(args => args.includes('-xwwE')).length, 1);
  assert.equal(JSON.stringify(census).includes('private-sentinel'), false);
});


test('T150 S34 S40 a reused probe pid retains relevant evidence from another instance', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const base = toolFor([]);
  let generation = 0;
  const tool: CodeCensusTool = async (file, args, limits) => {
    const result = await base.tool(file, args, limits);
    const start = generation++ === 0 ? started : 'Fri Oct 30 10:00:01 2026';
    const value = args.includes('-xwwE') ? 'wrapper CLAUDE_CONFIG_DIR=' + profile.code!.location : '/bin/ps';
    result.stdout += `901 ${f.io.guard.uid} ${start} ${value}\n`;
    return { ...result, pid: 901 };
  };
  const census = await nativeCensus([profile], tool);
  assert.equal(census.available, true);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'active');
});

function changingTool(rows: (attempt: number, field: number) => Candidate[]) {
  let count = 0;
  const timeouts: number[] = [];
  const tool: CodeCensusTool = async (file, args, limits) => {
    const index = count++;
    timeouts.push(limits.timeout);
    return toolFor(rows(Math.floor(index / 4), index % 4)).tool(file, args, limits);
  };
  return { tool, timeouts, calls: () => count };
}

test('T061 T066 S40 retries preserve active pid unions while using the final unknown evidence', async () => {
  const f = profileFixture();
  const first = installProfile(f);
  const second = installProfile(f, 'second');
  const changing = changingTool((attempt, field) => {
    const rows: Candidate[] = [{
      pid: 311 + attempt, executable: '/wrapper/session', command: 'session',
      suffix: ' CLAUDE_CONFIG_DIR=' + first.code!.location,
    }];
    if (attempt === 0 && field < 2) {
      rows.push({ pid: 314, executable: '/usr/bin/claude', command: 'claude', suffix: null });
    }
    return rows;
  });
  const census = await nativeCensus([first, second], changing.tool);
  assert.equal(census.available, true);
  assert.deepEqual(codeLiveness(first, census, f.io.guard.uid, 999), { state: 'active', pids: [311, 312] });
  assert.equal(codeLiveness(second, census, f.io.guard.uid, 999).state, 'idle');
  assert.equal(changing.calls(), 8);
});

test('T061 T066 S40 retries retain a profile active only in the first attempt', async () => {
  const f = profileFixture();
  const first = installProfile(f);
  const second = installProfile(f, 'second');
  const changing = changingTool((attempt, field) => attempt === 0 ? [
    { pid: 315, executable: '/wrapper/session', command: 'session',
      suffix: ' CLAUDE_CONFIG_DIR=' + first.code!.location },
    ...(field < 2 ? [{ pid: 316, executable: '/usr/bin/claude', command: 'claude', suffix: null }] : []),
  ] : []);
  const census = await nativeCensus([first, second], changing.tool);
  assert.equal(census.available, true);
  assert.deepEqual(codeLiveness(first, census, f.io.guard.uid, 999), { state: 'active', pids: [315] });
  assert.equal(codeLiveness(second, census, f.io.guard.uid, 999).state, 'idle');
  assert.equal(changing.calls(), 8);
});

test('T066 S40 unrelated processes disappearing between snapshots do not invalidate the census', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const changing = changingTool((_attempt, field) => field < 2 ? [{
    pid: 301, executable: '/usr/bin/helper', command: 'helper', suffix: ' HOME=/synthetic',
  }] : []);
  const census = await nativeCensus([profile], changing.tool);
  assert.equal(census.available, true);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'idle');
  assert.equal(changing.calls(), 4);
});

test('T066 S40 an exited candidate is unknown until a retry resolves its incomplete evidence', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const candidate = { pid: 302, executable: '/usr/local/bin/claude', command: 'claude', suffix: null };
  const unresolved = changingTool((_attempt, field) => field < 2 ? [candidate] : []);
  const unknown = await nativeCensus([profile], unresolved.tool);
  assert.equal(unknown.available, true);
  assert.equal(codeLiveness(profile, unknown, f.io.guard.uid, 999).state, 'unknown');
  assert.equal(unresolved.calls(), 12);
  const resolved = changingTool((attempt, field) => attempt === 0 && field < 2 ? [candidate] : []);
  const idle = await nativeCensus([profile], resolved.tool);
  assert.equal(idle.available, true);
  assert.equal(codeLiveness(profile, idle, f.io.guard.uid, 999).state, 'idle');
  assert.equal(resolved.calls(), 8);
});

test('T061 T066 S40 S41 a selector seen only in the environment snapshot remains active', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const changing = changingTool((_attempt, field) => field === 2 ? [{
    pid: 303, executable: '/wrapper/unknown', command: 'wrapper',
    suffix: ' CLAUDE_CONFIG_DIR=' + profile.code!.location,
  }] : []);
  const census = await nativeCensus([profile], changing.tool);
  assert.equal(census.available, true);
  assert.deepEqual(codeLiveness(profile, census, f.io.guard.uid, 999), { state: 'active', pids: [303] });
  assert.equal(changing.calls(), 4);
});

for (const field of [1, 2]) {
  test(`T065 T066 S40 S41 incomplete route in snapshot ${field} affects only its named profile`, async () => {
    const f = profileFixture();
    const first = installProfile(f);
    const second = installProfile(f, 'second');
    first.code!.cli = f.home + '/runtime equals=tool/main.js';
    const changing = changingTool((_attempt, snapshot) => snapshot === field ? [{
      pid: 304, executable: process.execPath,
      command: `${process.execPath} ${first.code!.cli} run-profile --profile-id ${first.id}`, suffix: null,
    }] : []);
    const census = await nativeCensus([first, second], changing.tool);
    assert.equal(census.available, true);
    assert.equal(codeLiveness(first, census, f.io.guard.uid, 999).state, 'unknown');
    assert.equal(codeLiveness(second, census, f.io.guard.uid, 999).state, 'idle');
    assert.equal(changing.calls(), 12);
  });
}

test('T066 S40 only incomplete evidence triggers a retry, not an unreadable stable environment', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const changing = changingTool(() => [{
    pid: 305, executable: '/usr/bin/claude', command: 'claude', suffix: null,
  }]);
  const census = await nativeCensus([profile], changing.tool);
  assert.equal(census.available, true);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'unknown');
  assert.equal(changing.calls(), 4);
});

test('T066 S40 a process first observed after the environment snapshot is outside this check', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const changing = changingTool((_attempt, field) => field === 3 ? [{
    pid: 306, executable: '/usr/bin/claude', command: 'claude', suffix: null,
  }] : []);
  const census = await nativeCensus([profile], changing.tool);
  assert.equal(census.available, true);
  assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, 'idle');
  assert.equal(changing.calls(), 4);
});

for (const selector of [false, true]) {
  test(`T150 S34 S40 reused relevant pid evidence stays available with selector ${selector}`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    const base = toolFor([{
      pid: 307, executable: '/usr/bin/claude', command: 'claude',
      suffix: selector ? ' CLAUDE_CONFIG_DIR=' + profile.code!.location : ' HOME=/synthetic',
    }]);
    let calls = 0;
    const tool: CodeCensusTool = async (file, args, limits) => {
      calls++;
      const result = await base.tool(file, args, limits);
      if (args.includes('-xwwE')) {
        result.stdout = result.stdout.replace(started, 'Fri Oct 30 10:00:01 2026');
      }
      return result;
    };
    const census = await nativeCensus([profile], tool);
    assert.equal(census.available, true);
    assert.equal(codeLiveness(profile, census, f.io.guard.uid, 999).state, selector ? 'active' : 'unknown');
    assert.equal(calls, selector ? 4 : 12);
  });
}

test('T066 S40 retry attempts share the original overall deadline', async () => {
  const f = profileFixture();
  const profile = installProfile(f);
  const changing = changingTool((_attempt, field) => field === 0 ? [{
    pid: 308, executable: '/usr/bin/claude', command: 'claude', suffix: null,
  }] : []);
  const tool: CodeCensusTool = async (file, args, limits) => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return changing.tool(file, args, limits);
  };
  const census = await nativeCensus([profile], tool, 80);
  assert.equal(census.available, false);
  assert.ok(changing.timeouts.every((timeout, index, values) => timeout <= 80
    && (index === 0 || timeout <= values[index - 1]!)));
});

for (const mode of ['exit', 'unparseable', 'duplicate']) {
  test(`T066 S40 real snapshot failure ${mode} makes the census unavailable`, async () => {
    const f = profileFixture();
    const profile = installProfile(f);
    const row = `309 ${f.io.guard.uid} ${started} /usr/bin/helper\n`;
    const census = await nativeCensus([profile], async () => ({
      code: mode === 'exit' ? 1 : 0, stdout: mode === 'unparseable' ? 'invalid-row\n' : row + row, stderr: '',
    }));
    assert.equal(census.available, false);
  });
}

test('T066 S40 Desktop churn and a missing process start affect that process rather than availability', async () => {
  const uid = process.getuid!();
  const executable = '/applications/Claude.app/Contents/MacOS/Claude';
  const census = await desktopNativeCensus(async (file, args) => {
    if (args.includes('pid=,uid=,comm=')) {
      return { code: 0, stdout: `310 ${uid} /usr/bin/helper\n311 ${uid} ${executable}`, stderr: '' };
    }
    if (args.includes('pid=,command=')) {
      return { code: 0, stdout: `311 ${executable} --user-data-dir=/synthetic/profile`, stderr: '' };
    }
    return { code: file === '/usr/bin/plutil' ? 0 : 1,
      stdout: file === '/usr/bin/plutil' ? 'com.anthropic.claudefordesktop' : '', stderr: '' };
  });
  assert.equal(census.available, true);
  assert.equal(census.processes.length, 1);
  assert.equal(desktopState('/synthetic/profile', executable, census, uid).kind, 'unknown');
});
