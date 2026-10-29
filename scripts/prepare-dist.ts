import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { reviewPackage, lockDigest } from './package-safety.js';
import { releaseVersion } from '../src/release.js';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const read = (name: string) => readFileSync(join(repository, name));
const manifest = JSON.parse(read('package.json').toString('utf8')) as Record<string, unknown>;
const lock = read('npm-shrinkwrap.json');
reviewPackage(manifest, JSON.parse(lock.toString('utf8')), JSON.parse(read('package-lock.json').toString('utf8')));
if (manifest.version !== releaseVersion) {
  throw new Error('The compiled release version differs from the package manifest.');
}
const runtime: Record<string, string> = {};
for (const name of readdirSync(join(repository, 'dist/src')).sort()) {
  if (!name.endsWith('.js')) {
    continue;
  }
  const source = join(repository, 'src', name.slice(0, -3) + '.ts');
  if (!lstatSync(source).isFile()) {
    throw new Error('Stale runtime output must be reviewed before packing.');
  }
  const path = join(repository, 'dist/src', name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Runtime output must contain only regular compiled modules.');
  }
  runtime['src/' + name] = lockDigest(readFileSync(path));
}
writeFileSync(join(repository, 'dist/build.json'), JSON.stringify({
  format: 'bcm-build/1', version: releaseVersion, lockSha256: lockDigest(lock), runtime,
}, null, 2) + '\n');
writeFileSync(join(repository, 'dist/.npmignore'), 'test/\nscripts/\n');
