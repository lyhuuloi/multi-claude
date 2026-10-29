import type { PackedArchive } from './scratch-directory.js';
import { scratchIdentity, removePackedScratch } from './scratch-directory.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
// npm supplies this path to scripts; no shell is used to expand pack output.
const npm = process.env.npm_execpath;
if (!npm) {
  throw new Error('Run install-local through npm.');
}
const profileRoot = mkdtempSync(join(tmpdir(), 'bcm-pack-'));
const scratch = scratchIdentity(profileRoot);
let packedArchive: PackedArchive | undefined;
try {
  const pack = spawnSync(process.execPath, [npm, 'pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination',
    profileRoot], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120000 });
  if (pack.status !== 0) {
    throw new Error('Packing failed; installation was not started.');
  }
  const entries: unknown = JSON.parse(pack.stdout);
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error('Packing did not identify one archive.');
  }
  const filename: unknown = entries[0]?.filename;
  if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) {
    throw new Error('Invalid packed archive name.');
  }
  const archive = join(profileRoot, filename);
  const archiveStat = lstatSync(archive, { bigint: true });
  if (!archiveStat.isFile() || archiveStat.nlink !== 1n || archiveStat.uid !== scratch.uid) {
    throw new Error('The packed archive is missing.');
  }
  packedArchive = {
    path: archive, identity: { device: archiveStat.dev, inode: archiveStat.ino, uid: archiveStat.uid },
  };
  const install = spawnSync(process.execPath, [npm, 'install', '--global', '--offline',
    '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], { stdio: 'inherit', timeout: 120000 });
  process.exitCode = install.status ?? 1;
} finally {
  removePackedScratch(profileRoot, scratch, packedArchive);
}
