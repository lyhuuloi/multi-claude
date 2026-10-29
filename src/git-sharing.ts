import { join } from 'node:path';
import { PrivateIO } from './private-io.js';
import type { NativeTool } from './claude-authenticity.js';
export interface GitSharing {
  helpers: number;
  identity: boolean;
  ssh: boolean;
  includes: boolean;
  unknown: boolean;
  developerToolsMissing: boolean;
  agent: boolean;
}
export async function inspectGitSharing(
  home: string, config: string, env: NodeJS.ProcessEnv, io: PrivateIO, tool: NativeTool,
): Promise<GitSharing> {
  const state: GitSharing = {
    helpers: 0, identity: false, ssh: false, includes: false, unknown: false, agent: env.SSH_AUTH_SOCK !== undefined,
    developerToolsMissing: false,
  };
  try {
    state.developerToolsMissing = (await tool('/usr/bin/xcode-select', ['-p'])).code !== 0;
  } catch {
    state.developerToolsMissing = true;
  }
  if (state.developerToolsMissing) {
    state.unknown = true;
    return state;
  }
  for (const path of [join(home, '.gitconfig'), join(config, 'git/config')]) {
    try {
      const file = io.read(path);
      if (!file) {
        continue;
      }
      const result = await tool('/usr/bin/git', ['config', '--file', path, '--no-includes', '--null', '--list']);
      io.assertImage(path, file.image);
      if (result.code !== 0) {
        state.unknown = true;
        continue;
      }
      for (const entry of result.stdout.split('\0').filter(Boolean)) {
        const separator = entry.indexOf('\n');
        const key = (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase();
        const value = separator < 0 ? '' : entry.slice(separator + 1);
        if (/^credential(?:\..+)?\.helper$/.test(key)) {
          state.helpers++;
        }
        state.identity ||= /^user\.(?:name|email|signingkey)$/.test(key);
        state.includes ||= /^include(?:if\..+)?\.path$/.test(key);
        state.ssh ||= key === 'core.sshcommand' || (key.startsWith('url.') && /git@|ssh:/.test(key))
        || (key.startsWith('remote.') && key.endsWith('.url') && /^(?:ssh:|git@|[^/\s]+@[^:]+:)/.test(value));
      }
    } catch {
      state.unknown = true;
    }
  }
  return state;
}
export function gitSharingMessages(state: GitSharing): string[] {
  return [
    `Git global credential helpers: ${state.helpers} configured; their credentials can remain shared.`,
    `Git global commit identity: ${state.identity ? 'configured' : 'not observed'}; `
    + `profile selection does not isolate it.`,
    `Git SSH transport: ${state.ssh ? 'configuration observed' : 'available independently of profile selection'}.`,
    `SSH-agent sharing: `
    + `${state.agent ? 'SSH_AUTH_SOCK is present' : 'no inherited SSH_AUTH_SOCK observed'}; SSH keys remain shared.`,
    'GH_CONFIG_DIR does not isolate Git helpers, transport credentials, SSH keys, SSH '
    + 'agents or global commit identity.',
    'Credential helpers and SSH commands were not executed. Git configuration was not rewritten.',
    ...(state.includes ? ['Git include files were not followed; included and repository configuration can add '
      + 'shared state.'] : []),
    ...(state.unknown ? ['Some Git configuration could not be safely inspected; sharing details are unknown.'] : []),
    ...(state.developerToolsMissing
      ? ['Developer tools are not installed or available; Git was not invoked and sharing evidence is unknown.'] : []),
  ];
}
