import type { Profile } from './profile-catalog.js';
export const authenticationOverrides = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
] as const;
export const githubOverrides = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;
export function executionEnvironment(profile: Profile, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected = { ...inherited };
  if (profile.credentialPolicy === 'subscription') {
    for (const name of authenticationOverrides) {
      delete selected[name];
    }
  }
  delete selected.CLAUDE_CONFIG_DIR;
  delete selected.GH_CONFIG_DIR;
  if (profile.code) {
    selected.CLAUDE_CONFIG_DIR = profile.code.location;
    if (profile.code.github) {
      selected.GH_CONFIG_DIR = profile.code.github;
      for (const name of githubOverrides) {
        delete selected[name];
      }
    }
  }
  return selected;
}
export function overrideNames(profile: Profile, inherited: NodeJS.ProcessEnv): string[] {
  const names: readonly string[] = profile.code?.github
  ? [...authenticationOverrides, ...githubOverrides]
  : authenticationOverrides;
  return names.filter(name => Object.hasOwn(inherited, name));
}
