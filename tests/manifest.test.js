import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseManifest } from '@openchamber/sdk/schemas';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const contributes = manifest.openchamber.contributes;

test('declares an installable apiVersion 1 panel with a built entry', () => {
  assert.equal(manifest.openchamber.apiVersion, 1);
  assert.match(contributes.panel.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(existsSync(resolve(packageRoot, contributes.panel.entry)), 'panel entry must exist on disk');
  assert.ok(existsSync(resolve(packageRoot, 'panel/main.js')), 'panel bundle must be shipped');
  assert.ok(existsSync(resolve(packageRoot, contributes.panel.icon)), 'package icon must exist on disk');
});

test('declares the host service that may only run gh and git', () => {
  assert.equal(contributes.service.entry, 'service/main.js');
  assert.equal(contributes.service.runtime, 'host');
  assert.deepEqual(contributes.service.permissions.exec, ['gh', 'git']);
  assert.equal(contributes.service.permissions.sockets, undefined);
  assert.ok(existsSync(resolve(packageRoot, contributes.service.entry)), 'service bundle must be shipped');
});

test('asks only for the prompt and sessions capabilities', () => {
  assert.deepEqual(contributes.capabilities, ['prompt', 'sessions']);
  assert.equal(contributes.filesystem, undefined);
  assert.equal(contributes.integration, undefined);
  assert.equal(contributes.attach, undefined);
  assert.equal(contributes.actions, undefined);
  assert.equal(contributes.commands, undefined);
  assert.ok(manifest.openchamber.engines.openchamber, 'engine range must be declared');
});

test('the manifest parses as a package', () => {
  const result = parseManifest({ version: manifest.version, openchamber: manifest.openchamber });
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result));
});
