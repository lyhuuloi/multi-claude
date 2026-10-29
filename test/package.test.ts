import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireIsolation, inside } from './isolation.js';
import { distributionFiles, reviewPackage, lockDigest } from '../scripts/package-safety.js';
const root = requireIsolation();
const repository = process.env.BCM_TEST_REPO!;
const npm = process.env.BCM_TEST_NPM!;
const env = { ...process.env, PATH: dirname(process.execPath) + ':/usr/bin:/bin', npm_config_update_notifier: 'false' };
function npmCommand(args: string[], cwd: string) {
  assert.ok(npm && lstatSync(npm).isFile(), 'The isolated runner must supply the actual npm CLI path.');
  const result = spawnSync(process.execPath, [npm, ...args], {
    cwd, env, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, 'The isolated offline npm command failed: ' + result.stderr);
  return result.stdout;
}
function tarFile(archive: string, name: string): Buffer {
  const result = spawnSync('/usr/bin/tar', ['-xOf', archive, 'package/' + name], {
    env, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.status, 0);
  return result.stdout;
}
test('T154 T155 S68 reviewed manifests have no runtime graph and bind exact development versions', () => {
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  const shrinkwrap = JSON.parse(readFileSync(join(repository, 'npm-shrinkwrap.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repository, 'package-lock.json'), 'utf8'));
  reviewPackage(manifest, shrinkwrap, lock);
  assert.deepEqual(manifest.files, distributionFiles);
  assert.equal(manifest.version, '1.0.0');
  const tampered = structuredClone(shrinkwrap);
  tampered.packages['node_modules/undici-types'].dev = false;
  assert.throws(() => reviewPackage(manifest, tampered, tampered));
});
test('T155 T158 S68 S72 npm pack dry-run includes only compiled runtime, reviewed lock and release documents', () => {
  const destination = mkdtempSync(join(root, 'dry-pack-'));
  const output = npmCommand(['pack', '--dry-run', '--json', '--offline', '--ignore-scripts',
    '--pack-destination', destination], repository);
  const paths: string[] = JSON.parse(output)[0].files.map((file: { path: string }) => file.path);
  for (const name of ['package.json', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md',
    'npm-shrinkwrap.json', 'dist/build.json', 'dist/src/main.js']) {
    assert.ok(paths.includes(name), name);
  }
  assert.equal(paths.some(path => path.startsWith('dist/test/') || path.startsWith('dist/scripts/')), false);
  assert.ok(paths.every(path => path.startsWith('dist/') || ['package.json',
    ...distributionFiles.slice(1)].includes(path)));
  assert.equal(paths.some(path => /(?:node_modules|SPEC\.md|\.git\/|next-invariant-map)/.test(path)), false);
  for (const path of paths.filter(path => path.endsWith('.js'))) {
    assert.equal(readFileSync(join(repository, path), 'utf8').includes('BCM_TEST_'), false, path);
  }
  assert.deepEqual(readdirSync(destination), []);
});
test('T155 T157 T158 S68 S69 offline production installation uses a temporary prefix without dev packages', () => {
  const destination = mkdtempSync(join(root, 'offline-install-'));
  const packed = JSON.parse(npmCommand(['pack', '--json', '--offline', '--ignore-scripts',
    '--pack-destination', destination], repository));
  assert.equal(packed.length, 1);
  const archive = join(destination, packed[0].filename);
  const manifest = JSON.parse(tarFile(archive, 'package.json').toString('utf8'));
  const lockBytes = tarFile(archive, 'npm-shrinkwrap.json');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  reviewPackage(manifest, lock, lock);
  assert.deepEqual(lockBytes, readFileSync(join(repository, 'npm-shrinkwrap.json')));
  const build = JSON.parse(tarFile(archive, 'dist/build.json').toString('utf8'));
  assert.equal(build.lockSha256, lockDigest(lockBytes));
  assert.equal(build.version, manifest.version);
  for (const [path, digest] of Object.entries(build.runtime)) {
    assert.equal(lockDigest(tarFile(archive, 'dist/' + path)), digest);
  }
  const prefix = resolve(destination, 'prefix');
  assert.ok(inside(root, prefix), 'Production installation must use the declared temporary prefix.');
  npmCommand(['install', '--global', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--prefix', prefix, archive], destination);
  const installed = join(prefix, 'lib/node_modules/ben-claude-multi');
  assert.equal(existsSync(join(installed, 'node_modules/typescript')), false);
  assert.equal(existsSync(join(installed, 'node_modules/@types')), false);
  assert.equal(existsSync(join(installed, 'dist/test')), false);
  for (const command of ['version', 'help']) {
    const result = spawnSync(join(prefix, 'bin/ben-claude-multi'), [command], {
      env, cwd: destination, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ben-claude-multi 1\.0\.0/);
  }
});
