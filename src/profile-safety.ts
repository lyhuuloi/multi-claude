import { join } from 'node:path';
import { overlaps, baselineLocations } from './location-guard.js';
import type { Catalog, Profile } from './profile-catalog.js';
export function profilePaths(profile: Profile): string[] {
  return [
    ...(profile.code ? [profile.code.location] : []),
    ...(profile.desktop ? [profile.desktop.location, profile.desktop.location + '-3p', profile.desktop.launcher] : []),
  ];
}
export function profilePathFinding(profile: Profile, catalog: Catalog, home: string, control: string): string | null {
  const others = catalog.profiles.filter(value => value.id !== profile.id).flatMap(profilePaths);
  const sources = catalog.profiles.flatMap(value => value.desktop ? [value.desktop.source] : []);
  const occupied = [...baselineLocations(home), control, ...others, ...sources];
  const own: string[] = [];
  for (const path of profilePaths(profile)) {
    if ([...occupied, ...own].some(other => overlaps(path, other))) {
      return 'A configured root overlaps baseline, control state, a source application or another profile root.';
    }
    own.push(path);
  }
  if (profile.code && [...occupied, ...own].some(path => overlaps(profile.code!.rc, path))) {
    return 'The recorded shell file overlaps a protected root.';
  }
  const copy = profile.rootEvidence.find(value => value.role === 'copy');
  if (copy && copy.location !== join(control, 'bundles.noindex', profile.id, 'Claude.app')) {
    return 'The recorded application-copy location differs from its UUID storage location.';
  }
  return null;
}
