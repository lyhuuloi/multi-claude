import { join } from 'node:path';
import { lstatSync } from 'node:fs';
import { PrivateIO } from './private-io.js';
import { shellQuote, isMissing, Problem } from './outcomes.js';
export function githubGuidance(location: string): string[] {
  return [
    `GH_CONFIG_DIR=${shellQuote(location)} gh auth login --insecure-storage`,
    'This selects plaintext token storage inside the profile. Keep this directory private.',
    'Git credential helpers, SSH keys, SSH agents and commit identity may still be shared.',
  ];
}
export function githubLogoutGuidance(location: string): string {
  return `Before deleting data, use GH_CONFIG_DIR=${shellQuote(location)} gh auth logout if desired.`;
}
export function githubStorageFinding(location: string, io: PrivateIO): string | null {
  if (!assertGithubDirectory(location, io, true)) {
    return 'GitHub configuration is missing; token separation is unverified.';
  }
  const file = io.read(join(location, 'hosts.yml'));
  if (!file) {
    return 'GitHub login state is absent; token separation is unverified.';
  }
  const lines = file.bytes.toString('utf8').split(/\r?\n/);
  let hasHost = false;
  let token = false;
  let missingToken = false;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) {
      continue;
    }
    if (/^[a-zA-Z0-9.-]+:\s*$/.test(line)) {
      missingToken ||= hasHost && !token;
      hasHost = true;
      token = false;
    } else if (/^ {4}oauth_token:\s*[^\s#][^\r\n]*$/.test(line) && hasHost) {
      const scalar = line.slice(line.indexOf(':') + 1).trim();
      token = !['\"\"', "''", 'null', '~'].includes(scalar);
    } else if (!/^ {4}(user|git_protocol):\s*[^\r\n]+$/.test(line) || !hasHost) {
      return 'GitHub token storage is unknown: hosts.yml syntax is unsupported.';
    }
  }
  if (!hasHost) {
    return 'GitHub token storage is unknown: hosts.yml contains no recognized hosts.';
  }
  if (missingToken || !token) {
    return 'GitHub host configuration lacks a file-backed token; shared Keychain storage may be in use.';
  }
  return null;
}
export function assertGithubDirectory(location: string, io: PrivateIO, allowAbsent = false): boolean {
  try {
    io.guard.chain(location);
    const stat = lstatSync(location, { bigint: true });
    if (stat.uid !== BigInt(io.guard.uid) || (stat.mode & 0o777n) !== 0o700n) {
      throw new Problem('github-private', 'The selected GitHub directory must be private and owned by this user.');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) {
      if (allowAbsent) {
        return false;
      }
      throw new Problem('github-missing', 'The selected GitHub directory is missing; run doctor --apply.');
    }
    throw error;
  }
}
