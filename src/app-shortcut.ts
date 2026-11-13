import { lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isMissing } from './outcomes.js';
export type ShortcutState = 'present' | 'missing' | 'foreign';
export const shortcutPath = (directory: string, label: string): string => join(directory, `Claude ${label}.app`);
// A shortcut is ours only when it is a symbolic link owned by this user that names the profile launcher.
// Its directory can be writable by other administrators, so it is never trusted and never a managed root.
export function shortcutState(path: string, launcher: string): ShortcutState {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() && info.uid === process.getuid!() && readlinkSync(path) === launcher
      ? 'present' : 'foreign';
  } catch (error) {
    return isMissing(error) ? 'missing' : 'foreign';
  }
}
export function placeShortcut(path: string, launcher: string): string | null {
  const state = shortcutState(path, launcher);
  if (state === 'foreign') {
    return `Shortcut skipped: ${path} already exists and is not this profile's link. It was preserved.`;
  }
  if (state === 'missing') {
    try {
      symlinkSync(launcher, path);
    } catch {
      return `Shortcut could not be created at ${path}. The launcher itself is unaffected.`;
    }
  }
  return null;
}
export function dropShortcut(path: string, launcher: string): string | null {
  const state = shortcutState(path, launcher);
  if (state === 'foreign') {
    return `Shortcut preserved: ${path} is not this profile's link.`;
  }
  if (state === 'present') {
    try {
      unlinkSync(path);
    } catch {
      return `Shortcut could not be removed at ${path}.`;
    }
  }
  return null;
}
