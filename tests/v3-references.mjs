// Before release: the star v3 dan references and the download sizes must be real values, not placeholders.
//   node --test tests/v3-references.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateDanReferences } from '../docs/js/dan-reference.js';
import { V3_REFERENCES, DOWNLOAD_SIZE } from '../docs/js/v3-star.js';

const data = JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references-v3.json', import.meta.url), 'utf8'));

test('dan-references-v3.json has the v3 header and format', () => {
  validateDanReferences(data, V3_REFERENCES);
});

test('dan-references-v3.json is not the placeholder', () => {
  assert.ok(!('placeholder' in data), 'docs/data/dan-references-v3.json is still the placeholder (P1h readings): replace it with the v3 readings');
});

test('download sizes are filled in', () => {
  assert.ok(!DOWNLOAD_SIZE.placeholder, 'DOWNLOAD_SIZE in docs/js/v3-star.js is still a placeholder: fill in the sizes and remove placeholder');
  assert.ok(!/\?/.test(DOWNLOAD_SIZE.first + DOWNLOAD_SIZE.v3));
});
