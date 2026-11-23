import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import { DOWNLOAD_SIZE, MODEL_NOTE, V4_REFERENCES } from '../docs/js/v4-star.js';

test('the v4 catalog contains both dan groups and the official singles', () => {
  const path = new URL('../docs/data/dan-references-v4.json', import.meta.url);
  const refs = validateDanReferences(JSON.parse(fs.readFileSync(path)), V4_REFERENCES);
  assert.ok(!('placeholder' in refs));
  assert.equal(refs.groups[0].label, 'REFORM 整段');
  assert.equal(refs.groups.flatMap((g) => g.entries).length + refs.reformSingles.entries.length, 95);
  const reform = refs.groups[0].entries;
  for (let i = 1; i < reform.length; i++) {
    assert.ok(reform[i - 1].star <= reform[i].star, `${reform[i - 1].id} should precede ${reform[i].id}`);
  }
  const zeta = reform.find((entry) => entry.id === 'reform-zeta');
  const eta = reform.find((entry) => entry.id === 'reform-eta');
  assert.ok(zeta.star < eta.star);
});

test('the v4 download estimate matches the published files', () => {
  const path = new URL('../docs/model/', import.meta.url);
  const files = fs.readdirSync(path).filter((file) => /^(?:v4|support-v4)/.test(file));
  assert.ok(files.length > 0);
  const bytes = files.reduce((sum, file) => sum + fs.statSync(new URL(file, path)).size, 0);
  assert.ok(bytes > 0 && bytes <= 9_000_000);
  assert.equal(DOWNLOAD_SIZE.v4, `约 ${(bytes / 1e6).toFixed(2)} MB`);
  assert.match(DOWNLOAD_SIZE.first, /^约 \d+(?:\.\d+)? MB$/);
  assert.ok(parseFloat(DOWNLOAD_SIZE.first.slice(2)) > bytes / 1e6);
  assert.ok(MODEL_NOTE().includes(DOWNLOAD_SIZE.v4));
});
