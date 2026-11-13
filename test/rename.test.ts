import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { requireIsolation } from './isolation.js';
import { locations } from '../src/command-front.js';
import { validCommand } from '../src/profile-catalog.js';
const testRoot = requireIsolation();
const home = () => realpathSync(mkdtempSync(join(testRoot, 'home-')));
test('R001 a new installation keeps its registry and data under the current name', () => {
  const where = locations({ HOME: home() });
  assert.ok(where.control.endsWith('/.config/multi-claude'));
  assert.ok(where.data.endsWith('/.local/share/multi-claude'));
});
test('R002 a registry created under the first name is used in place', () => {
  const root = home();
  mkdirSync(join(root, '.config/ben-claude-multi'), { recursive: true, mode: 0o700 });
  const where = locations({ HOME: root });
  assert.equal(where.control, join(root, '.config/ben-claude-multi'));
  assert.equal(where.data, join(root, '.local/share/ben-claude-multi'));
});
test('R003 once the current registry exists the first name is ignored', () => {
  const root = home();
  mkdirSync(join(root, '.config/ben-claude-multi'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, '.config/multi-claude'), { recursive: true, mode: 0o700 });
  assert.equal(locations({ HOME: root }).control, join(root, '.config/multi-claude'));
});
test('R004 neither tool name can be taken as a profile command', () => {
  assert.equal(validCommand('multi-claude'), false);
  assert.equal(validCommand('ben-claude-multi'), false);
});
