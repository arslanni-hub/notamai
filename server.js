const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: 'notamai-a9d57',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    })
  });
}

const adminDb = admin.firestore();

const PILOT_IMAGE_PATH = './pilot_image.jpg';
let heygenTestLock = false;
let videoBriefingLock = false;

// Download pilot image on startup if not already present
if (!fs.existsSync(PILOT_IMAGE_PATH)) {
  https.get('https://i.imgur.com/Aap70Bx.jpeg', res => {
    const file = fs.createWriteStream(PILOT_IMAGE_PATH);
    res.pipe(file);
    file.on('finish', () => console.log('[PILOT IMAGE] Downloaded'));
  });
}

const PLAN_LIMITS = {
  free:    { briefings: 3,   chat: 0,   analysis: 0   },
  pro:     { briefings: 100, chat: 200, analysis: 300  },
  premium: { briefings: 150, chat: 999, analysis: 999  }
};

async function getUserPlan(userId) {
  try {
    const userRecord = await admin.auth().getUser(userId);
    if (userRecord.email === 'arslanni@gmail.com') return 'premium';
    const doc = await adminDb.collection('users').doc(userId).get();
    const plan = doc.exists ? (doc.data().plan || 'free') : 'free';
    console.log('[PLAN CHECK]', userId, 'plan:', plan);
    return plan;
  } catch(e) {
    console.log('[PLAN CHECK] Error for', userId, ':', e.message);
    return 'free';
  }
}

async function getUserUsage(userId, field) {
  try {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const doc = await adminDb.collection('usage').doc(userId + '_' + monthKey).get();
    return doc.exists ? (doc.data()[field] || 0) : 0;
  } catch(e) {
    return 0;
  }
}

async function incrementUsage(userId, field) {
  try {
    const now = new Date();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const ref = adminDb.collection('usage').doc(userId + '_' + monthKey);
    await ref.set({ [field]: admin.firestore.FieldValue.increment(1), userId, month: monthKey }, { merge: true });
  } catch(e) {}
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const NOTAMIFY_KEY = process.env.NOTAMIFY_KEY;
const PORT = process.env.PORT || 3000;

const AIRPORT_NAMES = {
  LTFM: 'Istanbul Airport (IST)',
  LTBA: 'Istanbul Atatürk Airport (closed)',
  LTAI: 'Antalya Airport',
  LTFD: 'Balıkesir Koca Seyit Airport',
  LTBJ: 'İzmir Adnan Menderes Airport',
  LTAC: 'Ankara Esenboğa Airport',
  LTFE: 'Dalaman Airport',
  LTBS: 'Bodrum Milas Airport',
  EGLL: 'London Heathrow',
  EGKK: 'London Gatwick',
  EHAM: 'Amsterdam Schiphol',
  EDDF: 'Frankfurt Airport',
  LFPG: 'Paris Charles de Gaulle',
  LEMD: 'Madrid Barajas',
  LIRF: 'Rome Fiumicino',
  LSZH: 'Zurich Airport',
  LOWW: 'Vienna International Airport',
  EKCH: 'Copenhagen Airport',
};

function airportName(icao) {
  return icao ? (AIRPORT_NAMES[icao.toUpperCase()] || icao) : '';
}

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchNotams(icao) {
  if (!icao) return '';
  try {
    const url = `https://skylink-api.p.rapidapi.com/notams/${icao}`;
    const data = await fetchURL(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': process.env.SKYLINK_KEY,
        'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
      }
    });
    if (data.error || !data.notams || data.notams.length === 0) return `No active NOTAMs for ${icao}.`;
    const now = new Date();
    const activeNotams = data.notams.filter(n => {
      if (!n.expiration) return true;
      if (n.expiration.length < 12) return true;
      const e = n.expiration;
      const expDate = new Date(Date.UTC(
        parseInt(e.slice(0,4)),
        parseInt(e.slice(4,6)) - 1,
        parseInt(e.slice(6,8)),
        parseInt(e.slice(8,10)),
        parseInt(e.slice(10,12))
      ));
      return expDate > now;
    });
    console.log('[FILTER]', icao, 'total:', data.notams.length, 'active after filter:', activeNotams.length);
    if (activeNotams.length === 0) return `No active NOTAMs for ${icao}.`;
    return activeNotams.slice(0, 8).map((n, i) => {
      const raw = (n.raw || n.body || '').trim().slice(0, 500);
      return `[${icao} NOTAM ${i+1}] ${n.notam_id || ''}:\n${raw}`;
    }).join('\n\n---\n\n');
  } catch (e) { return `Could not fetch NOTAMs for ${icao}: ${e.message}`; }
}

// Oceanic FIRs that use SkyLink fallback messaging
const OCEANIC_FIRS = new Set(['KZNY', 'CZQX', 'EGGX', 'KZAK']);

// Fetch en-route FIR NOTAMs based on dep/arr ICAO pair
async function getEnrouteNotams(dep, arr) {
  const firMap = {
    // EUROPE
    'EG': 'EGTT', 'EI': 'EISN', 'EB': 'EBUR', 'EH': 'EHAA',
    'ED': 'EDGG', 'ET': 'EDGG', 'EK': 'EKDK', 'EN': 'ENOR',
    'EF': 'EFIN', 'EV': 'EVRR', 'EY': 'EYVL', 'EE': 'EETT',
    'LF': 'LFFF', 'LG': 'LGGG', 'LI': 'LIIV', 'LE': 'LECM',
    'LP': 'LPPC', 'LT': 'LTBB', 'LK': 'LKAA', 'LO': 'LOVV',
    'LZ': 'LZBB', 'LB': 'LBSR', 'LR': 'LRBB', 'LY': 'LYBA',
    'LD': 'LDZO', 'LJ': 'LJLA', 'LH': 'LHCC', 'EP': 'EPWW',
    'EL': 'ELLX', 'ES': 'ESAA', 'BI': 'BIRD',
    // OCEANIC
    'CZ': 'CZQX', 'KZ': 'KZNY', 'KA': 'KZAK',
    'NF': 'NFFF', 'NT': 'NTTT',
    // NORTH AMERICA
    'KJ': 'KZNY', 'KF': 'KZNY', 'KL': 'KZNY', 'KP': 'KZAK',
    'KS': 'KZLC', 'KD': 'KZDV', 'KM': 'KZMA',
    'CY': 'CZEG', 'CW': 'CZWG', 'CU': 'CZUL', 'CV': 'CZVR',
    'MX': 'MMEX', 'MT': 'MMFO',
    // CARIBBEAN & CENTRAL AMERICA
    'MU': 'MUHA', 'MH': 'MHTE', 'MR': 'MROC', 'MP': 'MPTO',
    'MS': 'MSSS', 'MD': 'MDCS', 'TJ': 'TJZS',
    'TN': 'TNCF', 'TB': 'TBPB', 'TV': 'TVSM',
    // SOUTH AMERICA
    'SB': 'SBBS', 'SC': 'SCEZ', 'SK': 'SKED', 'SL': 'SLCO',
    'SE': 'SEFG', 'SP': 'SPIM', 'SU': 'SUEO', 'SA': 'SAEF',
    'SV': 'SVZM', 'SO': 'SOOO', 'SY': 'SYYY', 'SM': 'SMPM',
    // NORTH AFRICA
    'DA': 'DAAA', 'DT': 'DTTC', 'GM': 'GMMM', 'GC': 'GCCC',
    'GL': 'GLRB', 'GO': 'GOOO', 'GU': 'GUOO', 'GF': 'GFLL',
    'GQ': 'GQNN', 'GB': 'GBYD',
    // WEST & CENTRAL AFRICA
    'DN': 'DNKK', 'DB': 'DBBB', 'DG': 'DGAC', 'DI': 'DIAP',
    'DF': 'DFFD', 'GG': 'GGVO', 'GS': 'GABS', 'HK': 'HKNA',
    'FC': 'FCCC', 'FE': 'FEFF', 'FD': 'FDJJ', 'FG': 'FGSL',
    'FH': 'FHAW', 'FS': 'FSSS', 'FZ': 'FZAA',
    // EAST AFRICA
    'HE': 'HECC', 'HA': 'HAAA', 'HD': 'HDDD', 'HH': 'HHAS',
    'HC': 'HCSM', 'HR': 'HRRR', 'HS': 'HSSN', 'HT': 'HTTC',
    'HU': 'HUEC',
    // SOUTH AFRICA
    'FA': 'FAJA', 'FB': 'FBGR', 'FI': 'FIMP', 'FK': 'FKKD',
    'FL': 'FLFI', 'FM': 'FMMM', 'FN': 'FNAN', 'FP': 'FPPR',
    'FQ': 'FQBE', 'FT': 'FTTT', 'FV': 'FVHF', 'FW': 'FWLL',
    'FX': 'FXMM', 'FY': 'FYWH',
    // MIDDLE EAST
    'OB': 'OBBB', 'OE': 'OEJD', 'OI': 'OIIX', 'OJ': 'OJAC',
    'OK': 'OKAC', 'OL': 'OLLC', 'OM': 'OMAE', 'OO': 'OOKB',
    'OP': 'OPKR', 'OR': 'ORBB', 'OS': 'OSTT', 'OT': 'OTBD',
    'OY': 'OYSC',
    // CENTRAL ASIA
    'UT': 'UTAA', 'UC': 'UCFM', 'UA': 'UAAA', 'UM': 'UMMV',
    'UG': 'UGGD', 'UD': 'UDDD', 'UI': 'UIIT',
    // RUSSIA
    'UL': 'ULLL', 'UU': 'UUWV', 'UK': 'UKBV', 'UN': 'UNNT',
    'UH': 'UHHH', 'UE': 'UEEE', 'UB': 'UBBP', 'US': 'USSS',
    'UO': 'UOOO', 'UF': 'UFFF', 'UP': 'UPCM',
    // SOUTH ASIA
    'VA': 'VAAF', 'VC': 'VCCF', 'VE': 'VECF', 'VG': 'VGDT',
    'VI': 'VIDF', 'VN': 'VNKT', 'VO': 'VOCB', 'VQ': 'VQPR',
    'VR': 'VRMF', 'VT': 'VTBB',
    // SOUTHEAST ASIA
    'VB': 'VBBB', 'VD': 'VDPP', 'VH': 'VHHK', 'VL': 'VLVT',
    'VV': 'VVHM', 'WA': 'WAAF', 'WB': 'WBFC',
    'WI': 'WIIF', 'WM': 'WMFC', 'WP': 'WPDL', 'WS': 'WSJC',
    'RP': 'RPHI',
    // EAST ASIA
    'ZB': 'ZBPE', 'ZG': 'ZGZU', 'ZH': 'ZHWH', 'ZJ': 'ZJSA',
    'ZK': 'ZKPY', 'ZL': 'ZLHW', 'ZP': 'ZPKM', 'ZS': 'ZSHA',
    'ZU': 'ZUUU', 'ZW': 'ZWWW', 'ZY': 'ZYSH',
    'RK': 'RKRR', 'RJ': 'RJJJ', 'RC': 'RCTP',
    // MONGOLIA
    'ZM': 'ZMUB', 'MG': 'ZMUB',
    // PACIFIC
    'AY': 'AYPM', 'AG': 'AGGG', 'AN': 'ANAU', 'NC': 'NCRG',
    'NG': 'NGTA', 'NK': 'NKSO', 'NL': 'NLWW', 'NS': 'NSFA',
    'NV': 'NVVV', 'NW': 'NWWW', 'NZ': 'NZZC',
    'PH': 'PHZH', 'PJ': 'PJON', 'PK': 'PKWA', 'PL': 'PLCH',
    'PT': 'PTID',
    // AUSTRALIA
    'YB': 'YMMM', 'YM': 'YMMM', 'YS': 'YMMM', 'YW': 'YMMM', 'YA': 'YMMM',
  };

  const firCoordinates = {
    'LTBB': [39.0, 35.0], 'EGTT': [51.5, -0.5], 'EDGG': [50.0, 9.0],
    'LFFF': [47.0, 2.0], 'LIIV': [44.0, 12.0], 'LGGG': [38.0, 24.0],
    'LKAA': [50.0, 16.0], 'LOVV': [47.5, 13.5], 'LBSR': [43.0, 25.0],
    'LYBA': [44.0, 21.0], 'LDZO': [45.5, 16.0], 'LHCC': [47.0, 19.0],
    'EPWW': [52.0, 21.0], 'UUWV': [55.5, 37.5], 'ULLL': [60.0, 30.0],
    'UNNT': [55.0, 73.0], 'UAAA': [43.0, 77.0], 'ZBPE': [40.0, 116.0],
    'RJJJ': [35.5, 139.5], 'RKRR': [37.0, 127.0], 'RCTP': [25.0, 121.0],
    'VTBB': [13.5, 100.5], 'WSSS': [1.3, 104.0], 'VHHK': [22.3, 114.0],
    'OMAE': [24.5, 54.5], 'OEJD': [24.0, 38.5], 'ORBB': [33.0, 44.0],
    'OTBD': [25.3, 51.5], 'OBBB': [26.0, 50.5], 'HECC': [30.0, 31.0],
    'DAAA': [36.5, 3.0], 'DTTC': [33.5, 9.0], 'DNKK': [9.0, 8.0],
    'FAJA': [-26.0, 28.0], 'YMMM': [-25.0, 133.0], 'KZNY': [40.0, -40.0],
    'CZQX': [49.0, -54.0], 'EGGX': [53.0, -15.0], 'KZAK': [30.0, -150.0],
    'UHHH': [48.5, 135.0], 'UEEE': [62.0, 129.0], 'GMMM': [33.5, -7.5],
    'HRRR': [-2.0, 30.0], 'OPKR': [31.5, 74.0], 'VIDF': [28.5, 77.0],
    'LECM': [40.0, -4.0], 'LPPC': [38.5, -9.0], 'EKDK': [56.0, 10.0],
    'ENOR': [60.0, 11.0], 'ESAA': [59.0, 18.0], 'EISN': [53.0, -8.0],
    'BIRD': [65.0, -19.0], 'EFIN': [61.0, 25.0], 'EETT': [59.0, 25.0],
    'EVRR': [57.0, 25.0], 'EYVL': [55.5, 24.0], 'ELLX': [49.5, 6.0],
    'EBUR': [50.5, 4.5], 'EHAA': [52.5, 5.5], 'LZBB': [48.5, 19.0],
    'LRBB': [46.0, 25.0], 'LJLA': [46.0, 14.5], 'UTAA': [37.5, 58.5],
  };

  function isFirBetweenRoute(firCode, depFirCode, arrFirCode) {
    const firCoord = firCoordinates[firCode];
    const depCoord = firCoordinates[depFirCode];
    const arrCoord = firCoordinates[arrFirCode];
    if (!firCoord || !depCoord || !arrCoord) return true; // unknown — include it
    const minLat = Math.min(depCoord[0], arrCoord[0]) - 8;
    const maxLat = Math.max(depCoord[0], arrCoord[0]) + 8;
    const minLon = Math.min(depCoord[1], arrCoord[1]) - 8;
    const maxLon = Math.max(depCoord[1], arrCoord[1]) + 8;
    return firCoord[0] >= minLat && firCoord[0] <= maxLat &&
           firCoord[1] >= minLon && firCoord[1] <= maxLon;
  }

  function isShortDomesticRoute(depCode, arrCode) {
    const dFir = firMap[depCode.slice(0, 2)];
    const aFir = firMap[arrCode.slice(0, 2)];
    if (!dFir || !aFir) return depCode.slice(0, 2) === arrCode.slice(0, 2);
    const dCoord = firCoordinates[dFir];
    const aCoord = firCoordinates[aFir];
    if (!dCoord || !aCoord) return depCode.slice(0, 2) === arrCode.slice(0, 2);
    const dist = Math.sqrt(
      Math.pow(dCoord[0] - aCoord[0], 2) +
      Math.pow(dCoord[1] - aCoord[1], 2)
    );
    return dFir === aFir || dist < 5;
  }

  const firs = new Set();

  // Add dep FIR
  const depPrefix = dep ? dep.slice(0, 2) : '';
  if (dep && firMap[depPrefix]) firs.add(firMap[depPrefix]);

  // Add arr FIR
  const arrPrefix = arr ? arr.slice(0, 2) : '';
  if (arr && firMap[arrPrefix]) firs.add(firMap[arrPrefix]);

  // Short/domestic route - no en-route FIRs needed
  if (dep && arr && isShortDomesticRoute(dep, arr)) {
    console.log('[ENROUTE] Short/domestic route, skipping FIR fetch');
    return '';
  }

  // Try both directions for common route pairs
  const routeKey1 = depPrefix + '-' + arrPrefix;
  const routeKey2 = arrPrefix + '-' + depPrefix;

  const commonRoutes = {
    // Europe ↔ Turkey
    'LT-EG': ['LKAA', 'EDGG', 'EGTT'],
    'LT-ED': ['LKAA', 'LOVV'],
    'LT-LF': ['LKAA', 'LOVV', 'EDGG'],
    'LT-LI': ['LGGG', 'LIIV'],
    'LT-LE': ['LGGG', 'LIIV', 'LECM'],
    'EG-LT': ['EGTT', 'EDGG', 'LKAA'],
    'ED-LT': ['LOVV', 'LKAA'],
    // Turkey ↔ Middle East
    'LT-OE': ['LGGG', 'ORBB', 'OEJD'],
    'LT-OT': ['LGGG', 'ORBB', 'OTBD'],
    'LT-OM': ['LGGG', 'ORBB', 'OMAE'],
    // North America ↔ Europe / Middle East (transatlantic)
    'KJ-EG': ['KZNY', 'CZQX', 'EGGX', 'EGTT'],
    'KJ-ED': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG'],
    'KJ-LF': ['KZNY', 'CZQX', 'EGGX', 'LFFF'],
    'KJ-LT': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LKAA'],
    'KJ-OE': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'KJ-OT': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'KJ-OM': ['KZNY', 'CZQX', 'EGGX', 'EGTT', 'EDGG', 'LGGG', 'ORBB'],
    'EG-KJ': ['EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'LT-KJ': ['LKAA', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'OE-KJ': ['ORBB', 'LGGG', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    'OT-KJ': ['ORBB', 'LGGG', 'EDGG', 'EGTT', 'EGGX', 'CZQX', 'KZNY'],
    // Asia ↔ Russia / Europe (polar/Silk Road)
    'ZB-UL': ['ZWWW', 'UAAA', 'UNNT', 'ULLL'],
    'UL-ZB': ['ULLL', 'UNNT', 'UAAA', 'ZWWW'],
    'ZB-LT': ['ZWWW', 'UAAA', 'UNNT', 'UUWV', 'UKBV', 'LGGG'],
    'LT-ZB': ['LGGG', 'UKBV', 'UUWV', 'UNNT', 'UAAA', 'ZWWW'],
    'ZB-EG': ['ZWWW', 'UAAA', 'UNNT', 'UUWV', 'ULLL', 'EGGX', 'EGTT'],
    'ZB-ED': ['ZWWW', 'UAAA', 'UNNT', 'UUWV', 'ULLL', 'EDGG'],
    'ZS-EG': ['ZBPE', 'ZWWW', 'UAAA', 'UNNT', 'UUWV', 'ULLL', 'EGGX'],
    'RJ-EG': ['RJJJ', 'RCTP', 'ZBPE', 'UAAA', 'UNNT', 'UUWV', 'EGTT'],
    'RK-EG': ['RKRR', 'ZBPE', 'UAAA', 'UNNT', 'UUWV', 'EGTT'],
    // Asia ↔ Middle East
    'ZB-OE': ['ZWWW', 'UTAA', 'ORBB', 'OEJD'],
    'ZB-OM': ['ZWWW', 'UTAA', 'ORBB', 'OMAE'],
    'RJ-OE': ['RJJJ', 'ZBPE', 'ZWWW', 'UTAA', 'ORBB'],
    'OE-ZB': ['ORBB', 'UTAA', 'ZWWW', 'ZBPE'],
    'OT-ZB': ['OTBD', 'ORBB', 'UTAA', 'ZWWW'],
    // Asia ↔ South Asia
    'ZB-VI': ['ZWWW', 'VIDF'],
    'RJ-VI': ['RJJJ', 'ZBPE', 'VIDF'],
    // Australia ↔ Asia / Europe
    'YB-ZB': ['YMMM', 'RJJJ', 'RCTP', 'ZBPE'],
    'YB-EG': ['YMMM', 'RJJJ', 'ZBPE', 'UAAA', 'EGTT'],
    // Africa routes
    'FA-EG': ['FAJA', 'HTTC', 'HECC', 'LGGG'],
    'DN-LT': ['DNKK', 'DAAA', 'DTTC', 'LGGG'],
    // Polar routes
    'KJ-RJ': ['CZQX', 'EGGX', 'ULLL', 'UNNT', 'UHHH', 'RJJJ'],
    'KJ-ZB': ['CZQX', 'UHHH', 'UNNT', 'ZBPE'],
  };
  const intermediates = commonRoutes[routeKey1] || commonRoutes[routeKey2] || [];
  intermediates.forEach(fir => firs.add(fir));

  // If no route match found, only use dep and arr FIRs - no guessing
  if (intermediates.length === 0) {
    console.log('[ENROUTE] No route match found, using dep/arr FIRs only');
  }

  // Fetch NOTAMs for up to 4 FIRs (skip raw airport codes, filter to route corridor)
  const depFir = firMap[depPrefix] || dep;
  const arrFir = firMap[arrPrefix] || arr;
  const firList = [...firs]
    .filter(f => f !== dep && f !== arr)
    .filter(f => isFirBetweenRoute(f, depFir, arrFir))
    .slice(0, 4);
  const results = [];

  for (const fir of firList) {
    await new Promise(r => setTimeout(r, 500));

    // Oceanic FIRs: SkyLink may not cover them — use informational fallback
    if (OCEANIC_FIRS.has(fir)) {
      try {
        const data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + fir, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        if (!data || !data.notams || data.notams.length === 0) {
          results.push(`FIR ${fir}: Oceanic FIR — check official NOTAM sources (KZNY/CZQX/EGGX) for current NAT track system and oceanic restrictions`);
          continue;
        }
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
          return expDate > now;
        });
        const critical = active.filter(n => /RWY.*CLSD|CLSD.*RWY|U\/S|UNSERVICEABLE|JAMM|EMERG|PROHIBITED|TRIGGER/i.test(n.raw || n.body || ''));
        const high = active.filter(n => /TWY.*CLSD|ILS|VOR|NDB|GNSS|GPS|MILITARY|TFR|RESTRICTED|DANGER/i.test(n.raw || n.body || ''));
        const other = active.filter(n => !critical.includes(n) && !high.includes(n));
        const sorted = [...critical, ...high, ...other];
        const summary = sorted.slice(0, 3).map(n => (n.raw || n.body || '').slice(0, 150)).join('\n');
        results.push(`FIR ${fir}: ${active.length} active NOTAMs\n${summary || 'No active restrictions'}`);
      } catch(e) {
        results.push(`FIR ${fir}: Oceanic FIR — verify current NAT tracks and oceanic NOTAM status via official sources`);
      }
      continue;
    }

    // Standard FIR fetch
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + fir, {
        method: 'GET',
        headers: {
          'x-rapidapi-key': process.env.SKYLINK_KEY,
          'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
        }
      });
      if (data && data.notams && data.notams.length > 0) {
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
          return expDate > now;
        });
        if (active.length > 0) {
          const critical = active.filter(n => /RWY.*CLSD|CLSD.*RWY|U\/S|UNSERVICEABLE|JAMM|EMERG|PROHIBITED|TRIGGER/i.test(n.raw || n.body || ''));
          const high = active.filter(n => /TWY.*CLSD|ILS|VOR|NDB|GNSS|GPS|MILITARY|TFR|RESTRICTED|DANGER/i.test(n.raw || n.body || ''));
          const other = active.filter(n => !critical.includes(n) && !high.includes(n));
          const sorted = [...critical, ...high, ...other];
          const summary = sorted.slice(0, 3).map(n => (n.raw || n.body || '').slice(0, 150)).join('\n');
          results.push(`FIR ${fir}: ${active.length} active NOTAMs\n${summary}`);
        } else {
          results.push(`FIR ${fir}: No active NOTAMs`);
        }
      } else {
        results.push(`FIR ${fir}: No active NOTAMs`);
      }
    } catch(e) {
      results.push(`FIR ${fir}: Data unavailable`);
    }
  }

  return results.join('\n\n');
}

async function fetchMetar(icao) {
  if (!icao) return '';
  try {
    const data = await fetchURL(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`);
    if (!data || !data[0]) return '';
    return data[0].rawOb || '';
  } catch { return ''; }
}

async function fetchTaf(icao) {
  if (!icao) return '';
  try {
    const data = await fetchURL(`https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`);
    if (!data || !data[0]) return '';
    return data[0].rawTAF || '';
  } catch { return ''; }
}

function streamClaude(requestBody, onChunk, onDone, onError) {
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  }, (claudeRes) => {
    let buf = '';
    claudeRes.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'message_start' && evt.message?.usage) {
            const u = evt.message.usage;
            console.log('[CACHE /briefing]', {
              input: u.input_tokens,
              output: u.output_tokens,
              cache_created: u.cache_creation_input_tokens || 0,
              cache_read: u.cache_read_input_tokens || 0
            });
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            onChunk(evt.delta.text);
          } else if (evt.type === 'message_stop') {
            onDone();
          }
        } catch (_) {}
      }
    });
    claudeRes.on('end', onDone);
    claudeRes.on('error', onError);
  });
  req.on('error', onError);
  req.write(requestBody);
  req.end();
}

const HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pre-Flight Operational Intelligence Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Rajdhani:wght@400;500;600;700&family=Orbitron:wght@400;700;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#060a0f;--bg2:#0b1118;--bg3:#101820;--panel:#0d1520;
    --border:#1a2a3a;--border2:#22384f;
    --red:#e63946;--red-dim:#7a1a20;--orange:#f4841a;--orange-dim:#7a3a08;
    --yellow:#f2c641;--yellow-dim:#7a5e10;--green:#2ec4b6;--green-dim:#0e5a54;
    --blue:#4a9eff;--blue-dim:#143060;--purple:#b57bff;
    --text:#cdd9e5;--text2:#8a9bb0;--text3:#4a5f72;
    --mono:'Share Tech Mono',monospace;--head:'Orbitron',sans-serif;--body:'Rajdhani',sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--body);font-size:15px;line-height:1.55;min-height:100vh}
  body::before{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.06) 2px,rgba(0,0,0,0.06) 4px);pointer-events:none;z-index:9999}
  .page{max-width:900px;margin:0 auto;padding:28px 24px 60px}
  .master-header{border:1px solid var(--border2);border-top:3px solid var(--red);background:var(--panel);padding:24px 28px 20px;margin-bottom:20px;position:relative;overflow:hidden}
  .master-header::after{content:'';position:absolute;top:0;right:0;width:200px;height:100%;background:linear-gradient(135deg,transparent 60%,rgba(230,57,70,0.04))}
  .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .route-id{font-family:var(--head);font-size:28px;font-weight:900;letter-spacing:4px;color:#fff;text-shadow:0 0 24px rgba(74,158,255,0.3)}
  .route-sub{font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:2px;margin-top:4px}
  .risk-badge{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
  .risk-label{font-family:var(--head);font-size:22px;font-weight:900;color:var(--red);letter-spacing:3px;text-shadow:0 0 16px rgba(230,57,70,0.5);animation:pulse-red 2s ease-in-out infinite}
  @keyframes pulse-red{0%,100%{text-shadow:0 0 16px rgba(230,57,70,0.5)}50%{text-shadow:0 0 28px rgba(230,57,70,0.9)}}
  .risk-score{font-family:var(--mono);font-size:13px;color:var(--orange);letter-spacing:2px}
  .score-bar{display:flex;gap:3px;margin-top:2px}
  .score-pip{width:16px;height:6px;border-radius:2px;background:var(--border2);transition:background 0.3s}
  .score-pip.active{background:var(--red);box-shadow:0 0 6px var(--red)}
  .score-pip.active.med{background:var(--orange);box-shadow:0 0 6px var(--orange)}
  .header-meta{display:flex;gap:24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);flex-wrap:wrap}
  .meta-item{font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:1px}
  .meta-item span{color:var(--blue)}
  .exec-summary{background:var(--panel);border:1px solid var(--border2);border-left:4px solid var(--orange);padding:18px 22px;margin-bottom:20px}
  .exec-summary p{color:var(--text);font-size:15px;line-height:1.7;font-weight:500}
  .exec-summary p+p{margin-top:10px}
  .section-header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--bg3);border:1px solid var(--border2);border-left:3px solid var(--blue);margin-bottom:12px;margin-top:28px}
  .section-header .icon{font-size:16px}
  .section-header .title{font-family:var(--head);font-size:12px;font-weight:700;letter-spacing:3px;color:var(--blue);text-transform:uppercase}
  .notam-list{display:flex;flex-direction:column;gap:10px}
  .notam-card{background:var(--panel);border:1px solid var(--border);border-left:4px solid transparent;padding:16px 18px;position:relative;transition:border-color 0.2s}
  .notam-card:hover{border-color:var(--border2)}
  .notam-card.crit{border-left-color:var(--red)}
  .notam-card.high{border-left-color:var(--orange)}
  .notam-card.med{border-left-color:var(--yellow)}
  .notam-card.low{border-left-color:var(--green)}
  .notam-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:12px}
  .notam-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;margin-top:4px}
  .crit .notam-dot{background:var(--red);box-shadow:0 0 8px var(--red)}
  .high .notam-dot{background:var(--orange);box-shadow:0 0 8px var(--orange)}
  .med .notam-dot{background:var(--yellow);box-shadow:0 0 8px var(--yellow)}
  .low .notam-dot{background:var(--green);box-shadow:0 0 8px var(--green)}
  .notam-id{font-family:var(--mono);font-size:12px;color:var(--text3);letter-spacing:1px;margin-bottom:2px}
  .notam-title{font-family:var(--body);font-size:16px;font-weight:700;color:#fff;letter-spacing:0.5px}
  .notam-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:10px}
  .notam-field-label{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px}
  .notam-field-value{font-size:13px;color:var(--text);font-weight:500}
  .notam-action{background:rgba(0,0,0,0.3);border:1px solid var(--border);padding:10px 14px;margin-top:10px;font-size:13px;color:var(--text2);font-weight:600}
  .notam-action .action-label{font-family:var(--mono);font-size:10px;color:var(--yellow);letter-spacing:2px;display:block;margin-bottom:4px}
  .warning-banner{display:flex;gap:10px;background:rgba(230,57,70,0.08);border:1px solid var(--red-dim);padding:10px 14px;margin-top:10px;font-size:13px;color:#ff8a8a;font-weight:600}
  .warning-banner::before{content:'🔴';font-size:12px;margin-top:1px}
  .dual-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
  @media(max-width:620px){.dual-col{grid-template-columns:1fr}}
  .status-panel{background:var(--panel);border:1px solid var(--border);padding:16px 18px}
  .status-panel.dep{border-top:2px solid var(--yellow)}
  .status-panel.arr{border-top:2px solid var(--red)}
  .status-airport{font-family:var(--head);font-size:18px;font-weight:900;letter-spacing:3px;color:#fff;margin-bottom:4px}
  .status-sub{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px;margin-bottom:12px}
  .status-row{display:flex;justify-content:space-between;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;gap:10px}
  .status-row:last-child{border-bottom:none}
  .status-key{color:var(--text3);font-size:12px;font-weight:600;white-space:nowrap}
  .status-val{color:var(--text);font-weight:600;text-align:right}
  .status-val.ok{color:var(--green)}
  .status-val.warn{color:var(--yellow)}
  .status-val.bad{color:var(--red)}
  .navaid-grid{background:var(--panel);border:1px solid var(--border);overflow:hidden}
  .navaid-row{display:grid;grid-template-columns:2fr 2fr 1fr 3fr;padding:10px 18px;border-bottom:1px solid var(--border);font-size:13px;align-items:center;gap:12px}
  .navaid-row.header{background:var(--bg3);font-family:var(--mono);font-size:10px;letter-spacing:1.5px;color:var(--text3);padding:8px 18px}
  .navaid-row:last-child{border-bottom:none}
  .navaid-name{font-weight:700;color:#fff}
  .navaid-loc{color:var(--text2)}
  .navaid-status{font-family:var(--mono);font-size:13px}
  .ok{color:var(--green)}.ux{color:var(--red)}.deg{color:var(--yellow)}
  .navaid-note{color:var(--text2);font-size:12px}
  .wx-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
  @media(max-width:700px){.wx-grid{grid-template-columns:1fr}}
  .wx-card{background:var(--panel);border:1px solid var(--border);padding:14px 16px}
  .wx-icao{font-family:var(--head);font-size:16px;font-weight:900;letter-spacing:3px;color:#fff;margin-bottom:2px}
  .wx-role{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px;margin-bottom:10px}
  .wx-raw{font-family:var(--mono);font-size:11px;color:var(--text2);word-break:break-all;line-height:1.6;background:rgba(0,0,0,0.25);padding:8px;border:1px solid var(--border);margin-bottom:8px}
  .wx-tag{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:1px;padding:2px 7px;border-radius:2px;margin-right:4px;margin-bottom:4px}
  .wx-tag.warn{background:rgba(244,132,26,0.15);color:var(--orange);border:1px solid var(--orange-dim)}
  .wx-tag.crit{background:rgba(230,57,70,0.15);color:var(--red);border:1px solid var(--red-dim)}
  .wx-tag.ok{background:rgba(46,196,182,0.1);color:var(--green);border:1px solid var(--green-dim)}
  .wx-analysis{background:var(--panel);border:1px solid var(--border);border-left:4px solid var(--red);padding:14px 18px;font-size:14px;color:var(--text);line-height:1.7;font-weight:500}
  .wx-analysis p+p{margin-top:8px}
  .compound-box{background:rgba(230,57,70,0.06);border:1px solid var(--red-dim);padding:16px 20px;margin-bottom:12px}
  .compound-title{font-family:var(--head);font-size:11px;font-weight:700;color:var(--red);letter-spacing:3px;margin-bottom:10px}
  .compound-item{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(230,57,70,0.15);font-size:13px;color:#ff8a8a;font-weight:600;line-height:1.5}
  .compound-item:last-child{border-bottom:none}
  .compound-item::before{content:'⚡';flex-shrink:0}
  .airspace-grid{background:var(--panel);border:1px solid var(--border);overflow:hidden}
  .airspace-row{display:grid;grid-template-columns:90px 1fr 120px 120px;padding:10px 18px;border-bottom:1px solid var(--border);font-size:13px;align-items:center;gap:12px}
  .airspace-row.header{background:var(--bg3);font-family:var(--mono);font-size:10px;letter-spacing:1.5px;color:var(--text3);padding:8px 18px}
  .airspace-row:last-child{border-bottom:none}
  .ar-id{font-family:var(--mono);font-size:11px;color:var(--blue)}
  .ar-desc{color:var(--text);font-weight:600}
  .ar-fl{font-family:var(--mono);font-size:12px;color:var(--yellow)}
  .ar-time{font-family:var(--mono);font-size:11px;color:var(--text2)}
  .action-list{display:flex;flex-direction:column;gap:8px}
  .action-item{display:flex;gap:14px;background:var(--panel);border:1px solid var(--border);padding:14px 16px;align-items:flex-start}
  .action-num{font-family:var(--head);font-size:16px;font-weight:900;color:var(--blue);min-width:28px;line-height:1.2}
  .action-text{font-size:14px;font-weight:600;color:var(--text);line-height:1.5}
  .action-text em{font-style:normal;color:var(--yellow);font-weight:700}
  .dispatch-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
  @media(max-width:620px){.dispatch-grid{grid-template-columns:1fr}}
  .dispatch-card{background:var(--panel);border:1px solid var(--border);padding:14px 18px;display:flex;flex-direction:column;gap:6px}
  .dispatch-icon{font-size:20px}
  .dispatch-label{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:2px}
  .dispatch-value{font-size:14px;font-weight:600;color:var(--text);line-height:1.5}
  .dispatch-value .hl{color:var(--orange);font-weight:700}
  .gng-box{background:rgba(244,132,26,0.07);border:1px solid var(--orange-dim);border-top:3px solid var(--orange);padding:24px 28px;margin-top:28px}
  .gng-verdict{font-family:var(--head);font-size:24px;font-weight:900;letter-spacing:4px;color:var(--orange);margin-bottom:14px;text-shadow:0 0 20px rgba(244,132,26,0.4)}
  .gng-conditions{display:flex;flex-direction:column;gap:6px;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}
  .gng-cond{display:flex;gap:10px;font-size:14px;font-weight:600;color:var(--text);align-items:flex-start;line-height:1.5}
  .gng-cond::before{content:'✓';color:var(--green);font-size:14px;flex-shrink:0;margin-top:1px}
  .gng-nogo-cond{display:flex;gap:10px;font-size:14px;font-weight:700;color:var(--red);align-items:flex-start;margin-top:10px;padding:12px 14px;background:rgba(230,57,70,0.08);border:1px solid var(--red-dim)}
  .gng-nogo-cond::before{content:'✕';flex-shrink:0}
  .briefing-footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
  .footer-sig{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:1px}
  .footer-disclaimer{font-family:var(--mono);font-size:10px;color:var(--text3);letter-spacing:0.5px;text-align:right;max-width:360px}
  @media(max-width:560px){.notam-grid{grid-template-columns:1fr}.airspace-row{grid-template-columns:1fr 1fr}.airspace-row .ar-time{display:none}}
</style>
</head>
<body>
<div class="page">`;

const HTML_FOOT = `</div></body></html>`;

const systemPrompt = `MANDATORY RULES:
- Show ALL NOTAMs provided in the data - never skip or summarize any NOTAM
- Each NOTAM card must have correct risk color class: crit (red) for runway closures/GNSS/safety critical, high (orange) for navigation aids/UAS/obstacles, med (yellow) for taxiway/procedures, low (green) for administrative
- Show the airport ICAO code for each NOTAM in the notam-id field
- CRITICAL NOTAMs include: runway closures, GNSS jamming, dual runway closures, emergency-only airports
- Never downgrade GNSS jamming or runway closures to medium or low risk

You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM.

Analyze the provided aviation data and produce a complete pre-flight operational intelligence briefing.

If an image or PDF is provided, analyze it as aviation documentation (NOTAM, chart, weather report, or operational document) and include findings in the briefing.

CRITICAL INSTRUCTIONS:
1. Output ONLY the HTML body content — everything that goes INSIDE <div class="page">...</div>
2. Do NOT include <!DOCTYPE>, <html>, <head>, <style>, <body> or outer <div class="page"> tags
3. Start directly with <div class="master-header"> and end with </div> for briefing-footer
4. Use EXACTLY these CSS classes — they are already loaded
5. NEVER write "Content Under Review", "Under Review", or any placeholder text. Always use the actual NOTAM data provided.
6. AIRPORT NAMES — use correct official names:
   - LTFM = Istanbul Airport (opened 2019, main Istanbul hub)
   - LTAI = Antalya Airport
   - LTBA = Istanbul Atatürk Airport (CLOSED to commercial ops since April 2019)
   - LTAC = Ankara Esenboğa Airport
   - LTBJ = İzmir Adnan Menderes Airport
   - EGLL = London Heathrow | EGKK = London Gatwick | EHAM = Amsterdam Schiphol
   - EDDF = Frankfurt | LFPG = Paris Charles de Gaulle | LEMD = Madrid Barajas
   - LIRF = Rome Fiumicino | LSZH = Zurich | LOWW = Vienna | EKCH = Copenhagen
   - For any other ICAO code not listed above, derive the name from standard ICAO knowledge.

REQUIRED SECTIONS IN ORDER:

1. MASTER HEADER:
<div class="master-header">
  <div class="header-top">
    <div>
      <div class="route-id">[DEP] → [ARR]</div>
      <div class="route-sub">[DEP FULL NAME] → [ARR FULL NAME] | PRE-FLIGHT OPERATIONAL INTELLIGENCE BRIEFING</div>
    </div>
    <div class="risk-badge">
      <div class="risk-label">[🔴/🟠/🟡/🟢] [CRITICAL/HIGH/MEDIUM/LOW]</div>
      <div class="risk-score">📊 RISK SCORE [X] / 10</div>
      <div class="score-bar">
        [10 score-pip divs — add class="active" for filled pips, class="active med" for orange pips]
      </div>
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[CURRENT UTC DATE]</span></div>
    <div class="meta-item">VALIDITY <span>[VALIDITY PERIOD]</span></div>
    <div class="meta-item">ROUTE <span>[DEP] → [FIR route] → [ARR]</span></div>
    <div class="meta-item">AIRAC <span>CURRENT CYCLE ACTIVE</span></div>
    <div class="meta-item">PREPARED <span>AIM SPECIALIST / OPS</span></div>
  </div>
</div>

2. EXECUTIVE SUMMARY:
<div class="exec-summary">
  <p>✈️ <strong>EXECUTIVE SUMMARY —</strong> [3-4 detailed sentences covering all major risks]</p>
  <p>[Second paragraph with operational classification GO/NO-GO/GO WITH CONDITIONS]</p>
</div>

3. COMPOUNDING RISK MATRIX (always include if multiple NOTAMs):
<div class="compound-box">
  <div class="compound-title">🔴 COMPOUNDING RISK MATRIX — SIMULTANEOUS ACTIVE HAZARDS</div>
  <div class="compound-item">[Specific risk combination with details]</div>
  [more compound-item divs as needed]
</div>

4. NOTAM ANALYSIS:
<div class="section-header"><span class="icon">📋</span><span class="title">NOTAM Analysis — Priority Order</span></div>
<div class="notam-list">
  [For EACH NOTAM in the provided data use this EXACT structure — process every NOTAM, never skip or summarise:]
  <div class="notam-card [crit|high|med|low]">
    <div class="notam-head">
      <div class="notam-dot"></div>
      <div>
        <div class="notam-id">[🔴/🟠/🟡/🟢] [EXACT NOTAM ID from data] | TYPE: [TYPE]</div>
        <div class="notam-title">[Descriptive title derived from the NOTAM text]</div>
      </div>
    </div>
    <div class="notam-grid">
      <div class="notam-field"><div class="notam-field-label">📍 Location</div><div class="notam-field-value">[exact location from NOTAM]</div></div>
      <div class="notam-field"><div class="notam-field-label">⏰ Time Window UTC</div><div class="notam-field-value">[exact B/C times from NOTAM]</div></div>
      <div class="notam-field"><div class="notam-field-label">✈️ Affected Operations</div><div class="notam-field-value">[what operations are affected]</div></div>
      <div class="notam-field"><div class="notam-field-label">📐 Operational Impact</div><div class="notam-field-value">[specific impact on the flight]</div></div>
    </div>
    <div class="notam-field" style="margin:10px 0 6px"><div class="notam-field-label">📄 RAW NOTAM TEXT</div><div class="notam-field-value" style="font-family:monospace;font-size:12px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-all">[verbatim raw NOTAM text exactly as received from the data]</div></div>
    <div class="notam-field" style="margin:0 0 10px"><div class="notam-field-label">💬 DECODED PLAIN ENGLISH</div><div class="notam-field-value">[clear plain-English explanation of what this NOTAM means for crew — no jargon, full sentences]</div></div>
    <div class="notam-action"><span class="action-label">⚠️ REQUIRED CREW ACTION</span>[specific action the crew must take because of this NOTAM]</div>
    [Optional: <div class="warning-banner">COMPOUNDS WITH: [detail]</div>]
  </div>
</div>

5. AIRSPACE AND RESTRICTIONS:
<div class="section-header"><span class="icon">🚫</span><span class="title">Airspace and Restrictions</span></div>
<div class="airspace-grid">
  <div class="airspace-row header"><span>NOTAM / REF</span><span>DESCRIPTION</span><span>VERTICAL LIMITS</span><span>ACTIVE (UTC)</span></div>
  [airspace-row divs with ar-id, ar-desc, ar-fl, ar-time spans]
</div>

6. AERODROME STATUS:
<div class="section-header"><span class="icon">🛬</span><span class="title">Aerodrome Status</span></div>
<div class="dual-col">
  <div class="status-panel dep">
    <div class="status-airport">[DEP]</div>
    <div class="status-sub">[DEP CORRECT FULL NAME] — DEPARTURE</div>
    [status-row divs with status-key and status-val (ok/warn/bad) spans]
  </div>
  <div class="status-panel arr">
    <div class="status-airport">[ARR]</div>
    <div class="status-sub">[ARR CORRECT FULL NAME] — ARRIVAL</div>
    [status-row divs]
  </div>
</div>

7. NAVIGATION AIDS:
<div class="section-header"><span class="icon">📡</span><span class="title">Navigation Aids Status</span></div>
<div class="navaid-grid">
  <div class="navaid-row header"><span>NAVAID / TYPE</span><span>LOCATION</span><span>STATUS</span><span>NOTES</span></div>
  [navaid-row divs with navaid-name, navaid-loc, navaid-status (ok/ux/deg), navaid-note spans]
</div>

8. WEATHER ASSESSMENT:
<div class="section-header"><span class="icon">🌤️</span><span class="title">Weather Assessment</span></div>
<div class="wx-grid">
  <div class="wx-card"><div class="wx-icao">[DEP]</div><div class="wx-role">DEPARTURE</div><div class="wx-raw">[METAR]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ARR]</div><div class="wx-role">ARRIVAL — PRIMARY</div><div class="wx-raw">[METAR]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ALTERNATE]</div><div class="wx-role">ALTERNATE</div><div class="wx-raw">[METAR or N/A]</div>[wx-tags]</div>
</div>
<div class="wx-analysis"><p>[Dep weather analysis]</p><p>[Arr weather analysis with concerns]</p><p>[Alternate and additional info]</p></div>

9. PILOT ACTION ITEMS:
<div class="section-header"><span class="icon">✅</span><span class="title">Pilot Action Items</span></div>
<div class="action-list">
  [8-10 action-item divs each with action-num (01-10) and action-text with em tags for key terms]
</div>

10. DISPATCH NOTES:
<div class="section-header"><span class="icon">📦</span><span class="title">Dispatch Notes</span></div>
<div class="dispatch-grid">
  <div class="dispatch-card"><span class="dispatch-icon">⛽</span><div class="dispatch-label">FUEL PLANNING</div><div class="dispatch-value">[fuel details with hl spans]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">🛫</span><div class="dispatch-label">ALTERNATE AERODROME</div><div class="dispatch-value">[alternate details]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">🕐</span><div class="dispatch-label">SLOT / CTOT</div><div class="dispatch-value">[slot details]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">📻</span><div class="dispatch-label">ATC COORDINATION</div><div class="dispatch-value">[ATC details with hl spans]</div></div>
</div>

11. GO/NO-GO:
<div class="gng-box">
  <div class="gng-verdict">🎯 [GO ✅ / NO-GO ❌ / GO WITH CONDITIONS ⚠️]</div>
  <p style="font-size:14px;font-weight:600;color:var(--text);line-height:1.6;">[Main reasoning]</p>
  <div class="gng-conditions">
    [gng-cond divs for each condition]
  </div>
  [Optional: <div class="gng-nogo-cond">NO-GO IF: [condition]</div>]
</div>

12. FOOTER:
<div class="briefing-footer">
  <div class="footer-sig">AIM SPECIALIST — SENIOR OPERATIONAL BRIEFING<br>ROUTE: [DEP]–[ARR] | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">FLIGHT SAFETY IS THE OVERRIDING PRIORITY. THIS BRIEFING IS PREPARED IN ACCORDANCE WITH ICAO ANNEX 15, PANS-AIM DOC 10066, PANS-OPS DOC 8168, AND DOC 4444 PANS-ATM. ALWAYS CROSS-CHECK WITH CURRENT OPERATIONAL SOURCES BEFORE FLIGHT.</div>
</div>

MANDATORY: Analyze and include en-route NOTAMs for ALL FIRs along the route. For each FIR on the route (e.g. LTBB, LKAA, EGTT, EDGG etc.), check for:
- Airspace closures or restrictions
- Military exercise areas (MATZ, danger areas, restricted areas)
- Temporary Flight Restrictions (TFRs)
- Active SIGMETs along route
- FIR crossing procedures or special requirements
Include a dedicated AIRSPACE section in the briefing that specifically covers en-route hazards separate from aerodrome NOTAMs. If no en-route NOTAMs exist for a FIR, explicitly state 'No active en-route restrictions for [FIR]'.

EN-ROUTE FIR ANALYSIS: For each intermediate FIR along the route, create a dedicated subsection in the AIRSPACE section. List specific NOTAM numbers, types, and operational impact. If military exercise areas, TFRs, or airspace restrictions exist, classify them as HIGH or CRITICAL risk as appropriate. Never say 'limited information available' - either provide the data or explicitly state 'No active NOTAMs for [FIR]'.

CRITICAL REQUIREMENT: You MUST fetch and analyze NOTAMs for ALL intermediate FIRs between departure and arrival. Never say a FIR's data is 'not available in this briefing' - if en-route FIR NOTAMs are provided in the EN-ROUTE FIR NOTAMs section, analyze them ALL. If a FIR shows 'No active NOTAMs', explicitly state this as confirmation of clear airspace.

NEVER say 'sınırlı bilgi', 'limited information', 'bu briefingde yer almıyor' or similar. If FIR NOTAM data is provided, analyze it fully. If truly no data exists for a FIR, say 'No active NOTAMs confirmed for [FIR]' as a positive confirmation.

For transatlantic routes, always mention NAT (North Atlantic Track) system status and oceanic clearance requirements. For routes over conflict zones (Middle East, Eastern Europe), specifically check for active airspace closures and NOTAM to Airmen.

Use real data from provided NOTAMs and weather. Be detailed and operationally specific. Cover all NOTAM types including SNOWTAM, BIRDTAM, ASHTAM, Military, Navigation, Airspace, Aerodrome NOTAMs.

IMPORTANT: Be concise. Limit each NOTAM card to essential information only. Ensure ALL sections are completed including Go/No-Go and Footer.

IMPORTANT: Never use markdown backticks or code blocks. For RAW NOTAM TEXT field, output the exact NOTAM text inside a pre HTML tag with inline styles. Example:
<pre style='font-family:monospace;white-space:pre-wrap;font-size:11px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid #1a2a3a;line-height:1.6;color:#8a9bb0;margin:8px 0;'>NOTAM TEXT</pre>
The ! prefix and date format (YYMMDDHHmm) are standard ICAO format - keep them exactly as received.

NOTAM LIMITS: Show maximum 8 NOTAMs per airport, prioritizing CRITICAL and HIGH severity first. Order NOTAMs by most recently issued first (highest NOTAM number first). For en-route FIRs, show maximum 2 NOTAMs per FIR with brief summaries only — do not include raw NOTAM text blocks for en-route FIRs.`;

const server = http.createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  if (req.method === 'GET' && urlPath === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/about' || urlPath === '/about.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'about.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/pricing' || urlPath === '/pricing.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'pricing.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (urlPath === '/pricing-upgrade' || urlPath === '/pricing-upgrade.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'pricing-upgrade.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/privacy' || req.url === '/privacy.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/terms' || req.url === '/terms.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin/')) {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/api/admin/users') {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.replace('Bearer ', '');
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      if (decoded.email !== 'arslanni@gmail.com') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
      const usersSnap = await adminDb.collection('users').get();
      const users = await Promise.all(usersSnap.docs.map(async doc => {
        const data = doc.data();
        let email = '—';
        try {
          const authUser = await admin.auth().getUser(doc.id);
          email = authUser.email || '—';
        } catch(e) {}
        return {
          uid: doc.id,
          email,
          plan: data.plan || 'free',
          displayName: data.displayName || '—',
          updatedAt: data.updatedAt?.toDate?.()?.toLocaleDateString('en-GB') || '—'
        };
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(users));
    } catch(e) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/b/')) {
    const briefingId = req.url.split('/b/')[1].split('?')[0];
    const shareHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NOTAM Intelligence Briefing</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #060a0f; color: #cdd9e5; font-family: 'Rajdhani', sans-serif; min-height: 100vh; }
#loadingScreen { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; }
#loadingText { font-family: 'Share Tech Mono', monospace; font-size: 14px; letter-spacing: 3px; color: #4a9eff; }
#briefingContent { max-width: 900px; margin: 40px auto; padding: 0 24px 80px; }
@keyframes blinkDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
</style>
</head>
<body>
<div id="loadingScreen">
  <div id="loadingText">LOADING BRIEFING...</div>
</div>
<div id="briefingContent" style="display:none;">
  <div style="position:sticky;top:0;z-index:100;background:rgba(6,10,15,0.95);border-bottom:1px solid #1a2a3a;padding:0 24px;height:48px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(8px);">
    <div style="display:flex;align-items:center;gap:12px;">
      <a href="https://notamai.onrender.com" style="text-decoration:none;display:flex;align-items:center;gap:4px;">
        <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#ffffff;">NOTAM</span>
        <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#4a9eff;">INTELLIGENCE</span>
      </a>
      <span style="color:#1a2a3a;">|</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#2ec4b6;display:inline-block;animation:blinkDot 1.5s ease-in-out infinite;flex-shrink:0;"></span>
        <span style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;">SHARED BRIEFING</span>
      </div>
    </div>
    <a id="getAccessBtn" href="https://notamai.onrender.com/?signup=true" style="display:flex;align-items:center;gap:6px;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);color:#ffffff;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;padding:6px 14px;border-radius:6px;cursor:pointer;text-decoration:none;">
      <span style="font-size:12px;">✨</span>
      GET FULL ACCESS
    </a>
  </div>
  <div id="getAccessTooltip" style="display:none;position:fixed;background:#1a1a1a;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:400;padding:6px 10px;border-radius:4px;border:1px solid #333;box-shadow:0 2px 6px rgba(0,0,0,0.3);white-space:normal;line-height:1.5;pointer-events:none;z-index:9999;max-width:280px;">Create a free account to generate your own AI-powered pre-flight briefings</div>
  <div id="briefingBody" style="padding-top:32px;"></div>
</div>
<script>
const firebaseConfig = {
  apiKey: "AIzaSyCH8bj9-775vmXU1HnqRFjf09g1yUXvnpo",
  authDomain: "notamai-a9d57.firebaseapp.com",
  projectId: "notamai-a9d57",
  storageBucket: "notamai-a9d57.firebasestorage.app",
  messagingSenderId: "793570221190",
  appId: "1:793570221190:web:aab696c96dbde26d9f4507"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
db.collection('briefings').doc('${briefingId}').get().then(doc => {
  if (doc.exists) {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('briefingContent').style.display = 'block';
    document.getElementById('briefingBody').innerHTML = doc.data().html;
    const route = doc.data().route || 'NOTAM Briefing';
    document.title = 'NOTAM Intelligence — ' + route;
  } else {
    document.getElementById('loadingText').textContent = 'BRIEFING NOT FOUND';
  }
}).catch(() => {
  document.getElementById('loadingText').textContent = 'ERROR LOADING BRIEFING';
});
const getAccessBtn = document.getElementById('getAccessBtn');
const getAccessTooltip = document.getElementById('getAccessTooltip');
if (getAccessBtn) {
  getAccessBtn.addEventListener('mouseenter', function() {
    getAccessTooltip.style.display = 'block';
    const rect = this.getBoundingClientRect();
    getAccessTooltip.style.left = (rect.left + rect.width / 2 - 140) + 'px';
    getAccessTooltip.style.top = (rect.bottom + 8) + 'px';
  });
  getAccessBtn.addEventListener('mouseleave', function() {
    getAccessTooltip.style.display = 'none';
  });
}
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(shareHtml);
    return;
  }

  // ── HEYGEN TEST ──────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/test-heygen') {
    try {
      // Step 1: Upload image as asset using v3 API
      const imageData = fs.readFileSync(PILOT_IMAGE_PATH);
      console.log('[IMAGE SIZE]', imageData.length, 'bytes');
      const boundary = '----FormBoundary' + Date.now();
      const formData = Buffer.concat([
        Buffer.from('--' + boundary + '\r\n'),
        Buffer.from('Content-Disposition: form-data; name="file"; filename="pilot.jpeg"\r\n'),
        Buffer.from('Content-Type: image/jpeg\r\n\r\n'),
        imageData,
        Buffer.from('\r\n--' + boundary + '--\r\n')
      ]);
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadReq = https.request({
          hostname: 'api.heygen.com',
          path: '/v3/assets',
          method: 'POST',
          headers: {
            'x-api-key': process.env.HEYGEN_API_KEY,
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
            'Content-Length': formData.length
          }
        }, uploadRes => {
          let data = '';
          uploadRes.on('data', chunk => data += chunk);
          uploadRes.on('end', () => {
            console.log('[HEYGEN UPLOAD RAW]', data.slice(0, 300));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        uploadReq.on('error', reject);
        uploadReq.write(formData);
        uploadReq.end();
      });
      const assetId = uploadResult.data?.asset_id;
      const assetUrl = uploadResult.data?.url;
      console.log('[ASSET ID]', assetId);
      if (assetId) {
        // Step 2: Create photo avatar using v3
        const avatarPayload = JSON.stringify({
          type: 'photo',
          name: 'Pilot Avatar',
          file: {
            type: 'asset_id',
            asset_id: assetId
          }
        });
        const avatarResult = await new Promise((resolve, reject) => {
          const avatarReq = https.request({
            hostname: 'api.heygen.com',
            path: '/v3/avatars',
            method: 'POST',
            headers: {
              'x-api-key': process.env.HEYGEN_API_KEY,
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(avatarPayload)
            }
          }, avatarRes => {
            let data = '';
            avatarRes.on('data', chunk => data += chunk);
            avatarRes.on('end', () => {
              console.log('[AVATAR RAW]', data.slice(0, 300));
              try { resolve(JSON.parse(data)); }
              catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
            });
          });
          avatarReq.on('error', reject);
          avatarReq.write(avatarPayload);
          avatarReq.end();
        });
        console.log('[AVATAR RESULT]', JSON.stringify(avatarResult));
        const avatarId = avatarResult.data?.avatar_id || avatarResult.data?.id;
        if (avatarId) {
          // Step 3: Generate video with avatar_id
          const videoPayload = JSON.stringify({
            video_inputs: [{
              character: {
                type: 'talking_photo',
                talking_photo_id: avatarId
              },
              voice: {
                type: 'text',
                input_text: 'Good morning Captain. This is your NOTAM Intelligence pre-flight briefing. Have a safe flight.',
                voice_id: 'en-US-ChristopherNeural'
              }
            }],
            dimension: { width: 1280, height: 720 }
          });
          const videoResult = await new Promise((resolve, reject) => {
            const videoReq = https.request({
              hostname: 'api.heygen.com',
              path: '/v2/video/generate',
              method: 'POST',
              headers: {
                'x-api-key': process.env.HEYGEN_API_KEY,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(videoPayload)
              }
            }, videoRes => {
              let data = '';
              videoRes.on('data', chunk => data += chunk);
              videoRes.on('end', () => {
                console.log('[VIDEO RAW]', data.slice(0, 300));
                try { resolve(JSON.parse(data)); }
                catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
              });
            });
            videoReq.on('error', reject);
            videoReq.write(videoPayload);
            videoReq.end();
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            asset_id: assetId,
            avatar_id: avatarId,
            video: videoResult
          }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ asset_id: assetId, avatar: avatarResult }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ upload: uploadResult }));
      }
    } catch(e) {
      console.log('[HEYGEN ERROR]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── HEYGEN TEST 2 (use existing avatar ID) ────────────────────
  // Note: Avatar IV requires HeyGen Creator plan ($24/mo) or higher
  // Current account is on free tier - Avatar III only
  if (req.method === 'GET' && req.url === '/api/test-heygen2') {
    if (heygenTestLock) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already processing, please wait' }));
      return;
    }
    heygenTestLock = true;
    try {
      const videoPayload = JSON.stringify({
        video_inputs: [{
          character: {
            type: 'talking_photo',
            talking_photo_id: '8e0149d152e14333a81853524dc7706a',
            scale: 1,
            talking_style: 'stable'
          },
          voice: {
            type: 'audio',
            audio_asset_id: 'a9213dac95834047bd46e741bd40de27'
          }
        }],
        dimension: { width: 1280, height: 720 },
        use_avatar_iv_model: true,
        caption: false
      });
      const videoResult = await new Promise((resolve, reject) => {
        const videoReq = https.request({
          hostname: 'api.heygen.com',
          path: '/v2/video/generate',
          method: 'POST',
          headers: {
            'x-api-key': process.env.HEYGEN_API_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(videoPayload)
          }
        }, videoRes => {
          let data = '';
          videoRes.on('data', chunk => data += chunk);
          videoRes.on('end', () => {
            console.log('[VIDEO RAW]', data.slice(0, 300));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        videoReq.on('error', reject);
        videoReq.write(videoPayload);
        videoReq.end();
      });
      console.log('[VIDEO FULL RESULT]', JSON.stringify(videoResult));
      const videoId = videoResult.data?.video_id;
      console.log('[VIDEO ID]', videoId);
      if (videoId) {
        // Check status after 20 seconds
        await new Promise(r => setTimeout(r, 20000));
        const statusResult = await new Promise((resolve, reject) => {
          https.get({
            hostname: 'api.heygen.com',
            path: '/v1/video_status.get?video_id=' + videoId,
            headers: { 'x-api-key': process.env.HEYGEN_API_KEY }
          }, statusRes => {
            let data = '';
            statusRes.on('data', chunk => data += chunk);
            statusRes.on('end', () => {
              console.log('[STATUS RAW]', data.slice(0, 300));
              try { resolve(JSON.parse(data)); }
              catch(e) { resolve({ error: 'Parse error' }); }
            });
          }).on('error', reject);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ video_id: videoId, status: statusResult }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No video ID', result: videoResult }));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      heygenTestLock = false;
    }
    return;
  }

  // ── CHECK VIDEO STATUS ───────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/check-video/')) {
    const videoId = req.url.split('/api/check-video/')[1];
    try {
      const result = await new Promise((resolve, reject) => {
        https.get({
          hostname: 'api.heygen.com',
          path: '/v1/video_status.get?video_id=' + videoId,
          headers: { 'x-api-key': process.env.HEYGEN_API_KEY }
        }, statusRes => {
          let data = '';
          statusRes.on('data', chunk => data += chunk);
          statusRes.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error' }); }
          });
        }).on('error', reject);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── UPLOAD AUDIO ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/upload-audio') {
    let audioBuffer = [];
    req.on('data', chunk => audioBuffer.push(chunk));
    req.on('end', async () => {
      const audioData = Buffer.concat(audioBuffer);
      console.log('[AUDIO SIZE]', audioData.length);
      const boundary = '----FormBoundary' + Date.now();
      const formData = Buffer.concat([
        Buffer.from('--' + boundary + '\r\n'),
        Buffer.from('Content-Disposition: form-data; name="file"; filename="pilot_audio.mp3"\r\n'),
        Buffer.from('Content-Type: audio/mpeg\r\n\r\n'),
        audioData,
        Buffer.from('\r\n--' + boundary + '--\r\n')
      ]);
      try {
        const uploadResult = await new Promise((resolve, reject) => {
          const uploadReq = https.request({
            hostname: 'api.heygen.com',
            path: '/v3/assets',
            method: 'POST',
            headers: {
              'x-api-key': process.env.HEYGEN_API_KEY,
              'Content-Type': 'multipart/form-data; boundary=' + boundary,
              'Content-Length': formData.length
            }
          }, uploadRes => {
            let data = '';
            uploadRes.on('data', chunk => data += chunk);
            uploadRes.on('end', () => {
              console.log('[AUDIO UPLOAD]', data.slice(0, 200));
              try { resolve(JSON.parse(data)); }
              catch(e) { resolve({ error: 'Parse error' }); }
            });
          });
          uploadReq.on('error', reject);
          uploadReq.write(formData);
          uploadReq.end();
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(uploadResult));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── VEED FABRIC TEST (WaveSpeed) ─────────────────────────────
  if (req.method === 'GET' && req.url === '/api/test-veed') {
    try {
      // Read local pilot image
      const imageBase64 = fs.readFileSync('./pilot_image.jpg').toString('base64');
      // Download audio from HeyGen asset URL
      const audioData = await new Promise((resolve, reject) => {
        https.get('https://resource2.heygen.ai/audio/a9213dac95834047bd46e741bd40de27/original.mp3', res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      });
      const audioBase64 = audioData.toString('base64');
      console.log('[VEED] Image size:', imageBase64.length, 'Audio size:', audioBase64.length);
      // Call WaveSpeed VEED Fabric 1.0
      const payload = JSON.stringify({
        image: 'data:image/jpeg;base64,' + imageBase64,
        audio: 'data:audio/mpeg;base64,' + audioBase64,
        resolution: '480p'
      });
      const result = await new Promise((resolve, reject) => {
        const wavereq = https.request({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/veed/fabric-1.0',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, waveres => {
          let data = '';
          waveres.on('data', chunk => data += chunk);
          waveres.on('end', () => {
            console.log('[VEED RAW]', data.slice(0, 300));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        wavereq.on('error', reject);
        wavereq.write(payload);
        wavereq.end();
      });
      console.log('[VEED RESULT]', JSON.stringify(result).slice(0, 300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      console.log('[VEED ERROR]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── CHECK VEED STATUS ────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/check-veed/')) {
    const predId = req.url.split('/api/check-veed/')[1];
    try {
      const result = await new Promise((resolve, reject) => {
        https.get({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/predictions/' + predId + '/result',
          headers: { 'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY }
        }, statusRes => {
          let data = '';
          statusRes.on('data', chunk => data += chunk);
          statusRes.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        }).on('error', reject);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── SOULX FLASHHEAD TEST ─────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/test-flashhead') {
    try {
      const imageBase64 = fs.readFileSync('./pilot_image.jpg').toString('base64');
      const audioData = await new Promise((resolve, reject) => {
        https.get('https://resource2.heygen.ai/audio/a9213dac95834047bd46e741bd40de27/original.mp3', res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      });
      const audioBase64 = audioData.toString('base64');
      const payload = JSON.stringify({
        image: 'data:image/jpeg;base64,' + imageBase64,
        audio: 'data:audio/mpeg;base64,' + audioBase64,
        resolution: '720p'
      });
      const result = await new Promise((resolve, reject) => {
        const wavereq = https.request({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/wavespeed-ai/soulx-flashhead',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, waveres => {
          let data = '';
          waveres.on('data', chunk => data += chunk);
          waveres.on('end', () => {
            console.log('[FLASHHEAD RAW]', data.slice(0, 200));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        wavereq.on('error', reject);
        wavereq.write(payload);
        wavereq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── SKYREELS V3 TEST ─────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/test-skyreels') {
    try {
      const imageBase64 = fs.readFileSync('./pilot_image.jpg').toString('base64');
      const audioData = await new Promise((resolve, reject) => {
        https.get('https://resource2.heygen.ai/audio/a9213dac95834047bd46e741bd40de27/original.mp3', res => {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
      });
      // Use first 20 seconds worth of audio (approximate - first 1/2 of file)
      const audioTrimmed = audioData.slice(0, Math.floor(audioData.length / 2));
      const audioBase64 = audioTrimmed.toString('base64');
      const payload = JSON.stringify({
        image: 'data:image/jpeg;base64,' + imageBase64,
        audio: 'data:audio/mpeg;base64,' + audioBase64,
        resolution: '720p'
      });
      const result = await new Promise((resolve, reject) => {
        const wavereq = https.request({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/wavespeed-ai/skyreels-v3/talking-avatar',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, waveres => {
          let data = '';
          waveres.on('data', chunk => data += chunk);
          waveres.on('end', () => {
            console.log('[SKYREELS RAW]', data.slice(0, 200));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        wavereq.on('error', reject);
        wavereq.write(payload);
        wavereq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── KLING V3 PRO IMAGE-TO-VIDEO TEST ─────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/test-kling-i2v')) {
    try {
      const urlObj = new URL('https://notamai.onrender.com' + req.url);
      const clipNum = urlObj.searchParams.get('clip') || '1';
      const prompts = {
        '1': 'Experienced 60-year-old male airline captain with gray hair, wearing dark navy blue pilot uniform with gold epaulettes, pilot cap and aviator sunglasses, walks confidently through narrow aircraft passenger corridor toward cockpit. Opens heavy reinforced cockpit security door and steps inside. Cinematic tracking shot from behind, aircraft interior lighting, professional atmosphere, 24fps film grain, shallow depth of field.',
        '2': 'Experienced 60-year-old male airline captain with gray hair, navy blue uniform with gold epaulettes, sits down in left pilot seat of commercial aircraft cockpit. Removes pilot cap and places it on glareshield, takes off aviator sunglasses and puts them in breast pocket. Adjusts seat position professionally. Multiple glowing cockpit screens and instrument panels visible. Cinematic wide shot, warm golden cockpit lighting, shallow depth of field, 24fps film look.',
        '3': 'Experienced 60-year-old male airline captain with gray hair, navy blue uniform with gold epaulettes, reaches for flight documents and NOTAM papers from center console clipboard. Studies papers intensely, uses pen to circle important items and make notes. Occasionally cross-references cockpit instruments and navigation screens. Focused, serious professional expression. Close-up alternating between writing hands and concentrated face. Cinematic cockpit lighting, film grain.',
        '4': 'Experienced 60-year-old male airline captain with gray hair, navy blue uniform with gold epaulettes, slowly lowers flight documents and raises head to look directly into camera. Calm, authoritative, experienced expression. Slight confident nod as if about to deliver important pre-flight briefing. Cockpit instrument panels glowing in background, city lights or runway visible through windshield. Cinematic portrait shot, shallow depth of field, warm professional lighting.'
      };
      const payload = JSON.stringify({
        image: 'https://i.imgur.com/Aap70Bx.jpeg',
        prompt: prompts[clipNum],
        duration: 15,
        aspect_ratio: '16:9',
        mode: 'pro'
      });
      const result = await new Promise((resolve, reject) => {
        const wavereq = https.request({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/kwaivgi/kling-v3.0-pro/image-to-video',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, waveres => {
          let data = '';
          waveres.on('data', chunk => data += chunk);
          waveres.on('end', () => {
            console.log('[KLING I2V clip' + clipNum + ']', data.slice(0, 200));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        wavereq.on('error', reject);
        wavereq.write(payload);
        wavereq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── JOIN VIDEOS (Vace Video Joiner) ──────────────────────────
  if (req.method === 'GET' && req.url === '/api/join-videos') {
    try {
      const clipIds = [
        'e2a42e84bf804423a21c30175060613',
        'c049d522f6b84eb786c0e30952d3c625',
        '5ee42d8009c943bdb74d24107a64462b',
        '02372d2f0a744d0ab875889b18ad893'
      ];
      // Fetch video URLs for each clip
      const videoUrls = [];
      for (const id of clipIds) {
        const result = await new Promise((resolve, reject) => {
          https.get({
            hostname: 'api.wavespeed.ai',
            path: '/api/v3/predictions/' + id + '/result',
            headers: { 'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY }
          }, statusRes => {
            let data = '';
            statusRes.on('data', chunk => data += chunk);
            statusRes.on('end', () => {
              try { resolve(JSON.parse(data)); }
              catch(e) { resolve(null); }
            });
          }).on('error', reject);
        });
        const url = result?.data?.outputs?.[0];
        if (url) {
          videoUrls.push(url);
          console.log('[JOIN] Clip', id, 'URL:', url);
        }
      }
      console.log('[JOIN] Total clips found:', videoUrls.length);
      if (videoUrls.length < 2) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not enough video URLs found', urls: videoUrls }));
        return;
      }
      // Use Vace Video Joiner to concatenate clips
      const payload = JSON.stringify({
        videos: videoUrls,
        transition: 'none'
      });
      const joinResult = await new Promise((resolve, reject) => {
        const wavereq = https.request({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/wavespeed-ai/vace-video-joiner',
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, waveres => {
          let data = '';
          waveres.on('data', chunk => data += chunk);
          waveres.on('end', () => {
            console.log('[JOIN RESULT]', data.slice(0, 300));
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error', raw: data.slice(0, 200) }); }
          });
        });
        wavereq.on('error', reject);
        wavereq.write(payload);
        wavereq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ videoUrls, joinResult }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GENERATE VIDEO BRIEFING ───────────────────────────────────
  // ELEVENLABS_KEY must be set in Render environment variables
  if (req.method === 'POST' && req.url === '/api/generate-video-briefing') {
    if (videoBriefingLock) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already processing, please wait' }));
      return;
    }
    videoBriefingLock = true;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { route, briefingId } = JSON.parse(body);
        const userId = req.headers['x-user-id'];

        // Step 1: Get briefing content from Firestore
        let briefingContent = '';
        if (briefingId) {
          try {
            const doc = await adminDb.collection('briefings').doc(briefingId).get();
            if (doc.exists) {
              briefingContent = (doc.data().html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
            }
          } catch(e) { console.log('[VIDEO] Firestore error:', e.message); }
        }

        // Step 2: Generate script with Claude Haiku
        const hour = new Date().getUTCHours();
        const greeting = hour >= 5 && hour < 12 ? 'Good morning' : hour >= 12 && hour < 18 ? 'Good afternoon' : 'Good evening';
        const scriptPrompt = `You are Captain Edward, senior airline captain with 35 years experience.
Deliver a professional pre-flight video briefing in 55-60 seconds, natural spoken English, max 115 words.

Route: ${route}
Briefing data: ${briefingContent || 'Standard pre-flight briefing'}

EXACT STRUCTURE TO FOLLOW:
1. "${greeting}, Captain. Today we're flying from [departure city] to [arrival city]."
2. DEPARTURE AIRPORT NOTAMs (2-3 most critical): Describe specific impacts - name runways by full designator (e.g. "runway one seven left"), navaids by name and frequency, procedures by name. Say what's wrong and what crew must do. Most recent NOTAMs first.
3. ARRIVAL AIRPORT NOTAMs (1-2 most critical): Same approach as departure.
4. EN-ROUTE: Only mention if active airspace closures, GNSS jamming, or military restrictions on route. Skip if none.
5. WEATHER: One sentence maximum. Only mention if significant risk. Otherwise skip entirely.
6. "For complete NOTAM details and weather data, check your NOTAMs panel."
7. "Have a nice and smooth flight."

CRITICAL RULES:
- Use city names not ICAO codes when speaking
- Speak runway designators as words: "one seven left" not "17L"
- Speak navaid names and frequencies naturally: "the ILS on runway two five center"
- NO NOTAM reference numbers ever
- NO generic statements - be specific about actual impacts
- 70% of content = NOTAMs, 20% = en-route, 10% = weather
- Natural confident captain tone
- Plain text only, absolutely no markdown`;

        const scriptRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{ role: 'user', content: scriptPrompt }]
          })
        });
        const scriptData = await scriptRes.json();
        const script = scriptData.content?.[0]?.text || 'Pre-flight briefing complete. Have a safe flight.';
        console.log('[VIDEO SCRIPT]', script.slice(0, 100));

        // Step 3: Convert script to audio with ElevenLabs
        const VOICE_ID = 'jXkeB46JcPXXUSxzn3MD'; // Edward voice
        const ttsRes = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + VOICE_ID, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': process.env.ELEVENLABS_KEY
          },
          body: JSON.stringify({
            text: script,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: { stability: 0.75, similarity_boost: 0.85 }
          })
        });
        console.log('[TTS STATUS]', ttsRes.status);
        if (!ttsRes.ok) {
          const errText = await ttsRes.text();
          console.log('[TTS ERROR]', errText.slice(0, 200));
          throw new Error('ElevenLabs TTS failed: ' + ttsRes.status);
        }
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        console.log('[VIDEO AUDIO] Size:', audioBuffer.length, 'bytes');
        if (audioBuffer.length < 1000) {
          throw new Error('Audio too small - ElevenLabs may have failed: ' + audioBuffer.length);
        }

        // Step 4: Send image + audio to WaveSpeed InfiniteTalk Fast
        const imageData = fs.readFileSync('./pilot_image.jpg');
        const imageBase64 = imageData.toString('base64');
        const audioBase64 = audioBuffer.toString('base64');
        const payload = JSON.stringify({
          image: 'data:image/jpeg;base64,' + imageBase64,
          audio: 'data:audio/mpeg;base64,' + audioBase64,
          resolution: '480p'
        });
        const wsRes = await fetch('https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk-fast', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY,
            'Content-Type': 'application/json'
          },
          body: payload
        });
        const wsData = await wsRes.json();
        const predictionId = wsData?.data?.id;
        console.log('[VIDEO BRIEFING] Started:', predictionId, 'Script:', script.slice(0, 50));

        // Step 5: Save to Firestore videos collection
        await adminDb.collection('videos').add({
          userId,
          route,
          briefingId: briefingId || null,
          predictionId,
          script,
          status: 'processing',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ predictionId, script }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        videoBriefingLock = false;
      }
    });
    return;
  }

  // ── CHECK VIDEO BRIEFING STATUS ───────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/api/check-video-briefing/')) {
    const predId = req.url.split('/api/check-video-briefing/')[1];
    try {
      const result = await new Promise((resolve, reject) => {
        https.get({
          hostname: 'api.wavespeed.ai',
          path: '/api/v3/predictions/' + predId + '/result',
          headers: { 'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY }
        }, statusRes => {
          let data = '';
          statusRes.on('data', chunk => data += chunk);
          statusRes.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch(e) { resolve({ error: 'Parse error' }); }
          });
        }).on('error', reject);
      });
      const status = result?.data?.status;
      const videoUrl = result?.data?.outputs?.[0];

      // Fetch script from Firestore
      let script = null;
      try {
        const videoQuery = await adminDb.collection('videos').where('predictionId', '==', predId).limit(1).get();
        if (!videoQuery.empty) {
          script = videoQuery.docs[0].data().script || null;
          // Update Firestore when completed
          if (status === 'completed' && videoUrl) {
            await videoQuery.docs[0].ref.update({
              status: 'completed',
              videoUrl,
              completedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            console.log('[VIDEO ARCHIVE] Saved:', predId);
          }
        }
      } catch(e) { console.log('[VIDEO] Firestore update error:', e.message); }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status, videoUrl, script }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/airport/')) {
    const icao = req.url.split('/api/airport/')[1].split('?')[0];
    try {
      const data = await fetchURL('https://aviationweather.gov/api/data/airport?ids=' + icao + '&format=json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end('[]');
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/airport-info/')) {
    const icao = req.url.split('/api/airport-info/')[1].split('?')[0].toUpperCase();
    try {
      const data = await fetchURL('https://aviationweather.gov/api/data/airport?ids=' + icao + '&format=json');
      if (data && Array.isArray(data) && data.length > 0) {
        const apt = data[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          icao: icao,
          name: apt.name || icao,
          city: apt.city || '',
          country: apt.country || '',
          found: true
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ icao: icao, name: icao, found: false }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ icao: icao, name: icao, found: false }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/winds/')) {
    const icao = req.url.split('/api/winds/')[1].split('?')[0];
    try {
      // Get airport coordinates
      const aptData = await fetchURL('https://aviationweather.gov/api/data/airport?ids=' + icao + '&format=json');

      if (!aptData || !Array.isArray(aptData) || aptData.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Airport not found' }));
        return;
      }

      const lat = aptData[0].lat;
      const lon = aptData[0].lon;
      const name = aptData[0].name || icao;

      // Fetch winds at multiple pressure levels from Open-Meteo
      const windsUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=windspeed_850hPa,winddirection_850hPa,temperature_850hPa,windspeed_700hPa,winddirection_700hPa,temperature_700hPa,windspeed_500hPa,winddirection_500hPa,temperature_500hPa,windspeed_300hPa,winddirection_300hPa,temperature_300hPa,windspeed_250hPa,winddirection_250hPa,windspeed_200hPa,winddirection_200hPa&wind_speed_unit=kn&forecast_days=1&timezone=UTC`;

      const windsData = await fetchURL(windsUrl);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ apt: aptData[0], winds: windsData, name: name }));
    } catch(e) {
      console.log('[WINDS ERROR]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/airport-search/')) {
    const query = decodeURIComponent(req.url.split('/api/airport-search/')[1]);
    try {
      const data = await fetchURL(
        'https://skylink-api.p.rapidapi.com/v3/airports?search=' + encodeURIComponent(query) + '&limit=8&type=large_airport,medium_airport',
        {
          headers: {
            'X-RapidAPI-Key': process.env.SKYLINK_KEY,
            'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
          }
        }
      );

      console.log('[AIRPORT SEARCH]', query, '->', JSON.stringify(data).slice(0, 200));

      const airports = Array.isArray(data) ? data : (data?.airports || data?.data || []);

      const results = airports
        .filter(a => a.icao && a.icao.length === 4)
        .slice(0, 8)
        .map(a => ({
          id: a.icao,
          name: a.name || a.airport_name || '',
          country: a.country || a.iso_country || '',
          city: a.municipality || a.city || ''
        }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch(e) {
      console.log('[AIRPORT SEARCH ERROR]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/')) {
    const urlParams = req.url.replace('/api/raw/', '');
    const [type, icao] = urlParams.split('/');

    if (type === 'notam') {
      try {
        const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao;
        const data = await fetchURL(skyUrl, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        if (!data || !data.notams || data.notams.length === 0) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('No active NOTAMs for ' + icao);
          return;
        }
        const now = new Date();
        const active = data.notams.filter(n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(
            parseInt(e.slice(0,4)), parseInt(e.slice(4,6)) - 1, parseInt(e.slice(6,8)),
            parseInt(e.slice(8,10)), parseInt(e.slice(10,12))
          ));
          return expDate > now;
        }).sort((a, b) => {
          const dateA = a.effective || '0';
          const dateB = b.effective || '0';
          return dateB.localeCompare(dateA);
        });
        const notamText = active.map(n => {
          const id = n.notam_id || '';
          const ntype = n.type === 'R' ? 'NOTAMR' : n.type === 'C' ? 'NOTAMC' : 'NOTAMN';
          const location = n.location || icao;
          const effective = n.effective ? n.effective.slice(2) : '';
          const expiration = n.expiration ? (n.expiration === 'PERM' ? 'PERM' : n.expiration.slice(2)) : 'PERM';
          const body = (n.body || '').trim() || (n.raw || '').replace(/^![A-Z]+ [A-Z0-9/]+\s*/, '').trim();
          let formatted = id + '\t' + ntype + '\n';
          formatted += 'A) ' + location + '\n';
          formatted += 'B) ' + effective + ' C) ' + expiration + '\n';
          formatted += 'E) ' + body;
          return formatted;
        }).join('\n===NOTAM===\n');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(notamText || 'No active NOTAMs for ' + icao);
      } catch(e) {
        res.writeHead(500);
        res.end('Error: ' + e.message);
      }
      return;
    }

    if (type === 'sigmet') {
      try {
        const isUS = icao.startsWith('K') || icao.startsWith('P');
        const prefix = icao.slice(0, 2).toUpperCase();

        if (isUS) {
          // US airports: use domestic SIGMET endpoint
          const response = await fetch('https://aviationweather.gov/api/data/sigmet?format=json');
          const data = await response.json();
          const arr = Array.isArray(data) ? data : Object.values(data);
          if (!arr || !arr.length) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('NO_SIGMET');
            return;
          }
          const relevant = arr.filter(s => {
            const fir = (s.icaoId || s.firId || '').toUpperCase();
            return fir.startsWith(prefix) || fir === 'K' + icao.slice(1, 3);
          }).sort((a, b) => (b.validTimeFrom || 0) - (a.validTimeFrom || 0)).slice(0, 10);
          const text = relevant
            .map(s => {
              if (s.rawAirSigmet) return s.rawAirSigmet;
              const lines = [];
              lines.push((s.icaoId || '') + ' ' + (s.seriesId || '') + ' SIGMET');
              if (s.firName || s.firId) lines.push('FIR: ' + (s.firName || s.firId));
              lines.push('HAZARD: ' + (s.hazard || '') + (s.qualifier ? ' ' + s.qualifier : ''));
              const from = s.validTimeFrom ? new Date(s.validTimeFrom * 1000).toUTCString() : '';
              const to = s.validTimeTo ? new Date(s.validTimeTo * 1000).toUTCString() : '';
              if (from && to) lines.push('VALID: ' + from + ' TO ' + to);
              if (s.altitudeLow1 !== null && s.altitudeLow1 !== undefined) lines.push('BASE: ' + (s.altitudeLow1 === 0 ? 'SFC' : 'FL' + s.altitudeLow1 / 100));
              if (s.altitudeHi1) lines.push('TOP: FL' + Math.round(s.altitudeHi1 / 100));
              if (s.coords && Array.isArray(s.coords)) {
                const coordStr = s.coords.map(c => {
                  if (typeof c === 'object' && c.lat && c.lon) return c.lat + '/' + c.lon;
                  if (typeof c === 'object' && c.latitude && c.longitude) return c.latitude + '/' + c.longitude;
                  return JSON.stringify(c);
                }).join(' - ');
                if (coordStr && !coordStr.includes('[object')) lines.push('AREA: ' + coordStr);
              } else if (s.geom && s.geom.coordinates) {
                const coords = s.geom.coordinates[0];
                if (Array.isArray(coords) && coords.length > 0) {
                  const coordStr = coords.slice(0, 4).map(c => c[1].toFixed(1) + 'N/' + c[0].toFixed(1) + 'E').join(' - ');
                  lines.push('AREA: ' + coordStr);
                }
              } else if (s.area) {
                lines.push('AREA: ' + s.area);
              }
              return lines.join('\n');
            })
            .filter(t => t.trim())
            .join('\n\n');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(text || 'NO_SIGMET');
        } else {
          // International airports: use ISIGMET endpoint
          const response = await fetch('https://aviationweather.gov/api/data/isigmet?format=json');
          const data = await response.json();
          const arr = Array.isArray(data) ? data : (data.data || data.results || Object.values(data));
          if (!arr || !arr.length) {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('NO_SIGMET');
            return;
          }
          // Map ICAO prefix to likely FIR regions
          const regionFirs = {
            'LT': ['LTBB'], 'LG': ['LGGG'], 'LE': ['LECM'], 'LF': ['LFFF'],
            'ED': ['EDGG'], 'EG': ['EGTT'], 'LI': ['LIIV'], 'EB': ['EBUR'],
            'EH': ['EHAA'], 'EK': ['EKDK'], 'EN': ['ENOR'], 'EP': ['EPWW'],
            'LK': ['LKAA'], 'LO': ['LOVV'], 'LB': ['LBSR'], 'LR': ['LRBB'],
            'LD': ['LDZO'], 'LY': ['LYBA'], 'LH': ['LHCC'], 'LZ': ['LZBB'],
            'OB': ['OBBB'], 'OE': ['OEJD'], 'OI': ['OIIX'], 'OJ': ['OJAC'],
            'OK': ['OKAC'], 'OM': ['OMAE'], 'OR': ['ORBB'], 'OT': ['OTBD'],
            'OY': ['OYSC'], 'HE': ['HECC'], 'HA': ['HAAA'], 'HD': ['HDDD'],
            'HH': ['HHAS'], 'HR': ['HRRR'], 'HS': ['HSSN'], 'HT': ['HTTC'],
            'ZB': ['ZBPE'], 'ZS': ['ZSHA'], 'RJ': ['RJJJ'], 'RK': ['RKRR'],
            'VT': ['VTBB'], 'WS': ['WSSS'], 'VH': ['VHHH'], 'OP': ['OPKR'],
            'VI': ['VIDF'], 'VA': ['VAAF'], 'FA': ['FAJA'], 'DA': ['DAAA'],
            'DN': ['DNKK'], 'YB': ['YMMM'], 'NZ': ['NZZC'],
          };
          const myFirs = regionFirs[prefix] || [];
          const relevant = arr.filter(s => {
            const firId = (s.firId || '').toUpperCase();
            const icaoId = (s.icaoId || '').toUpperCase();
            return myFirs.includes(firId) ||
                   firId.startsWith(prefix) ||
                   icaoId.startsWith(prefix);
          }).sort((a, b) => (b.validTimeFrom || 0) - (a.validTimeFrom || 0)).slice(0, 10);
          const text = relevant.map(s => {
            if (s.rawAirSigmet) return s.rawAirSigmet;
            const lines = [];
            lines.push((s.icaoId || '') + ' ' + (s.seriesId || '') + ' SIGMET');
            if (s.firName || s.firId) lines.push('FIR: ' + (s.firName || s.firId));
            lines.push('HAZARD: ' + (s.hazard || '') + (s.qualifier ? ' ' + s.qualifier : ''));
            const from = s.validTimeFrom ? new Date(s.validTimeFrom * 1000).toUTCString() : '';
            const to = s.validTimeTo ? new Date(s.validTimeTo * 1000).toUTCString() : '';
            if (from && to) lines.push('VALID: ' + from + ' TO ' + to);
            if (s.altitudeLow1 !== null && s.altitudeLow1 !== undefined) lines.push('BASE: ' + (s.altitudeLow1 === 0 ? 'SFC' : 'FL' + s.altitudeLow1 / 100));
            if (s.altitudeHi1) lines.push('TOP: FL' + Math.round(s.altitudeHi1 / 100));
            if (s.coords && Array.isArray(s.coords)) {
              const coordStr = s.coords.map(c => {
                if (typeof c === 'object' && c.lat && c.lon) return c.lat + '/' + c.lon;
                if (typeof c === 'object' && c.latitude && c.longitude) return c.latitude + '/' + c.longitude;
                return JSON.stringify(c);
              }).join(' - ');
              if (coordStr && !coordStr.includes('[object')) lines.push('AREA: ' + coordStr);
            } else if (s.geom && s.geom.coordinates) {
              const coords = s.geom.coordinates[0];
              if (Array.isArray(coords) && coords.length > 0) {
                const coordStr = coords.slice(0, 4).map(c => c[1].toFixed(1) + 'N/' + c[0].toFixed(1) + 'E').join(' - ');
                lines.push('AREA: ' + coordStr);
              }
            } else if (s.area) {
              lines.push('AREA: ' + s.area);
            }
            return lines.join('\n');
          }).filter(t => t.trim()).join('\n\n');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(text || 'NO_SIGMET');
        }
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('NO_SIGMET');
      }
      return;
    }

    let apiUrl = '';
    if (type === 'metar') {
      apiUrl = 'https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=2';
    } else if (type === 'taf') {
      apiUrl = 'https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw';
    }
    if (!apiUrl) { res.writeHead(400); res.end('Invalid type'); return; }
    try {
      const response = await fetchURL(apiUrl);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(typeof response === 'string' ? response : JSON.stringify(response));
    } catch(e) {
      res.writeHead(500);
      res.end('Error fetching data');
    }
    return;
  }

  if (req.method === 'GET' && (urlPath === '/how-it-works' || urlPath === '/how-it-works.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'how-it-works.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── LEMONSQUEEZY CHECKOUT ────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/create-checkout') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { plan, userId, email } = JSON.parse(body);
        const variantId = plan === 'premium'
          ? process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID
          : process.env.LEMONSQUEEZY_PRO_VARIANT_ID;
        const response = await fetchURL('https://api.lemonsqueezy.com/v1/checkouts', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + process.env.LEMONSQUEEZY_API_KEY,
            'Content-Type': 'application/vnd.api+json',
            'Accept': 'application/vnd.api+json'
          },
          body: JSON.stringify({
            data: {
              type: 'checkouts',
              attributes: {
                checkout_data: {
                  email: email,
                  custom: { user_id: userId }
                },
                product_options: {
                  redirect_url: 'https://notamai.onrender.com/?upgrade=success',
                  receipt_link_url: 'https://notamai.onrender.com/?upgrade=success'
                }
              },
              relationships: {
                store: { data: { type: 'stores', id: process.env.LEMONSQUEEZY_STORE_ID } },
                variant: { data: { type: 'variants', id: variantId } }
              }
            }
          })
        });
        const checkoutUrl = response?.data?.attributes?.url;
        console.log('[CHECKOUT URL]', checkoutUrl);
        console.log('[CHECKOUT FULL]', JSON.stringify(response?.data?.attributes).slice(0, 500));
        if (!checkoutUrl) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Could not create checkout', details: response }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: checkoutUrl }));
      } catch(e) {
        console.log('[CHECKOUT ERROR]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── LEMONSQUEEZY WEBHOOK ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/lemonsqueezy-webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const crypto = require('crypto');
        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        const signature = req.headers['x-signature'];
        const hmac = crypto.createHmac('sha256', secret).update(body).digest('hex');
        if (signature !== hmac) {
          console.log('[WEBHOOK] Invalid signature');
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }
        const event = JSON.parse(body);
        const eventName = event.meta?.event_name;
        const userId = event.meta?.custom_data?.user_id;
        const variantId = String(event.data?.attributes?.variant_id || event.data?.attributes?.first_order_item?.variant_id || '');
        console.log('[WEBHOOK]', eventName, 'userId:', userId, 'variantId:', variantId);
        if (!userId) { res.writeHead(200); res.end('OK'); return; }
        const proPlanId = String(process.env.LEMONSQUEEZY_PRO_VARIANT_ID);
        const premiumPlanId = String(process.env.LEMONSQUEEZY_PREMIUM_VARIANT_ID);
        let plan = null;
        if (variantId === proPlanId) plan = 'pro';
        if (variantId === premiumPlanId) plan = 'premium';
        if (eventName === 'subscription_created' || eventName === 'order_created') {
          if (plan) {
            await adminDb.collection('users').doc(userId).set({
              plan,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log('[WEBHOOK] Plan updated:', userId, '→', plan);
          }
        }
        if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
          await adminDb.collection('users').doc(userId).set({
            plan: 'free',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log('[WEBHOOK] Plan downgraded to free:', userId);
        }
        res.writeHead(200);
        res.end('OK');
      } catch(e) {
        console.log('[WEBHOOK ERROR]', e.message);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/extract-route') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 50,
            system: 'You are an expert aviation dispatcher with complete knowledge of all world airports and their ICAO codes. Your only job is to extract departure and arrival airports from any natural language input (in any language) and return their ICAO codes.\n\nRules:\n- Always use the main international airport for a city unless specified otherwise\n- Convert city names, country names, airport names, or any hint to the correct ICAO code\n- Support any language input (Turkish, English, Spanish, Arabic, etc.)\n- Examples: "Istanbul Frankfurt" -> "LTFM EDDF", "Barcelona Milan dedim" -> "LEBL LIMC", "Paris CDG to Dubai" -> "LFPG OMDB", "bugün istanbul londra var" -> "LTFM EGLL", "مطار دبي إلى لندن" -> "OMDB EGLL"\n- If only one airport mentioned, return UNKNOWN\n- Return ONLY the format: XXXX XXXX (exactly 4 letters, space, 4 letters)\n- Return UNKNOWN if you truly cannot identify both airports',
            messages: [{ role: 'user', content: text }]
          })
        });
        const claudeData = await claudeRes.json();
        const result = claudeData.content?.[0]?.text?.trim() || 'UNKNOWN';
        if (result === 'UNKNOWN' || !result.match(/^[A-Z]{4}\s[A-Z]{4}$/)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ route: null }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ route: result }));
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ route: null }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/analyze-notam') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const userId = req.headers['x-user-id'];
        if (userId) {
          const plan = await getUserPlan(userId);
          if (plan === 'free') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upgrade_required', feature: 'analysis' }));
            return;
          }
          const usage = await getUserUsage(userId, 'analysis');
          const limit = PLAN_LIMITS[plan]?.analysis || 0;
          if (usage >= limit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan, feature: 'analysis' }));
            return;
          }
          await incrementUsage(userId, 'analysis');
        }

        const { notam, type } = JSON.parse(body);

        // Extract ICAO codes from the text and look up live names
        const icaoMatches = (notam || '').match(/\b[A-Z]{4}\b/g) || [];
        const uniqueIcaos = [...new Set(icaoMatches.filter(c => {
          const validPrefixes = ['LT','EG','ED','LF','LI','LE','EH','EK','EN','LG','LO','LK','LB','LR','EP','OM','OE','OI','OJ','OR','OT','OY','ZB','ZS','RJ','RK','VT','WS','VH','HE','DA','DT','FA','YM','KJ','KL','LH','LY','LD','EF','EE','EV','EY'];
          return validPrefixes.some(p => c.startsWith(p));
        }))];

        const airportNames = {};
        await Promise.all(uniqueIcaos.slice(0, 5).map(async icao => {
          try {
            const data = await fetchURL('https://aviationweather.gov/api/data/airport?ids=' + icao + '&format=json');
            if (data && Array.isArray(data) && data.length > 0 && data[0].name) {
              airportNames[icao] = data[0].name + (data[0].city ? ', ' + data[0].city : '') + (data[0].country ? ', ' + data[0].country : '');
            }
          } catch(e) {}
        }));

        const airportContext = Object.keys(airportNames).length > 0
          ? '\n\nVERIFIED AIRPORT NAMES FROM LIVE DATABASE:\n' + Object.entries(airportNames).map(([k, v]) => k + ' = ' + v).join('\n')
          : '';

        let analyzeSystemPrompt;
        if (type === 'SIGMET') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist and AIM specialist with complete and verified knowledge of all world FIRs.\n\nVERIFIED FIR IDENTIFIERS (use ONLY these, never guess):\n\nTURKEY:\nLTAA = Ankara FIR (Turkey) - covers central/eastern Turkey\nLTBB = Istanbul FIR (Turkey) - covers western Turkey and Thrace\n\nEUROPE:\nEGTT = London FIR (UK)\nEGPX = Scottish FIR (UK)\nEGGX = Shanwick Oceanic FIR (UK/Ireland)\nEISN = Shannon FIR (Ireland)\nLFFF = Paris FIR (France)\nLFMM = Marseille FIR (France)\nEDGG = Langen FIR (Germany)\nEDMM = Munich FIR (Germany)\nLIIV = Roma FIR (Italy)\nLIPZ = Padova FIR (Italy)\nLECM = Madrid FIR (Spain)\nLEMD = Canarias FIR (Spain)\nLPPC = Lisboa FIR (Portugal)\nEBUR = Brussels FIR (Belgium)\nEHAA = Amsterdam FIR (Netherlands)\nEKDK = Copenhagen FIR (Denmark)\nENOR = Oslo FIR (Norway)\nESAA = Stockholm FIR (Sweden)\nEFIN = Helsinki FIR (Finland)\nBIRD = Reykjavik FIR (Iceland)\nEPWW = Warsaw FIR (Poland)\nLKAA = Praha FIR (Czech Republic)\nLOVV = Wien FIR (Austria)\nLSZR = Zurich FIR (Switzerland)\nLJLA = Ljubljana FIR (Slovenia)\nLDZO = Zagreb FIR (Croatia)\nLYBA = Beograd FIR (Serbia)\nLBSR = Sofia FIR (Bulgaria)\nLRBB = Bucuresti FIR (Romania)\nLHCC = Budapest FIR (Hungary)\nLZBB = Bratislava FIR (Slovakia)\nLGGG = Athinai FIR (Greece)\nLCCC = Nicosia FIR (Cyprus)\n\nMIDDLE EAST:\nORBB = Baghdad FIR (Iraq)\nOSTT = Damascus FIR (Syria)\nOJAC = Amman FIR (Jordan)\nOLBB = Beirut FIR (Lebanon)\nHECC = Cairo FIR (Egypt)\nOEJD = Jeddah FIR (Saudi Arabia)\nOOKB = Muscat FIR (Oman)\nOMAE = Emirates FIR (UAE)\nOBBB = Bahrain FIR (Bahrain/Qatar area)\nOTBD = Doha FIR (Qatar)\nOYSC = Sanaa FIR (Yemen)\nOIIX = Tehran FIR (Iran)\nOPKR = Karachi FIR (Pakistan)\nOPLA = Lahore FIR (Pakistan)\n\nCENTRAL ASIA:\nUTAA = Ashgabat FIR (Turkmenistan)\nUCFM = Bishkek FIR (Kyrgyzstan)\nUAAA = Almaty FIR (Kazakhstan)\nUACC = Astana FIR (Kazakhstan)\nUGGG = Tbilisi FIR (Georgia)\nUDDD = Yerevan FIR (Armenia)\nUBBA = Baku FIR (Azerbaijan)\n\nRUSSIA/CIS:\nUUWV = Moskva FIR (Russia - Moscow)\nULLL = Sankt-Peterburg FIR (Russia)\nUNNT = Novosibirsk FIR (Russia)\nUHHH = Khabarovsk FIR (Russia)\nUEEE = Yakutsk FIR (Russia)\nUHPP = Petropavlovsk FIR (Russia)\nUKBV = Kyiv FIR (Ukraine)\nUMMV = Minsk FIR (Belarus)\n\nSOUTH ASIA:\nVIDF = Delhi FIR (India)\nVECF = Calcutta FIR (India)\nVAAF = Mumbai FIR (India)\nVOCB = Chennai FIR (India)\nVCCF = Colombo FIR (Sri Lanka)\nVNKT = Kathmandu FIR (Nepal)\nVGDT = Dhaka FIR (Bangladesh)\n\nSOUTHEAST ASIA:\nVTBB = Bangkok FIR (Thailand)\nVVHM = Ho Chi Minh FIR (Vietnam)\nVVHN = Hanoi FIR (Vietnam)\nWMFC = Kuala Lumpur FIR (Malaysia)\nWBFC = Kota Kinabalu FIR (Malaysia)\nWSJC = Singapore FIR (Singapore - NOT Jakarta)\nWAAF = Jakarta FIR (Indonesia)\nWIIF = Ujung Pandang FIR (Indonesia)\nRPHI = Manila FIR (Philippines)\nVDPP = Phnom Penh FIR (Cambodia)\nVLVT = Vientiane FIR (Laos)\nVYYY = Yangon FIR (Myanmar)\n\nEAST ASIA:\nZBPE = Beijing FIR (China)\nZSHA = Shanghai FIR (China)\nZGZU = Guangzhou FIR (China)\nZWWW = Urumqi FIR (China)\nRJJJ = Fukuoka FIR (Japan)\nRKRR = Incheon FIR (South Korea)\nRCTP = Taipei FIR (Taiwan)\nVHHH = Hongkong FIR (China/HK)\nVMMC = Macau FIR\nZPKM = Kunming FIR (China)\n\nOCEANIC:\nKZNY = New York Oceanic FIR (USA)\nKZAK = Oakland Oceanic FIR (USA)\nCZQX = Gander Oceanic FIR (Canada)\nNFFF = Nadi FIR (Fiji)\nNTTT = Tahiti FIR (French Polynesia)\nYMMM = Melbourne FIR (Australia)\nNZZC = Auckland FIR (New Zealand)\n\nNORTH AMERICA:\nKZJX = Jacksonville FIR (USA)\nKZHU = Houston FIR (USA)\nKZFW = Fort Worth FIR (USA)\nKZKC = Kansas City FIR (USA)\nKZMP = Minneapolis FIR (USA)\nKZMA = Miami FIR (USA)\nKZSE = Seattle FIR (USA)\nKZLA = Los Angeles FIR (USA)\nCZUL = Montreal FIR (Canada)\nCZVR = Vancouver FIR (Canada)\nCZEG = Edmonton FIR (Canada)\nCZWG = Winnipeg FIR (Canada)\nMMEX = Mexico FIR (Mexico)\n\nAFRICA:\nDAAA = Alger FIR (Algeria)\nDTTC = Tunis FIR (Tunisia)\nGMMM = Casablanca FIR (Morocco)\nHECC = Cairo FIR (Egypt)\nHAAA = Addis Abeba FIR (Ethiopia)\nHCSM = Mogadishu FIR (Somalia)\nHKNA = Nairobi FIR (Kenya)\nHRRR = Kigali FIR (Rwanda)\nHTTT = Dar es Salaam FIR (Tanzania)\nFAJA = Johannesburg FIR (South Africa)\nFZAA = Kinshasa FIR (DRC)\nDNKK = Kano FIR (Nigeria)\nDGAC = Accra FIR (Ghana)\nDBBB = Cotonou FIR (Benin)\nGOOO = Dakar Oceanic FIR (Senegal)\n\nAnalyze this SIGMET and provide:\n1. Correct FIR name and country using mappings above\n2. Hazard type with operational significance\n3. Affected altitude range (FL)\n4. Active time period (UTC)\n5. Operational impact and specific crew actions\n\nBe concise, 4-5 bullet points, practical for crews.';
        } else if (type === 'METAR') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. You will receive verified airport names from a live database in the prompt. ALWAYS use these verified names exactly as provided.\n2. For any ICAO code NOT in the verified list, use your training knowledge to identify the correct official airport name and city.\n3. NEVER guess or invent airport names - if truly uncertain, just state the ICAO code.\n\nDecode this METAR and provide:\n1. Airport name and ICAO code (verified correct)\n2. Current conditions summary (wind, visibility, weather)\n3. Ceiling and cloud layers\n4. Temperature, dewpoint, pressure\n5. Any hazards or significant phenomena\n6. Operational recommendation (VFR/IFR/MVFR status)\n\nBe concise, 4-6 bullet points, practical for flight crews.';
        } else if (type === 'TAF') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. You will receive verified airport names from a live database in the prompt. ALWAYS use these verified names exactly as provided.\n2. For any ICAO code NOT in the verified list, use your training knowledge to identify the correct official airport name and city.\n3. NEVER guess or invent airport names - if truly uncertain, just state the ICAO code.\n\nDecode this TAF and provide:\n1. Airport name and ICAO code (verified correct)\n2. Forecast period and overall summary\n3. Significant weather changes and timing\n4. Worst conditions expected and when\n5. Any TEMPO, BECMG, or PROB groups of concern\n6. Operational planning recommendation\n\nBe concise, 4-6 bullet points, practical for flight planning.';
        } else {
          analyzeSystemPrompt = 'You are an expert AIM (Aeronautical Information Management) specialist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. You will receive verified airport names from a live database in the prompt. ALWAYS use these verified names exactly as provided.\n2. For any ICAO code NOT in the verified list, use your training knowledge to identify the correct official airport name and city.\n3. NEVER guess or invent airport names - if truly uncertain, just state the ICAO code.\n\nAnalyze this NOTAM and provide:\n1. What is affected (runway, navaid, airspace, service)\n2. When it is active (effective and expiry times in UTC)\n3. Operational impact for crews\n4. Required crew action\n5. Risk level (CRITICAL/HIGH/MEDIUM/LOW)\n\nBe concise and practical. Use plain English.';
        }
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            system: [{ type: 'text', text: analyzeSystemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: 'Analyze this ' + (type || 'NOTAM') + ':\n\n' + notam + airportContext }]
          })
        });
        const claudeData = await claudeRes.json();
        if (claudeData.usage) {
          console.log('[CACHE /analyze-notam]', {
            input: claudeData.usage.input_tokens,
            output: claudeData.usage.output_tokens,
            cache_created: claudeData.usage.cache_creation_input_tokens || 0,
            cache_read: claudeData.usage.cache_read_input_tokens || 0
          });
        }
        const analysis = claudeData.content?.[0]?.text || 'Unable to analyze.';
        const formatted = analysis
          .split('\n')
          .filter(l => l.trim())
          .map(l => `<div style="margin-bottom:6px;">• ${l.replace(/^[•\-\*]\s*/, '')}</div>`)
          .join('');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: formatted }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: 'Error analyzing NOTAM.' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const userId = req.headers['x-user-id'];
        if (userId) {
          const plan = await getUserPlan(userId);
          if (plan === 'free') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upgrade_required', feature: 'chat' }));
            return;
          }
          const usage = await getUserUsage(userId, 'chat');
          const limit = PLAN_LIMITS[plan]?.chat || 0;
          if (usage >= limit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan, feature: 'chat' }));
            return;
          }
          await incrementUsage(userId, 'chat');
        }

        const { question, briefingContext, currentRoute, history, image_base64, image_type, pdf_base64 } = JSON.parse(body);

        // Extract ICAO codes from route for live data fetching
        const icaoCodes = currentRoute
          ? currentRoute.replace(/[^A-Z\s]/g, '').trim().split(/\s+/).filter(c => c.length >= 3 && c.length <= 4)
          : [];

        // Fallback: extract dep/arr from briefing context if route was empty
        if (!icaoCodes.length && briefingContext) {
          const routeMatch = briefingContext.match(/([A-Z]{4})\s*[→\-–]\s*([A-Z]{4})/);
          if (routeMatch) {
            icaoCodes.push(routeMatch[1], routeMatch[2]);
          }
        }

        // Detect if live data is needed
        const needsLiveNotam   = /notam|active|current.*notam|how many notam|kaç notam|güncel notam|enroute|en-route|military|TFR|restricted|FIR/i.test(question);
        const needsLiveWeather = /weather|hava|metar|taf|cloud|wind|rüzgar|bulut|görüş|visibility|ceiling|tafc|sigmet|atis/i.test(question);

        let liveData = '';

        // Fetch live NOTAMs if needed
        if (needsLiveNotam && icaoCodes.length > 0) {
          for (const icao of icaoCodes.slice(0, 2)) {
            try {
              const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao;
              const data = await fetchURL(skyUrl, {
                method: 'GET',
                headers: {
                  'x-rapidapi-key': process.env.SKYLINK_KEY,
                  'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
                }
              });
              if (data && data.notams) {
                const now = new Date();
                const active = data.notams.filter(n => {
                  if (!n.expiration || n.expiration.length < 12) return true;
                  const e = n.expiration;
                  const expDate = new Date(Date.UTC(parseInt(e.slice(0,4)), parseInt(e.slice(4,6))-1, parseInt(e.slice(6,8)), parseInt(e.slice(8,10)), parseInt(e.slice(10,12))));
                  return expDate > now;
                });
                const critical = active.filter(n => /RWY.*CLSD|CLSD.*RWY|U\/S|UNSERVICEABLE|JAMM|EMERG/i.test(n.raw || n.body || ''));
                const high     = active.filter(n => /TWY.*CLSD|CLSD.*TWY|VOR|ILS|NDB|UAS/i.test(n.raw || n.body || ''));
                liveData += `\nLIVE NOTAM DATA FOR ${icao}: ${active.length} active NOTAMs. Critical: ${critical.length}, High priority: ${high.length}, Other: ${active.length - critical.length - high.length}.\n`;
                liveData += `Sample critical NOTAMs: ${critical.slice(0,3).map(n => (n.notam_id || '') + ': ' + (n.body || n.raw || '').slice(0,100)).join('; ')}\n`;
              }
            } catch(e) {}
          }
        }

        // Fetch live METAR + TAF if needed
        if (needsLiveWeather && icaoCodes.length > 0) {
          for (const icao of icaoCodes.slice(0, 3)) {
            try {
              const metarRes = await fetch('https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=raw&hours=3');
              const metarText = await metarRes.text();
              const tafRes = await fetch('https://aviationweather.gov/api/data/taf?ids=' + icao + '&format=raw');
              const tafText = await tafRes.text();
              if (metarText.trim() && !metarText.includes('No data')) {
                liveData += '\nLIVE METAR ' + icao + ':\n' + metarText.trim() + '\n';
              }
              if (tafText.trim() && !tafText.includes('No data')) {
                liveData += '\nLIVE TAF ' + icao + ':\n' + tafText.trim() + '\n';
              }
            } catch(e) {}
          }
        }

        // Fetch live en-route FIR NOTAMs if user asks about airspace/FIRs/route
        const needsEnroute = /en.?route|fir|airspace|hava saha|güzergah|rota boyunca|military|askeri|tfr|restricted|yasak/i.test(question);
        if (needsEnroute && icaoCodes.length >= 2) {
          try {
            const dep = icaoCodes[0];
            const arr = icaoCodes[icaoCodes.length - 1];
            const enrouteData = await getEnrouteNotams(dep, arr);
            if (enrouteData) {
              liveData += '\n\nLIVE EN-ROUTE FIR NOTAMs FETCHED NOW:\n' + enrouteData;
            }
          } catch(e) {
            console.error('[CHAT ENROUTE]', e.message);
          }
        }

        // System prompt
        const systemPrompt = `You are an expert AIM (Aeronautical Information Management) specialist and senior flight dispatcher with deep knowledge of ICAO Annex 15, PANS-AIM, and international aviation operations.

The following is the complete pre-flight operational briefing you have analyzed:

${briefingContext}

${liveData ? 'LIVE REAL-TIME DATA FETCHED:\n' + liveData : ''}

IMPORTANT - NOTAM SCOPE: When analyzing NOTAMs, consider ALL types including:
- Aerodrome NOTAMs (departure and arrival airports)
- En-route NOTAMs (airspace along the route)
- Military exercise areas and restricted airspace
- TFRs (Temporary Flight Restrictions)
- FIR/UIR closures or restrictions
- SIGMET and special activity areas
If the briefing does not contain en-route or military NOTAMs, explicitly state this and recommend the crew check current en-route NOTAMs via NOTAMs & MET panel or official sources for the specific FIRs along the route.

IMPORTANT INSTRUCTIONS:
- Answer in the SAME LANGUAGE the user asks the question (Turkish → Turkish, English → English, etc.)
- For weather questions: use the weather data from the briefing. If live METAR was fetched, use that for current conditions.
- For NOTAM questions: use the NOTAM analysis from the briefing. If live NOTAM count was fetched, mention exact numbers.
- If user wants to see ALL NOTAMs, tell them to open the "NOTAMs & MET" panel in the sidebar for full raw NOTAM data.
- Be concise (under 200 words), professional, and operationally focused.
- Always prioritize flight safety in your answers.

CRITICAL: If live FIR NOTAM data is provided in 'LIVE EN-ROUTE FIR NOTAMs FETCHED NOW', analyze it fully and present findings. NEVER say the briefing is missing data or suggest checking elsewhere unless the live fetch also returned no data. If live data shows 'No active NOTAMs', confirm it explicitly. Never deflect - give the actual data.

IMPORTANT FEATURE INFO: The sidebar has a 'NOTAMs & MET' panel where users can:
- Enter any ICAO code to see ALL active raw NOTAMs (not just the ones in this briefing)
- View live METAR and TAF data
- Click '✦ Analyze' button on any individual NOTAM, METAR, or TAF to get instant AI analysis
- This is useful when they want to see NOTAMs not included in the main briefing or get detailed analysis of specific items
When relevant, mention this feature and suggest they open the NOTAMs & MET panel.`;

        // Build user content (supports images and PDFs)
        const userContent = [];
        if (image_base64) {
          userContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
        }
        if (pdf_base64) {
          userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
        }
        userContent.push({ type: 'text', text: question || 'Please analyze the attached document.' });

        const messages = [
          ...(history || []).slice(-6).map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: userContent }
        ];

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1500,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages
          })
        });

        const claudeData = await claudeRes.json();
        if (claudeData.usage) {
          console.log('[CACHE /chat]', {
            input: claudeData.usage.input_tokens,
            output: claudeData.usage.output_tokens,
            cache_created: claudeData.usage.cache_creation_input_tokens || 0,
            cache_read: claudeData.usage.cache_read_input_tokens || 0
          });
        }
        const answer = claudeData.content?.[0]?.text || 'Unable to process question.';

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer }));

      } catch(e) {
        console.error('[CHAT ERROR]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer: 'Error processing request.' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/briefing') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // Plan check before any heavy fetching
        const userId = req.headers['x-user-id'];
        if (userId) {
          const plan = await getUserPlan(userId);
          const usage = await getUserUsage(userId, 'briefings');
          const limit = PLAN_LIMITS[plan]?.briefings || 3;
          if (usage >= limit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan, usage, limit }));
            return;
          }
          await incrementUsage(userId, 'briefings');
          const newUsage = usage + 1;
          const remaining = limit - newUsage;
          if (remaining <= Math.floor(limit * 0.2) && remaining > 0) {
            res.setHeader('x-usage-warning', JSON.stringify({ remaining, limit, feature: 'briefings' }));
          }
        }

        const { icao_dep, icao_arr, notam_text, image_base64, image_type, pdf_base64 } = JSON.parse(body);

        const notamDep = await fetchNotams(icao_dep);
        await new Promise(r => setTimeout(r, 500));
        const notamArr = await fetchNotams(icao_arr);

        // Fetch en-route FIR NOTAMs
        const enrouteNotamData = await getEnrouteNotams(icao_dep, icao_arr);

        const [metarDep, metarArr, tafDep, tafArr] = await Promise.all([
          fetchMetar(icao_dep), fetchMetar(icao_arr),
          fetchTaf(icao_dep), fetchTaf(icao_arr)
        ]);

        const now = new Date();
        const utcDate = now.toUTCString().slice(5, 16).toUpperCase();

        const userMessage = `CRITICAL: Show ALL CRITICAL and HIGH priority NOTAMs for both departure and arrival airports. After critical and high, include medium priority NOTAMs in order of operational importance. Never limit the number of NOTAMs shown. Be concise in each section. Must complete ALL sections including Weather, Pilot Actions, Dispatch Notes, Go/No-Go and Footer.

TODAY'S DATE: ${utcDate}
DEPARTURE: ${icao_dep || 'NOT PROVIDED'} — ${airportName(icao_dep)}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'} — ${airportName(icao_arr)}

LIVE NOTAMs - DEPARTURE (${icao_dep} / ${airportName(icao_dep)}):
${notamDep || 'No active NOTAMs retrieved'}

LIVE NOTAMs - ARRIVAL (${icao_arr} / ${airportName(icao_arr)}):
${notamArr || 'No active NOTAMs retrieved'}

METAR DEPARTURE: ${metarDep || 'Not available'}
METAR ARRIVAL: ${metarArr || 'Not available'}
TAF DEPARTURE: ${tafDep || 'Not available'}
TAF ARRIVAL: ${tafArr || 'Not available'}
${enrouteNotamData ? '\nEN-ROUTE FIR NOTAMs:\n' + enrouteNotamData : '\nEN-ROUTE FIR NOTAMs: No FIR data available — advise crew to check current FIR NOTAMs via official sources.'}
${notam_text ? `\nADDITIONAL USER DATA:\n${notam_text}` : ''}

Generate the complete pre-flight operational intelligence briefing HTML content.`;

        const contentBlocks = [{ type: 'text', text: userMessage }];
        if (image_base64) {
          contentBlocks.push({
            type: 'image',
            source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 }
          });
        }
        if (pdf_base64) {
          contentBlocks.push({
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
          });
        }

        const claudeBody = JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 16000,
          stream: true,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: contentBlocks }]
        });

        // Switch to SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);

        // Send HTML_HEAD and HTML_FOOT to client so it can wrap content
        res.write(`data: ${JSON.stringify({ type: 'init', html_head: HTML_HEAD, html_foot: HTML_FOOT })}\n\n`);

        let doneSent = false;
        streamClaude(claudeBody,
          (text) => { res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
          () => { if (!doneSent) { doneSent = true; res.write('data: {"type":"done"}\n\n'); res.end(); } },
          (err) => { if (!doneSent) { doneSent = true; res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`); res.end(); } }
        );

      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/test-alert') {
    checkNotamAlerts();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Alert check triggered' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.timeout = 120000;
server.listen(PORT, () => {
  console.log(`NOTAM Intelligence server running on port ${PORT}`);
});

// ─── NOTAM ALERT EMAIL SYSTEM ─────────────────────────────────────────────
// Requires env var: RESEND_API_KEY (add to Render environment variables)
// Domain: alerts@notamai.com must be verified in Resend dashboard

async function sendNotamAlert(userEmail, icao, notamText) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: userEmail,
        subject: '⚠️ NOTAM Alert: ' + icao,
        html: `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap" rel="stylesheet">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&display=swap');
</style>
</head>
<body style="margin:0;padding:0;background:#060a0f;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">

    <!-- Logo -->
    <div style="text-align:center;margin-bottom:28px;padding:20px 0;border-bottom:1px solid #1a2a3a;">
      <img src="https://i.imgur.com/HzLqV9P.png"
           alt="NOTAM INTELLIGENCE"
           width="400"
           style="width:400px;max-width:100%;height:auto;display:inline-block;border:0;" />
    </div>

    <!-- Alert header -->
    <div style="background:#0d1520;border:1px solid #1a2a3a;border-left:3px solid #e63946;border-radius:6px;padding:20px;margin-bottom:16px;">
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:10px;color:#e63946;letter-spacing:3px;margin-bottom:10px;">⚠ NEW NOTAM ALERT</div>
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:4px;margin-bottom:6px;">${icao}</div>
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:10px;color:#4a5f72;letter-spacing:1px;">${new Date().toUTCString()}</div>
    </div>

    <!-- NOTAM content -->
    <div style="background:#060a0f;border:1px solid #1a2a3a;border-left:3px solid #4a9eff;border-radius:4px;padding:16px;margin-bottom:20px;overflow:hidden;">
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;">NOTAM · ${icao}</div>
      <pre style="font-family:'Courier New',monospace;font-size:12px;color:#8a9bb0;line-height:1.8;white-space:pre-wrap;word-break:break-word;margin:0;padding:0;">${notamText}</pre>
    </div>

    <!-- Link -->
    <div style="text-align:center;margin-bottom:20px;">
      <span style="font-family:'Courier New','Lucida Console',monospace;font-size:11px;color:#4a5f72;">Check full details at </span><a href="https://notamai.onrender.com" style="font-family:'Courier New','Lucida Console',monospace;font-size:11px;color:#4a9eff;text-decoration:none;">notamai.onrender.com</a>
    </div>

    <!-- Footer -->
    <div style="border-top:1px solid #1a2a3a;padding-top:16px;text-align:center;">
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:10px;color:#4a5f72;letter-spacing:3px;">NOTAM INTELLIGENCE · AI-POWERED AVIATION BRIEFING</div>
      <div style="font-family:'Courier New','Lucida Console',monospace;font-size:10px;color:#4a5f72;margin-top:4px;letter-spacing:1px;">notamai.com</div>
    </div>

  </div>
</body>
</html>`
      })
    });
    const data = await res.json();
    console.log('[ALERT EMAIL]', userEmail, icao, data.id ? 'sent:' + data.id : 'failed');
  } catch(e) {
    console.log('[ALERT EMAIL ERROR]', e.message);
  }
}

async function checkNotamAlerts() {
  console.log('[ALERT CHECK] Running...');
  try {
    const alertsSnap = await adminDb.collection('alerts').where('active', '==', true).get();
    console.log('[ALERT CHECK] Found alerts:', alertsSnap.size);
    if (alertsSnap.empty) { console.log('[ALERT CHECK] No active alerts'); return; }

    for (const alertDoc of alertsSnap.docs) {
      const alert = alertDoc.data();
      const { userId, icao } = alert;
      if (!icao) continue;

      // Get user email from Firebase Auth
      let userEmail = null;
      try {
        const userRecord = await admin.auth().getUser(userId);
        userEmail = userRecord.email;
      } catch(e) {
        console.log('[ALERT CHECK] Could not get user email:', userId, e.message);
        continue;
      }
      if (!userEmail) continue;
      console.log('[ALERT CHECK] User email:', userEmail, 'ICAO:', icao);

      // Fetch latest NOTAMs via SkyLink
      try {
        const data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + icao, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        const notams = data?.notams || data?.data || [];
        console.log('[ALERT CHECK]', icao, 'total NOTAMs from API:', notams.length);
        if (notams.length === 0) continue;

        console.log('[ALERT CHECK] Raw NOTAM sample:', JSON.stringify(notams[0]).slice(0, 200));

        const sampleIds = notams.slice(0, 5).map(n => {
          const raw = n.raw || '';
          const match = raw.match(/([A-Z]\d+\/\d{4})/);
          return match ? match[1] : (n.id || n.notam_id || 'no-id');
        });
        console.log('[ALERT CHECK]', icao, 'sample IDs:', sampleIds.join(', '));

        // Sort NOTAMs to find the most recently issued one
        // NOTAM IDs like A227/2026, B1234/26 - higher number = newer
        const sortedNotams = [...notams].sort((a, b) => {
          const getId = n => {
            const id = n.id || n.notam_id || n.notamNumber || '';
            if (id) {
              const match = id.match(/[A-Z](\d+)\/\d+/);
              return match ? parseInt(match[1]) : 0;
            }
            if (n.raw) {
              const match = n.raw.match(/[A-Z](\d+)\/\d{4}/);
              return match ? parseInt(match[1]) : 0;
            }
            return 0;
          };
          return getId(b) - getId(a); // descending - highest number first
        });

        const latestNotam = sortedNotams[0];
        if (!latestNotam) continue;

        // Extract ID from sorted latest NOTAM
        let latestId = latestNotam.id ||
                       latestNotam.notam_id ||
                       latestNotam.notamNumber ||
                       '';

        if (!latestId && latestNotam.raw) {
          const rawMatch = latestNotam.raw.match(/([A-Z]\d+\/\d{4})/);
          if (rawMatch) latestId = rawMatch[1];
        }

        const lastSentId = alert.lastSentNotamId || '';
        console.log('[ALERT CHECK]', icao, 'latestId:', latestId, 'lastSentId:', lastSentId);

        if (latestId && latestId !== lastSentId) {
          if (!lastSentId) {
            console.log('[ALERT CHECK]', icao, 'First check - saving baseline:', latestId);
            try {
              await alertDoc.ref.update({
                lastSentNotamId: latestId,
                lastChecked: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log('[ALERT CHECK]', icao, 'Baseline saved OK:', latestId);
            } catch(saveErr) {
              console.log('[ALERT CHECK]', icao, 'Baseline save FAILED:', saveErr.message);
            }
          } else {
            console.log('[ALERT CHECK]', icao, 'New NOTAM detected! Sending email...');
            const notamText = latestNotam.raw || latestNotam.text || latestNotam.body || latestId;
            console.log('[SENDING EMAIL]', userEmail, icao);
            await sendNotamAlert(userEmail, icao, notamText);
            try {
              await alertDoc.ref.update({
                lastSentNotamId: latestId,
                lastChecked: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log('[ALERT DEBUG]', icao, 'Firestore updated OK');
            } catch(e) {
              console.log('[ALERT DEBUG]', icao, 'Firestore update FAILED:', e.message);
            }
          }
        } else {
          console.log('[ALERT DEBUG]', icao, 'No change or latestId empty - skipping');
        }
      } catch(e) {
        console.log('[ALERT CHECK ERROR]', icao, e.message);
      }

      // Check SIGMETs for this ICAO (free, no rate limit)
      try {
        console.log('[SIGMET CHECK] Checking', icao);
        const sigmetData = await fetchURL('https://aviationweather.gov/api/data/airsigmet?format=json&hazard=sigmet&icao=' + icao);
        const sigmets = Array.isArray(sigmetData) ? sigmetData : [];

        if (sigmets.length > 0) {
          const latestSigmet = sigmets[0];
          const sigmetId = latestSigmet.airsigmetId || latestSigmet.isigmetId || '';
          const lastSentSigmetId = alert.lastSentSigmetId || '';

          if (sigmetId && sigmetId !== lastSentSigmetId) {
            const sigmetText = latestSigmet.rawAirSigmet || (latestSigmet.hazard + ' ' + latestSigmet.severity) || sigmetId;

            // Send SIGMET alert email
            await sendNotamAlert(userEmail, icao + ' SIGMET', sigmetText);

            // Update Firestore
            await alertDoc.ref.update({
              lastSentSigmetId: sigmetId,
              lastChecked: admin.firestore.FieldValue.serverTimestamp()
            });

            console.log('[SIGMET ALERT]', userEmail, icao, sigmetId);
          }
        }
      } catch(e) {
        console.log('[SIGMET CHECK ERROR]', icao, e.message);
      }

      // Small delay between airports to avoid rate limits
      await new Promise(r => setTimeout(r, 500));
    }
  } catch(e) {
    console.log('[ALERT CHECK MAIN ERROR]', e.message);
  }
}

// Run alert check every 30 minutes
setInterval(checkNotamAlerts, 10 * 60 * 1000);
// Also run once on startup after 30 seconds (allow server to fully initialise)
setTimeout(checkNotamAlerts, 30 * 1000);
