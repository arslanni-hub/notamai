// node rwy-cond.test.js
const assert = require('assert');
const R = require('./rwy-cond');
let n = 0;
const t = (name, fn) => { fn(); n++; };

t('metar new-format group: ice 51-100% 2mm friction 0.25 -> tier 1', () => {
  const g = R.parseMetar('UUEE 061200Z 03005MPS 9999 -SN OVC010 M02/M04 Q1012 R06L/790225 NOSIG');
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].rwy, '06L'); assert.strictEqual(g[0].deposit, 'ice'); assert.strictEqual(g[0].extent, '51–100%');
  assert.strictEqual(g[0].depth, '2 mm'); assert.strictEqual(g[0].level, 1); assert.strictEqual(g[0].tier, 1);
});
t('metar friction 0.33 -> medium -> tier 2', () => { const g = R.parseMetar('ULLI 061200Z 00000MPS CAVOK M01/M03 Q1020 R28L/590133'); assert.strictEqual(g[0].level, 3); assert.strictEqual(g[0].tier, 2); });
t('metar dry snow, good braking 95 -> tier 3 (contaminated)', () => { const g = R.parseMetar('EFRO 061200Z 1/2SM SN R03/490395'); assert.strictEqual(g[0].tier, 3); assert.strictEqual(g[0].depth, '3 mm'); });
t('metar wet, friction 0.55 -> no factor', () => { const g = R.parseMetar('EDDF 061200Z R25C/290055'); assert.strictEqual(g[0].tier, null); });
t('CLRD', () => { const g = R.parseMetar('UNNT 061200Z R07/CLRD60'); assert.strictEqual(g[0].cleared, true); assert.strictEqual(g[0].tier, null); });
t('SNOCLO', () => { const g = R.parseMetar('UHHH 061200Z +SN R/SNOCLO'); assert.strictEqual(g[0].snoclo, true); assert.strictEqual(g[0].tier, 1); });
t('RVR is not a state group', () => { assert.strictEqual(R.parseMetar('EGLL 061200Z 0300 R27L/0550N R09R/P2000 FG').length, 0); });
t('depth 99 = not operational -> tier 1', () => { assert.strictEqual(R.parseMetar('UWWW 061200Z R15/4999//').length, 1); assert.strictEqual(R.parseMetar('UWWW 061200Z R15/4999//')[0].tier, 1); });
t('group after RMK ignored', () => { assert.strictEqual(R.parseMetar('KXYZ 061200Z 10SM RMK R06L/790225').length, 0); });
t('old right-runway convention 74 -> 24R', () => { assert.strictEqual(R.parseMetar('XXXX R74/290055')[0].rwy, '24R'); });

t('FICON 3/3/3 -> tier 2', () => { const x = R.parseNotam('!JFK 11/045 JFK RWY 04L FICON 3/3/3 100 PCT 1/8IN WET SN, 100 PCT 1/8IN WET SN, 100 PCT 1/8IN WET SN OBS AT 2611061200'); assert.strictEqual(x.rwy, '04L'); assert.strictEqual(x.level, 3); assert.strictEqual(x.tier, 2); });
t('FICON 5/5/5 wet -> not contaminated, no factor', () => { const x = R.parseNotam('!DEN 11/012 DEN RWY 16R FICON 5/5/5 100 PCT WET OBS AT 2611061200'); assert.strictEqual(x.tier, null); });
t('FICON 5/5/5 dry snow -> tier 3', () => { const x = R.parseNotam('RWY 16R FICON 5/5/5 100 PCT 1/8IN DRY SN OBS AT 2611061200'); assert.strictEqual(x.tier, 3); });
t('FICON 1/1/2 -> tier 1', () => { assert.strictEqual(R.parseNotam('RWY 27 FICON 1/1/2 100 PCT ICE OBS AT 2611061200').tier, 1); });
t('braking action poor', () => { const x = R.parseNotam('RWY 06 BRAKING ACTION POOR'); assert.strictEqual(x.level, 1); assert.strictEqual(x.tier, 1); });
t('BA MEDIUM TO POOR', () => { assert.strictEqual(R.parseNotam('RWY 09 BA MEDIUM TO POOR').level, 2); });
t('taxiway FICON not scored', () => { const x = R.parseNotam('TWY A FICON 1/8IN DRY SN OBS AT 2611061200'); assert.strictEqual(x.tier, null); assert.strictEqual(x.rwy, 'TWY/APRON'); });
t('ordinary NOTAM -> null', () => { assert.strictEqual(R.parseNotam('RWY 06 PAPI U/S'), null); });

t('category', () => {
  assert.strictEqual(R.category('RWY 04L FICON 3/3/3'), 'rwy');
  assert.strictEqual(R.category('RWY 06 CLSD DUE SNOW REMOVAL'), 'rwy');
  assert.strictEqual(R.category('BIRD ACTIVITY IN VICINITY OF AD'), 'bird');
  assert.strictEqual(R.category('VOLCANIC ASH CLOUD OBS FL100-FL250'), 'ash');
  assert.strictEqual(R.category('Q) BIRD/QWWXX/IV/NBO/W/000/999/6400N01900W999 E) VOLCANIC ACTIVITY'), 'ash');
  assert.strictEqual(R.category('DE-ICE PAD 2 CLSD'), null);
  assert.strictEqual(R.category('TWY B CLSD'), null);
  assert.strictEqual(R.category('RWY 06 PAPI U/S'), null);
});

t('winterHint', () => {
  assert.ok(R.winterHint('EFHK 061200Z 02010KT 3000 -RASN BKN008 01/M00 Q1001', '').length >= 1);
  assert.ok(R.winterHint('ENGM 061200Z 00000KT CAVOK M05/M08 Q1030', '').some(x => /temperature -5/.test(x)));
  assert.strictEqual(R.winterHint('LTFM 061200Z 20010KT CAVOK 18/09 Q1015', 'TAF LTFM 0612/0718 20010KT CAVOK').length, 0);
  assert.ok(R.winterHint('LTFM 061200Z CAVOK 08/02', 'TAF LTFM 0612/0718 9999 TEMPO 0700/0706 FZFG').length === 1);
});
t('usesFicon', () => { assert.ok(R.usesFicon('KJFK')); assert.ok(!R.usesFicon('ENGM')); });
console.log('rwy-cond tests passed:', n);
