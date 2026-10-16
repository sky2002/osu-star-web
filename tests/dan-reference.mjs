import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  validateDanReferences, referencesForModel, selectDanReferences,
  danReferenceCopyLines, DAN_REFERENCE_WARNING,
} from '../docs/js/dan-reference.js';
import { buildCopyText } from '../docs/js/ui-lib.js';
import { VERSION, FROZEN } from '../docs/js/engine.js';

const catalog = validateDanReferences(JSON.parse(fs.readFileSync(new URL('../docs/data/dan-references.json', import.meta.url), 'utf8')));
const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/reference.json', import.meta.url), 'utf8')).charts;
const itemFixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/reference-rice-ln-od.json', import.meta.url), 'utf8')).charts;
const model = { version: VERSION, frozen: FROZEN };
// v2：整谱 97% ScoreV2 读数（LN 组用），默认比总星数高 0.6
const result = (star, reliable = true, v2 = Number.isFinite(star) ? star + 0.6 : star) => ({ ok: true, star, reliable, v2: { star: v2 } });
const identifiers = (group) => group.matches.map((entry) => entry.id);
const expectedHashes = {
  'ln-14': 'c9153781895ee7a43cf6e9046ee75ace49a989f012e9f695f107fb5769ca4431',
  'ln-15': '7ccd874d656637f75c100056d9f7e179a89e71a003bfd43460b05995a0b210eb',
  'ln-1': 'e25bae0312752936aa11a862d152960885ad0e14e47e521264b3c31fd1982ef3',
  'ln-2': '5f0af1bc3e950bab03b37b939c72cd6af35507cafed5f611b227831a6318c6bd',
  'ln-3': 'd076bdfc091ae8d8007db7ee6fa728ea5364eeee14e0903a69507c10d93c8e36',
  'ln-4': 'fa35c6ab0e7729de2634d5c03e42512b061affc9ad27d17538fee1b2d1b0070f',
  'ln-5': '3674262a04387d3bb9892323a0b009967e9b3a62222ba1cd33d36dee743cfa90',
  'ln-6': 'e8c370d732a3184b20fa500485e6ec019f93d10399bb42f270e170feb44e1b46',
  'ln-7': 'fe011c76e1f8080d130fc262379feb008a16df74d63a336d3d75f9df56f2285b',
  'ln-10': '9e9d59bdc8a2c38713d12954f20fc6b904582d6f2293299b535f2af2ea27d2a7',
  'ln-8': 'faa9659b4afd48634024a85d3301248cccef384adb787eb93ad16c70dcb3988b',
  'ln-9': 'ae8ef8364d5d05fccf2ed5d6571bcfe05bfe7ccbdb1a42bf3a8fb0b8cff01f77',
  'ln-11': 'b68cf40da359afc4766d270a59561c8f6fe507a5a075be619ed13dd19aff1144',
  'ln-12': 'c6a624bdf9d469786524e6661682bfeeed56064e2b5388761060ae8200301ca6',
  'ln-13': 'cd0fec32121b1bcee5b76e1e0a975dd28d71c5cc51fc2fed21c58e9f7d607390',
  'reform-1st': 'ebf2ed752203ed5466a0f8f7fa88dc3c75536e246e7811bd117e24e08aee7e6a',
  'reform-2nd': '962d8a2dda8c5f65bc13339ccbb4338dc74d706cadd3f5ba17ad581a9155f2af',
  'reform-3rd': 'e0cdd48a5d0c0c484649109e3bbe67939c9867af404b4548bf3e1bfd2fa24285',
  'reform-4th': 'f87a66bcd6952a6646c83bde8c61cdc9542042fc8e0140eeb3641d44bec0c729',
  'reform-5th': '306965d5a2b7990f60568682f44b5f0b556b5f44fb2b97b92775495902bcc4ee',
  'reform-6th': '7a42095453df952b05eaf105f6299e4a318c477dba877e607fe7c0efaa81592b',
  'reform-intro-1st': '990bd1cc0176d20cef1d667b187dd3e54c4d9dc656470f07270eb8e779812687',
  'reform-intro-2nd': '1fe2376bbdd714bac03420ca0a0d99fccaeb0b998883a1054a199d807e2c3527',
  'reform-intro-3rd': '1062858deb873d06bdfedaae4ded9ca9e66fd01e7dcb8ea1eb4a0ad2ea9599e8',
  'reform-10th': '0a23f4c677abd430ce76ed1794be47d3bfa379817d94dbcb903c26770a35c2a0',
  'reform-7th': '5c8340db74be5d3b7357ec0b2625968d60d54c55b83aaf84ef20793e94248ead',
  'reform-8th': 'd20fe98af89aeb8fd1b6c4773b90f31c924bb0e4f736ec3bd61786e23c005945',
  'reform-9th': '7dac3baa2b2e1c52026d43ea231f4ce1bbb38bcb239e1cdb702e906bc67df9e4',
  'reform-alpha': 'da3500338ee2bb440117fe8b7aee1ec1544ceadb05899337035c9c29a5f41994',
  'reform-beta': 'dcb943705122e6662b0cedfbf7878f1226eb746744723db26560b6a620b97a4c',
  'reform-delta': '3aa82a9f7a2344f2d11319823c84a87c42a19ad9fae3eee457e3f635b1492635',
  'reform-epsilon': '68f30db44d73757e0ba29ea8a255e43baf358a9b47d921aed7e5beffd9eb9a63',
  'reform-gamma': '02bf168e5a42278c250d205f2722b6bc7c0a30669e22d5e5147c4ad594495d39',
  'reform-eta': '50846172498780da5e303d03b0f68814c439e7b274da2ba5ba5da703c0f0d536',
  // Zeta = Sample Dan v2 (credit to emik); the FINAL pack ZETA (820efd38…) is not the course in use
  'reform-zeta': 'c4cd38cb9def17d45f34cdfed6a24678f42308e772515417122b86f6d739bb2e',
};

test('all 35 references retain the exact fixture identity, source group and P1h reading', () => {
  assert.deepEqual(catalog.groups.map((group) => group.entries.length), [20, 15]);
  const entries = catalog.groups.flatMap((group) => group.entries);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 35);
  for (const group of catalog.groups) {
    for (const entry of group.entries) {
      const matches = fixtures.filter((fixture) => fixture.member === null && fixture.sha256 === expectedHashes[entry.id]);
      assert.equal(matches.length, 1, entry.id);
      const fixture = matches[0];
      assert.equal(entry.star, fixture.star, entry.id);
      assert.match(fixture.source, group.id === 'reform'
        ? /^test_beatmap\/Various Artists - (Dan ~ REFORM ~ (1st Pack|2nd Pack|FINAL) |Zeta Sample Dan v2 .+credit to emik\)\]\.osu$)/u
        : /^test_beatmap\/LN dan\/.+4K LN Dan Courses v2.+\(Marathon\)\]\.osu$/u);
      assert.deepEqual(Object.keys(entry).sort(), group.id === 'ln' ? ['id', 'label', 'reliable', 'star', 'starV2', 'url'] : ['id', 'label', 'reliable', 'star', 'url']);
      if (group.id === 'ln') {
        // whole-chart 97 % ScoreV2 star (face dan reference) vs the Python reference of rice-ln-od r1 (v2_c1)
        const py = itemFixtures.filter((c) => c.sha256 === fixture.sha256 && c.member === null && c.rate === 1);
        assert.equal(py.length, 1, entry.id);
        assert.ok(Math.abs(entry.starV2 - py[0].v2_c1) < 1e-6, entry.id);
      }
      assert.match(entry.url, /^https:\/\/osu\.ppy\.sh\/beatmaps\/[1-9]\d*$/u);
    }
  }
});

test('REFORM 6th uses the canonical 1st Pack variant once', () => {
  const entries = catalog.groups[0].entries.filter((entry) => entry.id === 'reform-6th');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].star, 4.580144073119622);
  assert.notEqual(entries[0].star, 4.676470452452296);
});

test('6.70 (97% V2 7.30) shows Beta/Gamma and LN 12/13 on their 97% V2 readings', () => {
  const view = selectDanReferences(result(6.70), catalog);
  assert.deepEqual(identifiers(view.groups[0]), ['reform-beta', 'reform-gamma']);
  assert.deepEqual(view.groups[0].matches.map((entry) => entry.star.toFixed(2)), ['6.41', '7.00']);
  assert.deepEqual(identifiers(view.groups[1]), ['ln-12', 'ln-13']);
  assert.deepEqual(view.groups[1].matches.map((entry) => entry.star.toFixed(2)), ['7.07', '7.44']);
});

test('the 0.5-star boundary is included and farther readings are excluded', () => {
  const custom = { groups: [{ id: 'reform', label: 'REFORM 主线', entries: [
    { id: 'lower', star: 6.2 }, { id: 'upper', star: 7.2 },
    { id: 'too-low', star: 6.1999 }, { id: 'too-high', star: 7.2001 },
  ] }] };
  assert.deepEqual(identifiers(selectDanReferences(result(6.7), custom).groups[0]), ['lower', 'upper']);
});

test('chooses at most two closest readings per group and shows them in star order', () => {
  for (const star of [1.5, 2.9, 4.5, 6.7, 7.3, 9.8]) {
    for (const group of selectDanReferences(result(star), catalog).groups) {
      assert.ok(group.matches.length <= 2);
      const reading = group.id === 'ln' ? star + 0.6 : star;
      assert.ok(group.matches.every((entry) => Math.abs(entry.star - reading) <= 0.5));
      assert.deepEqual(group.matches.map((entry) => entry.star), group.matches.map((entry) => entry.star).sort((first, second) => first - second));
    }
  }
});

test('low and high LN readings leave the group empty when no course is near', () => {
  assert.equal(selectDanReferences(result(1.5), catalog).groups[1].matches.length, 0);
  assert.equal(selectDanReferences(result(8.1), catalog).groups[1].matches.length, 0);
  assert.ok(danReferenceCopyLines(selectDanReferences(result(8.1), catalog)).some((line) => line.includes('LN Dan Courses v2：暂无接近的参考谱')));
});

test('LN list uses 97% V2 readings from 5th up, and is empty without a V2 reading', () => {
  const view = selectDanReferences(result(4.8, true, 5.4), catalog);
  assert.deepEqual(identifiers(view.groups[1]), ['ln-5', 'ln-6']);   // LN 5th (V2 5.42) is closest, listed from 5th up
  assert.match(view.groups[1].note, /97% ScoreV2/u);
  assert.equal(selectDanReferences(result(3.0, true, 3.9), catalog).groups[1].matches.length, 0);
  assert.equal(selectDanReferences({ ok: true, star: 6.7, reliable: true }, catalog).groups[1].matches.length, 0);
  assert.deepEqual(identifiers(selectDanReferences({ ok: true, star: 6.7, reliable: true }, catalog).groups[0]), ['reform-beta', 'reform-gamma']);
});

test('invalid readings and unsuccessful results do not produce references', () => {
  for (const reading of [NaN, Infinity, -1, null, '6.7']) assert.equal(selectDanReferences(result(reading), catalog), null);
  for (const invalid of [null, {}, { ok: false, star: 6.7 }]) assert.equal(selectDanReferences(invalid, catalog), null);
});

test('missing data preserves a successful score with unavailable references', () => {
  assert.deepEqual(selectDanReferences(result(6.7), null), { available: false, resultUnreliable: false, groups: [] });
  assert.deepEqual(danReferenceCopyLines(selectDanReferences(result(6.7), null)), ['附近段位参考谱：暂不可用']);
});

test('model version and frozen date must match the ready message', () => {
  assert.equal(referencesForModel(catalog, model), catalog);
  assert.equal(referencesForModel(catalog, { ...model, version: '树星数 v2' }), null);
  assert.equal(referencesForModel(catalog, { ...model, frozen: '2026-10-15' }), null);
  assert.equal(referencesForModel(catalog, null), null);
});

test('bad catalogs, duplicate ids and unsafe links are rejected', () => {
  for (const invalid of [null, {}, { ...catalog, version: 'P2' }, { ...catalog, modelVersion: '树星数 v2' }, { ...catalog, frozen: '2026-10-15' }]) assert.throws(() => validateDanReferences(invalid));
  const duplicate = structuredClone(catalog);
  duplicate.groups[0].entries[1].id = duplicate.groups[0].entries[0].id;
  assert.throws(() => validateDanReferences(duplicate));
  const unsafe = structuredClone(catalog);
  unsafe.groups[0].entries[0].url = 'javascript:alert(1)';
  assert.throws(() => validateDanReferences(unsafe));
  const wrongStar = structuredClone(catalog);
  wrongStar.groups[0].entries[0].star = null;
  assert.throws(() => validateDanReferences(wrongStar));
  const incomplete = structuredClone(catalog);
  incomplete.groups[1].entries.pop();
  assert.throws(() => validateDanReferences(incomplete));
});

test('Eta keeps its historical unreliability warning and LN 15 stays unflagged', () => {
  const view = selectDanReferences(result(9.8, false), catalog);
  assert.equal(view.resultUnreliable, true);
  assert.deepEqual(identifiers(view.groups[0]), ['reform-eta']);
  assert.equal(view.groups[0].matches[0].reliable, false);
  assert.equal(catalog.groups[1].entries.find((entry) => entry.id === 'ln-15').reliable, true);
  const lines = danReferenceCopyLines(view);
  assert.ok(lines.includes(DAN_REFERENCE_WARNING));
  assert.ok(lines.some((line) => line.includes('REFORM Eta ★ 9.79（读数不可靠）')));
});

test('feedback copy includes only the displayed nearby groups for successful results', () => {
  const score = result(6.7);
  const text = buildCopyText(score, {}, 'chart.osu', model, selectDanReferences(score, catalog));
  assert.match(text, /REFORM Beta ★ 6\.41；REFORM Gamma ★ 7\.00/u);
  assert.match(text, /LN 12th Dan - Yuugure ★ 7\.07；LN 13th Dan - Yoru ★ 7\.44/u);
  assert.doesNotMatch(text, /REFORM Alpha/u);
  assert.match(text, /不代表通过能力/u);
  for (const rejected of [null, { ok: false, message: '不是 4K' }]) {
    const plain = buildCopyText(rejected, {}, 'chart.osu', model);
    assert.equal(buildCopyText(rejected, {}, 'chart.osu', model, selectDanReferences(score, catalog)), plain);
    assert.doesNotMatch(plain, /附近段位/u);
  }
});
