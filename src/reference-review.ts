import { join } from 'node:path';
import type { FileImage } from './private-io.js';
import { PrivateIO } from './private-io.js';
import type { Catalog, Profile } from './profile-catalog.js';
import { jsonDocument } from './setup-selection.js';
import { migrateDocument } from './reference-mapping.js';
import { present } from './managed-resources.js';
export function referenceRepairs(
  profile: Profile, catalog: Catalog, home: string, io: PrivateIO, warn: (message: string) => void,
): Map<string, { bytes: Buffer; image: FileImage }> {
  const result = new Map<string, { bytes: Buffer; image: FileImage }>();
  if (!profile.code) {
    return result;
  }
  const sources = [join(home, '.claude'), ...catalog.profiles.filter(value => value.id !== profile.id)
    .flatMap(value => value.code ? [value.code.location] : [])];
  for (const name of ['settings.json', '.claude.json', 'plugins/installed_plugins.json',
    'plugins/known_marketplaces.json']) {
    const path = join(profile.code.location, name);
    const data = io.read(path);
    if (!data) {
      continue;
    }
    let value = jsonDocument(data.bytes);
    const original = JSON.stringify(value);
    for (const source of sources) {
      value = migrateDocument(name, value, {
        source, destination: profile.code.location, home, required: false, copied: present, warn,
      });
    }
    if (JSON.stringify(value) !== original) {
      result.set(path, { bytes: Buffer.from(JSON.stringify(value, null, 2) + '\n'), image: data.image });
    }
  }
  return result;
}
export function foreignReferenceFiles(profile: Profile, catalog: Catalog, home: string, io: PrivateIO): string[] {
  if (!profile.code) {
    return [];
  }
  const result: string[] = [];
  const sources = [join(home, '.claude'), ...catalog.profiles.filter(value => value.id !== profile.id)
    .flatMap(value => value.code ? [value.code.location] : [])];
  for (const name of ['settings.json', '.claude.json', 'plugins/installed_plugins.json',
    'plugins/known_marketplaces.json']) {
    const data = io.read(join(profile.code.location, name));
    if (!data) {
      continue;
    }
    const original = jsonDocument(data.bytes);
    let seen = false;
    for (const source of sources) {
      const mapped = migrateDocument(name, original, {
        source, destination: profile.code.location, home, required: false,
        warn: () => {
          seen = true;
        },
      });
      seen ||= JSON.stringify(mapped) !== JSON.stringify(original);
    }
    if (seen) {
      result.push(name);
    }
  }
  return result;
}
