import { createHash } from 'node:crypto';
export const distributionFiles = ['dist/', 'README.md', 'LICENSE', 'SECURITY.md', 'CHANGELOG.md',
  'npm-shrinkwrap.json'];
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
export function lockDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function reviewPackage(manifest: JsonObject, lock: JsonObject, developmentLock: JsonObject): void {
  const refuse = () => {
    throw new Error('The package or reviewed dependency lock does not match the distribution contract.');
  };
  if (manifest.name !== 'ben-claude-multi' || manifest.version !== '1.0.0' || manifest.type !== 'module'
    || JSON.stringify(manifest.files) !== JSON.stringify(distributionFiles)
    || JSON.stringify(lock) !== JSON.stringify(developmentLock) || lock.lockfileVersion !== 3
    || lock.name !== manifest.name || lock.version !== manifest.version) {
    refuse();
  }
  for (const name of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies',
    'bundleDependencies']) {
    if (manifest[name] && Object.keys(manifest[name] as object).length) {
      refuse();
    }
  }
  if (!object(manifest.devDependencies)
    || JSON.stringify(Object.keys(manifest.devDependencies).sort()) !== JSON.stringify(['@types/node', 'typescript'])
    || !Object.values(manifest.devDependencies).every(value => typeof value === 'string' &&
      /^\d+\.\d+\.\d+$/.test(value))
    || !object(lock.packages) || !object(lock.packages[''])) {
    refuse();
  }
  const packages = lock.packages as JsonObject;
  const root = packages[''] as JsonObject;
  if (JSON.stringify(root.devDependencies) !== JSON.stringify(manifest.devDependencies)) {
    refuse();
  }
  for (const name of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (root[name] && Object.keys(root[name] as object).length) {
      refuse();
    }
  }
  for (const [name, entry] of Object.entries(packages)) {
    if (!name) {
      continue;
    }
    if (!object(entry) || entry.dev !== true || typeof entry.version !== 'string'
      || typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')
      || !/^node_modules\/(?:typescript|@types\/node|undici-types|@typescript\/typescript-[a-z0-9-]+)$/.test(name)) {
      refuse();
    }
  }
  for (const name of ['typescript', '@types/node']) {
    const entry = packages['node_modules/' + name] as JsonObject | undefined;
    if (!entry || entry.version !== (manifest.devDependencies as JsonObject)[name]) {
      refuse();
    }
  }
}
