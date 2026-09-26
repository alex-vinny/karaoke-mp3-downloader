import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localesDir = path.join(root, 'extension', '_locales');
const read = (loc) => JSON.parse(fs.readFileSync(path.join(localesDir, loc, 'messages.json'), 'utf8'));
const placeholders = (msg) => (msg.match(/\$\d/g) ?? []).sort().join('');

test('manifest declares default_locale en and __MSG__ name/description', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDescription__');
});

test('every locale has the same keys as en, non-empty, same placeholders', () => {
  const en = read('en');
  const locales = fs.readdirSync(localesDir).filter((d) => d !== 'en');
  assert.ok(locales.includes('pt_BR'));
  for (const loc of locales) {
    const other = read(loc);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), `${loc}: key set`);
    for (const key of Object.keys(en)) {
      assert.ok(other[key].message.trim().length > 0, `${loc}.${key} is empty`);
      assert.equal(placeholders(other[key].message), placeholders(en[key].message), `${loc}.${key}: placeholders`);
    }
  }
});

test('the strings the code relies on exist', () => {
  const en = read('en');
  for (const key of ['extName', 'extDescription', 'button', 'downloading', 'converting', 'preparing', 'keepTabOpen', 'done', 'openFolder', 'error', 'adDetected', 'updateAvailable', 'songsFolder']) {
    assert.ok(en[key], `missing ${key}`);
  }
});
