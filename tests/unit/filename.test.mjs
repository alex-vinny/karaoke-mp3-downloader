import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFilename } from '../../extension/filename.js';

test('drops emoji, symbols and Windows-illegal characters, keeps accents', () => {
  assert.equal(safeFilename('🎵 Roberto Carlos ‖ Detalhes (Karaokê) | HD 🎤'), 'Roberto Carlos Detalhes (Karaokê) HD');
  assert.equal(safeFilename('Título: "Aquarela" / Toquinho?'), 'Título Aquarela Toquinho');
  assert.equal(safeFilename("Don't Stop Me Now - Queen & Friends!"), "Don't Stop Me Now - Queen & Friends!");
  assert.equal(safeFilename('Ação, coração, Ñandú, Ærø, 東京'), 'Ação, coração, Ñandú, Ærø, 東京');
});

test('removes invisible characters that Chrome rejects (ZWJ, variation selectors, BOM)', () => {
  assert.equal(safeFilename('﻿A​b‍c️ d'), 'Abc d');
  assert.equal(safeFilename('🕵️‍♂️ detetive'), 'detetive');
});

test('collapses whitespace and strips leading/trailing dots and junk', () => {
  assert.equal(safeFilename('  ...  Minha   música ...  '), 'Minha música');
  assert.equal(safeFilename('Nome - '), 'Nome');
  assert.equal(safeFilename('Nome ('), 'Nome');
});

test('cuts long titles at a word boundary, never above 60 characters', () => {
  const long = 'Palavra '.repeat(20).trim(); // 159 chars
  const out = safeFilename(long);
  assert.ok(out.length <= 60, String(out.length));
  assert.ok(!out.endsWith(' '));
  assert.equal(out, 'Palavra '.repeat(7).trim());
  assert.equal(safeFilename('a'.repeat(100)).length, 60);
  assert.equal(safeFilename('curto', { maxLength: 3 }), 'cur');
});

test('never returns an empty or reserved name', () => {
  assert.equal(safeFilename(''), 'audio');
  assert.equal(safeFilename(null), 'audio');
  assert.equal(safeFilename('🎵🎵🎵'), 'audio');
  assert.equal(safeFilename('...'), 'audio');
  assert.equal(safeFilename('CON'), 'CON audio');
  assert.equal(safeFilename('lpt1'), 'lpt1 audio');
});
