import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewerVersion, parseVersion } from '../../extension/version.js';

test('parses versions numerically, ignoring a leading v', () => {
  assert.deepEqual(parseVersion('v1.10.2'), [1, 10, 2]);
  assert.deepEqual(parseVersion('1.0'), [1, 0]);
  assert.deepEqual(parseVersion(''), [0]);
});

test('compares part by part, not as strings', () => {
  assert.equal(isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(isNewerVersion('v1.1.0', '1.0.9'), true);
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0.1', '1.0.0'), true);
});

test('garbage never counts as an update', () => {
  assert.equal(isNewerVersion('', '1.0.0'), false);
  assert.equal(isNewerVersion(undefined, '1.0.0'), false);
  assert.equal(isNewerVersion('latest', '1.0.0'), false);
});
