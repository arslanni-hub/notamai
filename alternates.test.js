'use strict';
// Run:  node alternates.test.js
const assert = require('assert');
const A = require('./alternates');
let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  PASS  ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); } }

const AP = 'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code\n' +
  '1,LTAI,large_airport,"Antalya Airport",36.8987,30.8005,177,AS,TR,TR-07,Antalya,yes,LTAI\n' +
  '2,LTBS,medium_airport,"Dalaman Airport",36.7131,28.7925,20,AS,TR,TR-48,Dalaman,yes,LTBS\n' +
  '3,LTFE,medium_airport,"Milas-Bodrum Airport",37.2506,27.6643,21,AS,TR,TR-48,"Bodrum, Mugla",yes,LTFE\n' +
  '4,LTAN,medium_airport,"Konya Airport",37.979,32.5619,3392,AS,TR,TR-42,Konya,yes,LTAN\n' +
  '5,LTXX,small_airport,"Small Strip",36.95,30.9,100,AS,TR,TR-07,Nowhere,no,\n' +
  '6,LTFM,large_airport,"Istanbul Airport",41.2753,28.7519,325,AS,TR,TR-34,Istanbul,yes,LTFM\n' +
  '7,LTBA,large_airport,"Istanbul Ataturk Airport",40.9769,28.8146,163,AS,TR,TR-34,Istanbul,yes,LTBA\n' +
  '8,LTSS,medium_airport,"Short Runway Airport",36.9,30.5,100,AS,TR,TR-07,Short,yes,LTSS\n' +
  '9,XX1,small_airport,"Not Icao",36.9,30.5,100,AS,TR,TR-07,X,no,\n';
const RW = 'id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,he_ident\n' +
  '1,1,LTAI,11500,148,ASP,1,0,18C,36C\n2,2,LTBS,9800,148,ASP,1,0,01,19\n3,3,LTFE,11000,148,ASP,1,0,12,30\n' +
  '4,4,LTAN,10000,148,ASP,1,0,01,19\n5,8,LTSS,4000,100,ASP,1,0,01,19\n6,6,LTFM,13000,200,ASP,1,0,16L,34R\n7,3,LTFE,11000,148,ASP,1,1,05,23\n';
const aps = A.buildAirports(AP), rws = A.buildRunwayLengths(RW);

test('parses airports and keeps only ICAO-looking idents', () => { assert(aps.has('LTAI') && !aps.has('XX1')); });
test('candidate flag: scheduled medium/large only, LTBA never', () => { assert(aps.get('LTBS').cand && !aps.get('LTXX').cand && !aps.get('LTBA').cand); });
test('quoted commas in the city survive', () => { assert.strictEqual(aps.get('LTFE').city, 'Bodrum, Mugla'); });
test('runway lengths use the longest open runway', () => { assert.strictEqual(rws.get('LTFE'), 11000); assert.strictEqual(rws.get('LTSS'), 4000); });
test('distance LTAI-LTBS is about 100 NM', () => { const d = A.distNm(aps.get('LTAI'), aps.get('LTBS')); assert(d > 90 && d < 115, d); });
test('nearest candidates to LTAI: Dalaman first, short runway and self excluded', () => {
  const c = A.nearestCandidates('LTAI', ['LTFM', 'LTAI'], 4, aps, rws);
  assert.strictEqual(c[0].icao, 'LTBS');
  assert(!c.some(x => x.icao === 'LTSS' || x.icao === 'LTAI' || x.icao === 'LTBA'));
  assert(c.length >= 2 && c.every(x => x.nm <= 350));
});
test('without runway data candidates are not filtered by length', () => {
  const c = A.nearestCandidates('LTAI', ['LTFM', 'LTAI'], 6, aps, null);
  assert(c.some(x => x.icao === 'LTSS'));
});
test('block lists both ends and the warning', () => {
  const b = A.buildBlock('LTFM', 'LTAI', aps, rws);
  assert(/CANDIDATE ALTERNATES/.test(b) && /Near LTAI/.test(b) && /LTBS Dalaman Airport/.test(b) && /NOT checked/.test(b));
});
test('unknown airport gives an empty block', () => { assert.strictEqual(A.buildBlock('ZZZZ', 'YYYY', aps, rws), ''); });
test('candidateBlock before load returns an empty string', () => { assert.strictEqual(A.candidateBlock('LTFM', 'LTAI'), ''); });

// Airport search box index
const SA = 'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code\n' +
  '1,LTFM,large_airport,"İstanbul Airport",41.27,28.75,325,AS,TR,TR-34,Istanbul,yes,LTFM,IST,LTFM\n' +
  '2,LTFJ,large_airport,"Istanbul Sabiha Gökçen International Airport",40.89,29.3,312,AS,TR,TR-34,"Pendik, Istanbul",yes,LTFJ,SAW,LTFJ\n' +
  '3,LTAC,large_airport,"Esenboğa International Airport",40.12,32.99,3125,AS,TR,TR-06,Ankara,yes,LTAC,ESB,LTAC\n' +
  '4,EGGW,large_airport,"London Luton Airport",51.87,-0.36,526,EU,GB,GB-ENG,Luton,yes,EGGW,LTN,EGGW\n' +
  '5,TR-0045,heliport,"Ataköy Marina Helipad",40.97,28.87,0,AS,TR,TR-34,Istanbul,no,,,\n' +
  '6,XX99,closed,"Old Field",40,29,0,AS,TR,TR-34,Istanbul,no,,,\n';
const idx = A.buildSearchIndex(SA);
test('search index skips closed aerodromes and keeps heliports', () => { assert(idx.length === 5 && !idx.some(a => a.id === 'XX99')); });
test('exact ICAO and IATA codes come first', () => { assert.strictEqual(A.searchIn(idx, 'ltac')[0].id, 'LTAC'); assert.strictEqual(A.searchIn(idx, 'SAW')[0].id, 'LTFJ'); });
test('ICAO prefix beats IATA prefix ("LT" -> Turkish airports before Luton)', () => { const r = A.searchIn(idx, 'lt').map(a => a.id); assert(r.indexOf('EGGW') > r.indexOf('LTFM')); });
test('Turkish letters and accents are ignored', () => {
  ['İstanbul', 'ıstanbul', 'ISTANBUL'].forEach(q => { const r = A.searchIn(idx, q).map(a => a.id); assert(r.includes('LTFM') && r.includes('LTFJ'), q); });
  assert.strictEqual(A.searchIn(idx, 'esenboga')[0].id, 'LTAC');
});
test('airports rank above heliports for the same city', () => { const r = A.searchIn(idx, 'istanbul').map(a => a.id); assert.strictEqual(r[r.length - 1], 'TR-0045'); });
test('one character returns nothing; searchAirports is null before load', () => { assert.deepStrictEqual(A.searchIn(idx, 'l'), []); assert.strictEqual(A.searchAirports('ltfm'), null); });

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
