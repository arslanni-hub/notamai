const { init: sentryInit, captureException } = (() => {
  try { return require('@sentry/node'); } catch(e) { return { init: ()=>{}, captureException: ()=>{} }; }
})();
sentryInit({
  dsn: 'https://354cef485cedf29335313fb9736c0350@o4511763434176512.ingest.de.sentry.io/4511763442958416',
  environment: 'production',
  tracesSampleRate: 0.1,
});
// Force redeploy
const https = require('https');
let Imap, simpleParser;
try {
  Imap = require('imap');
  simpleParser = require('mailparser').simpleParser;
  console.log('[SUPPORT AGENT] IMAP packages loaded OK');
} catch(e) {
  console.log('[SUPPORT AGENT] IMAP packages missing:', e.message);
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const risk = require('./risk');
const videoScript = require('./video-script');
const runwayData = require('./runway-data');
// RISK_MODE (Render env): 'shadow' (default) = compute + log only; 'active' = the rubric sets the rating floor, the model
// receives the complete information and the client header is corrected to never fall below the floor.
const RISK_MODE = (process.env.RISK_MODE || 'shadow').toLowerCase();

if (!admin.apps.length) {
  try {
    const serviceAccount = process.env.GA_SERVICE_ACCOUNT_KEY
      ? JSON.parse(process.env.GA_SERVICE_ACCOUNT_KEY)
      : {
          projectId: 'notamai-a9d57',
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
        };
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: 'notamai-a9d57.firebasestorage.app'
    });
    console.log('[FIREBASE] Initialized successfully');
  } catch(e) {
    console.log('[FIREBASE] Init error:', e.message);
  }
}

const adminDb = admin.firestore();
const adminStorage = admin.storage().bucket();

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

// Small/fast model for chat, analysis, route extraction, agents and the general-chat fallback.
// Render env HAIKU_MODEL=claude-haiku-5-5 switches all of them at once; unset = claude-haiku-4-5 (previous behavior).
const HAIKU_MODEL = /^claude-haiku-[a-z0-9.-]+$/i.test(process.env.HAIKU_MODEL || '') ? process.env.HAIKU_MODEL : 'claude-haiku-4-5';
// Haiku 5.5 thinks up front by default; on small calls (max_tokens 50-600) that would eat the whole budget and return no text.
// It accepts thinking:{type:'disabled'} (verified 21 Oct 2026), so every Haiku 5.x request carries it.
const HAIKU_EXTRA = /^claude-haiku-5/i.test(HAIKU_MODEL) ? { thinking: { type: 'disabled' } } : {};

const PLAN_LIMITS = {
  free:    { briefings: 3,   chat: 0,   analysis: 0   },
  pro:     { briefings: 100, chat: 150, analysis: 200  },
  max: { briefings: 150, chat: 400, analysis: 300  },
  admin:   { briefings: 9999, chat: 9999, analysis: 9999 }
};

// Enterprise = Max-level limits per user account (it adds seats, API access and SLA, not bigger per-user caps).
// Every plan-limit lookup goes through this so 'enterprise' never falls through to the Free defaults.
function limitPlanOf(plan) { return plan === 'enterprise' ? 'max' : plan; }

// ── Briefing model per plan ──────────────────────────────────────────────
// Render env BRIEFING_MODEL_FREE / _PRO / _MAX / _ADMIN pick the model per plan (enterprise uses _MAX);
// BRIEFING_MODEL stays as the fallback for non-admin plans, admin falls back to Sonnet 5.5.
function briefingModelFor(plan, usedThisMonth) {
  const own = process.env['BRIEFING_MODEL_' + String(limitPlanOf(plan)).toUpperCase()];
  let picked = own || (plan === 'admin' ? 'claude-sonnet-5-5' : (process.env.BRIEFING_MODEL || 'claude-sonnet-4-6'));
  if (!/^claude-(sonnet|haiku|opus)-[a-z0-9.-]+$/i.test(picked)) picked = 'claude-sonnet-4-6';
  // v3.71 Max hybrid: the first MAX_SONNET_BRIEFINGS briefings of the month use the Max model (Sonnet 5.5); later ones drop to MAX_FALLBACK_MODEL (Haiku 5.5).
  // Only plan 'max' (not Enterprise, not admin); 0 disables the downgrade.
  if (plan === 'max' && /^claude-sonnet-/i.test(picked) && MAX_SONNET_BRIEFINGS > 0 && (usedThisMonth || 0) >= MAX_SONNET_BRIEFINGS) {
    const fb = process.env.MAX_FALLBACK_MODEL || 'claude-haiku-5-5';
    if (/^claude-haiku-[a-z0-9.-]+$/i.test(fb)) picked = fb;
  }
  return picked;
}
const MAX_SONNET_BRIEFINGS = parseInt(process.env.MAX_SONNET_BRIEFINGS || '40', 10);
// USD per million tokens: input, output, cache write (5 min), cache read. Used only for the cost log / briefingCosts records.
const MODEL_PRICES = {
  'claude-sonnet-5-5': [2, 10, 2.5, 0.20],
  'claude-haiku-5-5':  [0.10, 0.50, 0.125, 0.01],
  'claude-sonnet-4-6': [3, 15, 3.75, 0.30],
  'claude-haiku-4-5':  [1, 5, 1.25, 0.10],
};
function briefingCostUsd(model, u) {
  const pr = MODEL_PRICES[model];
  if (!pr || !u) return null;
  return ((u.input_tokens || 0) * pr[0] + (u.output_tokens || 0) * pr[1] + (u.cache_created || 0) * pr[2] + (u.cache_read || 0) * pr[3]) / 1e6;
}

const FREE_DAILY_BRIEFING_CAP = parseInt(process.env.FREE_DAILY_BRIEFING_CAP || '60', 10);
// Global circuit breaker: total Free-plan briefings allowed per UTC day across ALL users.
async function reserveFreeBriefingSlot() {
  const day = new Date().toISOString().slice(0, 10);
  const ref = adminDb.collection('system').doc('free_briefings_' + day);
  try {
    const result = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= FREE_DAILY_BRIEFING_CAP) {
        // Count the Free briefings turned away today: this is the unmet demand the cap is hiding.
        tx.set(ref, { denied: ((snap.exists && snap.data().denied) || 0) + 1, day, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { ok: false, count };
      }
      tx.set(ref, { count: count + 1, day, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, count: count + 1 };
    });
    if (result.ok && FREE_DAILY_BRIEFING_CAP >= 10 && result.count === Math.ceil(FREE_DAILY_BRIEFING_CAP * 0.8)) {
      sendAdminNotification('Free daily briefing cap at 80% (' + result.count + '/' + FREE_DAILY_BRIEFING_CAP + ')',
        '<div style="font-size:13px;color:#1e293b;">The global Free-plan cap reached 80% on ' + day + '. If this keeps happening, check SkyLink usage first (each Free briefing is about 2 calls), then raise FREE_DAILY_BRIEFING_CAP in Render.</div>').catch(() => {});
    }
    if (result.ok && result.count === FREE_DAILY_BRIEFING_CAP) {
      sendAdminNotification('⚠️ Free daily briefing cap reached (' + FREE_DAILY_BRIEFING_CAP + ')',
        '<div style="font-size:13px;color:#1e293b;">The global Free-plan cap of ' + FREE_DAILY_BRIEFING_CAP + ' briefings/day was reached on ' + day + '. Further Free briefings are paused until 00:00 UTC. If this is organic demand, raise FREE_DAILY_BRIEFING_CAP in Render; if it looks like abuse, check new signups.</div>').catch(() => {});
    }
    return result.ok;
  } catch (e) {
    console.log('[FREE CAP] transaction error, allowing request:', e.message);
    return true;
  }
}

// Raw NOTAM lookups (NOTAMs & MET panel) cost one SkyLink call each, so they need a signed-in user and a per-user daily cap.
const RAW_NOTAM_DAILY_FREE = parseInt(process.env.RAW_NOTAM_DAILY_FREE || '10', 10);
const RAW_NOTAM_DAILY_PAID = parseInt(process.env.RAW_NOTAM_DAILY_PAID || '100', 10);
async function reserveRawNotamLookup(userId, plan) {
  if (plan === 'admin') return { ok: true };
  const limit = plan === 'free' ? RAW_NOTAM_DAILY_FREE : RAW_NOTAM_DAILY_PAID;
  const day = new Date().toISOString().slice(0, 10);
  const ref = adminDb.collection('rawNotamDaily').doc(userId + '_' + day);
  try {
    return await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= limit) return { ok: false, count, limit };
      tx.set(ref, { count: count + 1, userId, day, plan, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, count: count + 1, limit };
    });
  } catch (e) {
    console.log('[RAW NOTAM LIMIT] transaction error, allowing request:', e.message);
    return { ok: true };
  }
}

// General Aviation Expert Chat — separate from the briefing-specific "Ask NOTAM AI" above.
// Uses a 3-hour rolling window, mirroring Claude's own usage-limit UX: soft limits that
// downgrade the model rather than hard-block (except Free, which hard-stops since it's
// already a thin "taste" tier with no Firestore persistence).
// All plans use token budgets over a 5-hour rolling window (matching Claude's own
// usage window). softLimitRatio is the fraction of the budget at which Pro/Max
// silently downgrade from Sonnet to Haiku (cheaper model, same total budget still
// hard-caps at 100% — this isn't a separate allowance, just a quality step-down within
// the existing budget). Free has no soft limit since it's Haiku-only already; it hard-stops
// at 100% of its small token budget.
const GENERAL_CHAT_LIMITS = {
  free:    { windowMinutes: 300, limit: 1000,    mode: 'tokens', model: HAIKU_MODEL },
  pro:     { windowMinutes: 300, limit: 24000,  mode: 'tokens', model: 'claude-sonnet-5-5', softLimitRatio: 0.70 },
  max: { windowMinutes: 300, limit: 48000,  mode: 'tokens', model: 'claude-sonnet-5-5', softLimitRatio: 0.70 },
  admin:   { windowMinutes: 300, limit: 999999, mode: 'tokens', model: 'claude-sonnet-5-5' }
};
const GENERAL_CHAT_FALLBACK_MODEL = HAIKU_MODEL;

// Web search for General Aviation Expert Chat — Pro/Max only. The flat $0.01/search
// fee is NOT covered by the token-budget rate limit below (only token cost is), so we gate
// by plan rather than opening it to Free, whose budget is too thin to absorb an uncounted
// per-search fee. max_uses is a hard ceiling on searches per question, for cost/latency control.
const GENERAL_CHAT_WEB_SEARCH_PLANS = ['pro', 'max', 'admin'];
const GENERAL_CHAT_WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 3 };
// Hard ceiling on searches per 5-hour window, independent of the token budget above. The
// flat $0.01/search fee isn't proportional to tokens, so a token-only gate doesn't bound it.
// Once reached — OR once the user is already past the token soft-limit threshold (the same
// signal that downgrades Sonnet to Haiku) — search silently turns off for the rest of that
// window; chat keeps answering normally, just without search. Never blocks the user.
const GENERAL_CHAT_WEB_SEARCH_CAP = { pro: 3, max: 6, admin: 10 };

async function getGeneralChatWindowUsage(userId, windowMinutes) {
  try {
    const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000);
    const snapshot = await adminDb.collection('general_chat_rate_limit')
      .where('userId', '==', userId)
      .where('createdAt', '>', cutoff)
      .get();
    let oldestTimestamp = null;
    let tokenTotal = 0;
    let searchTotal = 0;
    snapshot.forEach(doc => {
      const data = doc.data();
      const ts = data.createdAt;
      if (!oldestTimestamp || ts.toMillis() < oldestTimestamp.toMillis()) oldestTimestamp = ts;
      tokenTotal += (data.tokens || 0);
      searchTotal += (data.searchCount || 0);
    });
    return { count: snapshot.size, tokenTotal, searchTotal, oldestTimestamp };
  } catch(e) {
    console.error('[GENERAL CHAT RATE LIMIT] Usage check error:', e.message);
    return { count: 0, tokenTotal: 0, searchTotal: 0, oldestTimestamp: null };
  }
}

async function recordGeneralChatRateLimitEntry(userId, tokens, searchCount) {
  try {
    await adminDb.collection('general_chat_rate_limit').add({
      userId,
      tokens: tokens || 0,
      searchCount: searchCount || 0,
      createdAt: new Date()
    });
  } catch(e) {
    console.error('[GENERAL CHAT RATE LIMIT] Record error:', e.message);
  }
}

function minutesUntilWindowReset(oldestTimestamp, windowMinutes) {
  if (!oldestTimestamp) return 0;
  const oldestMs = oldestTimestamp.toDate ? oldestTimestamp.toDate().getTime() : new Date(oldestTimestamp).getTime();
  const resetAt = oldestMs + windowMinutes * 60 * 1000;
  return Math.max(0, Math.ceil((resetAt - Date.now()) / 60000));
}

async function getUserPlan(userId) {
  try {
    const userRecord = await admin.auth().getUser(userId);
    const ADMIN_EMAILS = ['arslanni@gmail.com', 'admin@notamai.com'];
    if (ADMIN_EMAILS.includes(userRecord.email) && userRecord.emailVerified) return 'admin';
    const doc = await adminDb.collection('users').doc(userId).get();
    const rawPlan = doc.exists ? (doc.data().plan || 'free') : 'free';
    const plan = ['free','pro','max','enterprise','admin'].includes(rawPlan) ? rawPlan : 'free';   // legacy values (e.g. 'premium') count as free
    console.log('[PLAN CHECK]', userId, 'plan:', plan);
    return plan;
  } catch(e) {
    console.log('[PLAN CHECK] Error for', userId, ':', e.message);
    return 'free';
  }
}

async function getVerifiedUserId(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(h.slice(7));
    // Email/password accounts must verify their address before using any metered feature.
    // Google sign-in accounts arrive with email_verified=true, so they pass untouched.
    if (decoded.firebase?.sign_in_provider === 'password' && !decoded.email_verified) {
      req._authError = 'email_not_verified';
      return null;
    }
    return decoded.uid;
  } catch (e) { return null; }
}
function sendUnauthorized(res, req) {
  if (req && req._authError === 'email_not_verified') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'email_not_verified' }));
    return;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

const Stripe = require('stripe');
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://notamai.onrender.com';
const STRIPE_PRICES = {
  pro: { month: process.env.STRIPE_PRICE_PRO_MONTHLY, year: process.env.STRIPE_PRICE_PRO_YEARLY },
  max: { month: process.env.STRIPE_PRICE_MAX_MONTHLY, year: process.env.STRIPE_PRICE_MAX_YEARLY }
};
function planFromPriceId(priceId) {
  for (const [plan, p] of Object.entries(STRIPE_PRICES)) {
    if (priceId && (priceId === p.month || priceId === p.year)) return plan;
  }
  return null;
}
async function findUserByStripeCustomer(customerId) {
  if (!customerId) return null;
  const snap = await adminDb.collection('users').where('stripeCustomerId', '==', customerId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}
async function syncStripeSubscription(sub, fallbackUid) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const uid = sub.metadata?.user_id || fallbackUid || await findUserByStripeCustomer(customerId);
  if (!uid) { console.log('[STRIPE] No user found for subscription', sub.id); return; }
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  const newPlan = active ? planFromPriceId(priceId) : 'free';
  const ref = adminDb.collection('users').doc(uid);
  const snap = await ref.get();
  const cur = snap.exists ? snap.data() : {};
  const update = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: sub.id,
    subscriptionStatus: sub.status,
    billingInterval: item?.price?.recurring?.interval || 'month',
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    trialUsed: true
  };
  if (!newPlan) {
    console.log('[STRIPE] Active subscription with unknown price id — plan NOT changed:', priceId);
  } else if (cur.plan !== newPlan) {
    update.plan = newPlan;
    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  }
  await ref.set(update, { merge: true });
  console.log('[STRIPE] Synced', uid, sub.status, '->', newPlan || '(unchanged)');
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

// Give back one unit (e.g. a video briefing that failed before or while rendering). Never goes below zero.
async function decrementUsage(userId, field, when) {
  try {
    const d = when instanceof Date && !isNaN(when) ? when : new Date();
    const monthKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const ref = adminDb.collection('usage').doc(userId + '_' + monthKey);
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? (snap.data()[field] || 0) : 0;
      if (cur > 0) tx.set(ref, { [field]: cur - 1 }, { merge: true });
    });
  } catch (e) { console.log('[USAGE] decrement error:', e.message); }
}

// ── Video briefing completion (server side) ─────────────────────────────────────────────────────────────────────────────────────────
// A video must reach the user's archive even if the page was closed while it rendered: the server watches every started video itself.
// finalizeVideo() is the single place that reads the WaveSpeed result and settles the Firestore record (completed / failed + refund,
// each exactly once, transaction-guarded), so the page's own polling and the server watcher can run side by side safely.
function wavespeedResult(predId) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'api.wavespeed.ai',
      path: '/api/v3/predictions/' + encodeURIComponent(predId) + '/result',
      headers: { 'Authorization': 'Bearer ' + process.env.WAVESPEED_KEY }
    }, statusRes => {
      let data = '';
      statusRes.on('data', chunk => data += chunk);
      statusRes.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: 'Parse error' }); } });
    }).on('error', reject);
  });
}

async function finalizeVideo(predId) {
  const result = await wavespeedResult(predId);
  const status = result?.data?.status;
  const videoUrl = result?.data?.outputs?.[0];
  let script = null;
  try {
    const videoQuery = await adminDb.collection('videos').where('predictionId', '==', predId).limit(1).get();
    if (!videoQuery.empty) {
      const ref = videoQuery.docs[0].ref;
      const vdata = videoQuery.docs[0].data();
      script = vdata.script || null;
      // Render failed: give the Max credit back exactly once
      if (status === 'failed') {
        try {
          const owner = await adminDb.runTransaction(async tx => {
            const snap = await tx.get(ref); const d = snap.data() || {};
            if (d.refunded) return null;
            tx.update(ref, { status: 'failed', refunded: true, failedAt: admin.firestore.FieldValue.serverTimestamp() });
            return d;
          });
          if (owner && owner.userId) { await decrementUsage(owner.userId, 'video', owner.createdAt && owner.createdAt.toDate ? owner.createdAt.toDate() : null); console.log('[VIDEO] render failed, credit restored:', predId); }
        } catch (e) { console.log('[VIDEO] refund error:', e.message); }
      }
      // Completed: claim the record once, then archive in the background (download + Firebase Storage upload never delays the answer)
      if (status === 'completed' && videoUrl && vdata.status !== 'completed') {
        const claimed = await adminDb.runTransaction(async tx => {
          const snap = await tx.get(ref); const d = snap.data() || {};
          if (d.status === 'completed') return false;
          tx.update(ref, { status: 'completed', wavespeedUrl: videoUrl, videoUrl, completedAt: admin.firestore.FieldValue.serverTimestamp() });
          return true;
        });
        if (claimed) {
          const startedMs = vdata.createdAt && vdata.createdAt.toMillis ? vdata.createdAt.toMillis() : null;
          console.log('[VIDEO TIMING] WaveSpeed completed', startedMs ? Math.round((Date.now() - startedMs) / 1000) + ' s after the request started' : '', 'timings:', JSON.stringify(result?.data?.timings || result?.data?.executionTime || null));
          const ownerId = vdata.userId || 'unknown';
          (async () => {
            let storageUrl = videoUrl;
            try {
              const videoResponse = await fetch(videoUrl);
              if (videoResponse.ok) {
                const buffer = Buffer.from(await videoResponse.arrayBuffer());
                const fileName = 'videos/' + ownerId + '/' + predId + '.mp4';
                const file = adminStorage.file(fileName);
                await file.save(buffer, { metadata: { contentType: 'video/mp4' } });
                await file.makePublic();
                storageUrl = 'https://storage.googleapis.com/notamai-a9d57.firebasestorage.app/' + fileName;
                console.log('[VIDEO STORAGE] Uploaded to Firebase:', fileName);
              }
            } catch (uploadErr) {
              console.log('[VIDEO STORAGE] Upload failed, using Wavespeed URL:', uploadErr.message);
            }
            await ref.update({ videoUrl: storageUrl }).catch(() => {});
            console.log('[VIDEO ARCHIVE] Saved:', predId);
          })();
        }
      }
    }
  } catch (e) { console.log('[VIDEO] Firestore update error:', e.message); }
  return { status, videoUrl, script };
}

// Server-side watcher for one started video: first look after 60 s, then every 20 s, for up to 20 minutes.
function watchVideo(predId) {
  const deadline = Date.now() + 20 * 60 * 1000;
  const tick = async () => {
    try { const r = await finalizeVideo(predId); if (r.status === 'completed' || r.status === 'failed') return; } catch (e) { /* try again */ }
    if (Date.now() < deadline) setTimeout(tick, 20000);
  };
  setTimeout(tick, 60000);
}

// After a restart or deploy: settle videos that were still rendering. A job that is neither finished nor failed after 6 h is marked expired.
async function resumeUnfinishedVideos() {
  try {
    const snap = await adminDb.collection('videos').where('status', '==', 'processing').limit(30).get();
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.predictionId) continue;
      const r = await finalizeVideo(d.predictionId).catch(() => ({}));
      if (r.status === 'completed' || r.status === 'failed') continue;
      const ageMs = d.createdAt && d.createdAt.toMillis ? Date.now() - d.createdAt.toMillis() : 0;
      if (ageMs > 6 * 3600 * 1000) await doc.ref.update({ status: 'expired' }).catch(() => {});
      else watchVideo(d.predictionId);
    }
    if (snap.size) console.log('[VIDEO] resumed/settled', snap.size, 'unfinished video(s) after start');
  } catch (e) { console.log('[VIDEO] resume error:', e.message); }
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY; // Fallback provider

// Provider abstraction
// Decodes items B) and C) of a raw NOTAM on the server so the model never has to read YYMMDDHHMM itself
// (a Haiku analysis once read 2610212130 as 21 Feb 2026). Returns '' when the text has no parsable B) item.
function notamTimeContext(raw, now) {
  const MON = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const parse = (s) => {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s || '');
    if (!m) return null;
    const mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59) return null;
    const date = new Date(Date.UTC(2000 + (+m[1]), mo - 1, d, h === 24 ? 24 : h, mi));
    return { date, text: String(d).padStart(2, '0') + ' ' + MON[mo - 1] + ' ' + (2000 + (+m[1])) + ' ' + String(h).padStart(2, '0') + ':' + m[5] + ' UTC' };
  };
  const text = String(raw || '');
  const b = /(?:^|\s)B\)\s*(\d{10})/.exec(text);
  const c = /(?:^|\s)C\)\s*(\d{10}|PERM)(\s*EST)?/.exec(text);
  const from = b ? parse(b[1]) : null;
  if (!from) return '';
  const nowD = now || new Date();
  const lines = ['PARSED TIMES (computed by the server from items B and C; authoritative, do not re-decode):', 'Current time: ' + nowD.toISOString().slice(0, 16).replace('T', ' ') + ' UTC', 'Effective (B): ' + from.text];
  let status;
  if (c && c[1] === 'PERM') { lines.push('Expires (C): permanent'); status = nowD >= from.date ? 'in force (permanent)' : 'not yet in force'; }
  else {
    const to = c ? parse(c[1]) : null;
    if (to) {
      lines.push('Expires (C): ' + to.text + (c[2] ? ' (estimated)' : ''));
      const hrs = Math.round((to.date - from.date) / 360000) / 10;
      lines.push('Duration: ' + hrs + ' h');
      status = nowD < from.date ? 'not yet in force (future)' : nowD <= to.date ? 'in force now' : 'expired';
    } else status = nowD >= from.date ? 'in force' : 'not yet in force';
  }
  lines.push('Status now: ' + status);
  return '\n\n' + lines.join('\n');
}

async function callAI({ model = HAIKU_MODEL, maxTokens = 1000, messages, system }) {
  // Try Anthropic first
  try {
    const body = { model, max_tokens: maxTokens, messages };
    if (/^claude-haiku-5/i.test(model)) body.thinking = { type: 'disabled' };
    if (system) body.system = system;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('Anthropic HTTP ' + res.status);
    const data = await res.json();
    if (!data.content?.[0]?.text) throw new Error('Anthropic empty response');
    return { text: data.content[0].text, provider: 'anthropic' };
  } catch(e) {
    console.log('[AI PROVIDER] Anthropic failed:', e.message, '— trying fallback...');

    // Notify admin
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: 'admin@notamai.com',
        subject: '🚨 Anthropic API Failed — Fallback Activated',
        html: `<div style="font-family:monospace;padding:20px;background:#f0f4f8;"><h3 style="color:#dc2626;">Anthropic API Failed</h3><p>Error: ${e.message}</p><p>Time: ${new Date().toUTCString()}</p><p style="color:#dc2626;">Manual review recommended — check Anthropic status at status.anthropic.com</p></div>`
      })
    }).catch(() => {});

    // Try OpenAI fallback if key exists
    if (!OPENAI_KEY) throw new Error('Anthropic failed and no fallback key configured');

    try {
      const openaiMessages = [];
      if (system) openaiMessages.push({ role: 'system', content: system });
      messages.forEach(m => openaiMessages.push(m));
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: maxTokens, messages: openaiMessages })
      });
      if (!res.ok) throw new Error('OpenAI HTTP ' + res.status);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('OpenAI empty response');
      console.log('[AI PROVIDER] OpenAI fallback succeeded');
      return { text, provider: 'openai' };
    } catch(e2) {
      console.log('[AI PROVIDER] OpenAI fallback also failed:', e2.message);
      throw new Error('All AI providers failed: ' + e.message + ' | ' + e2.message);
    }
  }
}
const NOTAMIFY_KEY = process.env.NOTAMIFY_KEY;
const PORT = process.env.PORT || 3000;

// Airport name cache — populated via SkyLink exact-ICAO lookup
const airportNameCache = {};

async function fetchAndCacheAirportName(icao) {
  if (!icao) return icao;
  const code = icao.toUpperCase();
  if (airportNameCache[code]) return airportNameCache[code];
  try {
    // Use SkyLink text search — same source as Tools panel, reliable for all regions
    const data = await fetchURL('https://skylink-api.p.rapidapi.com/airports/search/text?q=' + encodeURIComponent(code) + '&limit=5', {
      headers: {
        'X-RapidAPI-Key': process.env.SKYLINK_KEY,
        'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
      }
    });
    const airports = Array.isArray(data) ? data : (data?.airports || data?.results || []);
    // Find exact ICAO match
    const exact = airports.find(a => (a.icao || a.ident || '').toUpperCase() === code);
    if (exact && exact.name) {
      const name = [exact.name, exact.city || exact.municipality, exact.country || exact.iso_country].filter(Boolean).join(', ');
      airportNameCache[code] = name;
      console.log('[AIRPORT CACHE] SkyLink verified:', code, '=', name);
      return name;
    }
  } catch(e) {
    console.log('[AIRPORT CACHE] SkyLink lookup failed for', code, e.message);
  }
  // Fallback — return ICAO code only, never guess
  airportNameCache[code] = code;
  return code;
}

function airportName(icao) {
  // Synchronous fallback — returns cached value or ICAO code
  if (!icao) return '';
  const code = icao.toUpperCase();
  return airportNameCache[code] || code;
}

function fetchURLRaw(url, options = {}) {
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

// ── SkyLink gateway: counts real upstream calls, caches static reference data, dedupes in-flight requests
const SKYLINK_ORIGIN = 'https://skylink-api.p.rapidapi.com';
const SKYLINK_STATIC_TTL_MS = 12 * 60 * 60 * 1000;
const SKYLINK_STATIC_PATHS = ['/airports/search', '/charts/', '/navaids', '/distance', '/ml/flight-time', '/aircraft/performance', '/aircraft/registration', '/routes/airport', '/carbon/estimate'];
const skylinkCache = new Map();
// Airport / FIR NOTAM responses: short shared cache (the provider recommends 2-5 min) so a briefing, the raw NOTAM panel and the alert
// checker never pay twice for the same airport. airportNotamStore keeps the newest REAL provider response per airport for the alert diff.
const SKYLINK_NOTAM_TTL_MS = 5 * 60 * 1000;
const airportNotamStore = new Map();   // ICAO/FIR -> { t, data }
const skylinkInflight = new Map();
const skylinkPending = {};
let skylinkFlushTimer = null;

function skylinkCategory(path) {
  if (path.startsWith('/notams/')) return 'notams';
  if (path.startsWith('/airports/')) return 'airports';
  if (path.startsWith('/delays/')) return 'delays';
  if (path.startsWith('/weather/')) return 'weather';
  if (path.startsWith('/charts/')) return 'charts';
  return 'other';
}

function trackSkylinkCall(category) {
  skylinkPending[category] = (skylinkPending[category] || 0) + 1;
  if (!skylinkFlushTimer) skylinkFlushTimer = setTimeout(flushSkylinkUsage, 30 * 1000);
}

async function flushSkylinkUsage() {
  skylinkFlushTimer = null;
  const pending = { ...skylinkPending };
  Object.keys(skylinkPending).forEach(k => delete skylinkPending[k]);
  const added = Object.values(pending).reduce((a, b) => a + b, 0);
  if (!added) return;
  const monthKey = new Date().toISOString().slice(0, 7);
  const limit = parseInt(process.env.SKYLINK_MONTHLY_LIMIT || '1000', 10);
  try {
    const ref = adminDb.collection('system').doc('skylink_usage');
    const warnings = await adminDb.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : {};
      const same = cur.month === monthKey;
      const count = (same ? (cur.count || 0) : 0) + added;
      const bySource = same ? { ...(cur.bySource || {}) } : {};
      for (const [k, v] of Object.entries(pending)) bySource[k] = (bySource[k] || 0) + v;
      const warned = same ? (cur.warned || []) : [];
      const pct = Math.round((count / limit) * 100);
      const fresh = [70, 90].filter(t => pct >= t && !warned.includes(t));
      tx.set(ref, { count, month: monthKey, limit, pct, bySource, warned: [...warned, ...fresh], updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return fresh.map(t => ({ t, pct, count }));
    });
    for (const w of warnings) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'NOTAM Intelligence <alerts@notamai.com>',
          to: 'admin@notamai.com',
          subject: w.t >= 90 ? '🚨 URGENT: SkyLink API at 90% — Upgrade Now' : '⚠️ SkyLink API at 70% — Plan Ahead',
          html: `<div style="font-family:monospace;padding:20px;">SkyLink usage: ${w.pct}% (${w.count}/${limit}). Upgrade the RapidAPI plan and update SKYLINK_MONTHLY_LIMIT in Render.</div>`
        })
      });
    }
  } catch (e) { console.log('[SKYLINK USAGE] flush error:', e.message); }
}

function fetchURL(url, options = {}) {
  if (!url.startsWith(SKYLINK_ORIGIN)) return fetchURLRaw(url, options);
  const path = url.slice(SKYLINK_ORIGIN.length).split('?')[0];
  const isStatic = SKYLINK_STATIC_PATHS.some(p => path.startsWith(p));
  const notamMatch = /^\/notams\/([A-Za-z0-9]{3,4})$/.exec(path);
  if (isStatic || notamMatch) {
    const hit = skylinkCache.get(url);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.data);
  }
  const running = skylinkInflight.get(url);
  if (running) return running;
  const p = (async () => {
    trackSkylinkCall(skylinkCategory(path));
    const data = await fetchURLRaw(url, options);
    const ok = data && typeof data === 'object' && !data.error && !data.message;
    if (isStatic && ok) {
      if (skylinkCache.size > 2000) skylinkCache.clear();
      skylinkCache.set(url, { expires: Date.now() + SKYLINK_STATIC_TTL_MS, data });
    }
    if (notamMatch && skylinkNotamsOk(data)) {   // only genuine NOTAM responses (never quota / outage replies) are cached or stored
      if (skylinkCache.size > 2000) skylinkCache.clear();
      skylinkCache.set(url, { expires: Date.now() + SKYLINK_NOTAM_TTL_MS, data });
      if (airportNotamStore.size > 1500) airportNotamStore.clear();
      airportNotamStore.set(notamMatch[1].toUpperCase(), { t: Date.now(), data });
    }
    return data;
  })().finally(() => skylinkInflight.delete(url));
  skylinkInflight.set(url, p);
  return p;
}

function classifyNotamSeverity(raw) {
  const t = (raw || '').toUpperCase();
  if (/RWY.*CLSD|CLSD.*RWY|U\/S|UNSERVICEABLE|JAMM|EMERG ONLY|PROHIBITED|TRIGGER/.test(t)) return 'CRITICAL';
  if (/TWY.*CLSD|ILS|VOR|NDB|GNSS|GPS|MILITARY|TFR|RESTRICTED|DANGER/.test(t)) return 'HIGH';
  if (/LGT.*U\/S|PAPI|VASI|OBST|CRANE|TOWER|TAXIWAY/.test(t)) return 'MEDIUM';
  return 'LOW';
}

function notamRecencyKey(n) {
  const src = n.notam_id || n.id || n.raw || n.body || '';
  const m = src.match(/[A-Z](\d+)\/(\d{2,4})/);
  if (!m) return 0;
  const yr = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  return yr * 100000 + parseInt(m[1]);
}

// SkyLink returns an object with a `notams` ARRAY on success (an empty array means genuinely no NOTAMs).
// Anything else (quota exceeded, upstream error, non-JSON) is a PROVIDER FAILURE and must never be shown as "no NOTAMs".
function skylinkNotamsOk(data) { return !!data && typeof data === 'object' && Array.isArray(data.notams); }
// Video provider failures (WaveSpeed / ElevenLabs): one e-mail per provider per 6 hours, so a drained balance is noticed before customers complain.
const lastVideoProviderMail = {};
function notifyVideoProviderFailure(provider, status, detail) {
  if (Date.now() - (lastVideoProviderMail[provider] || 0) < 6 * 60 * 60 * 1000) return;
  lastVideoProviderMail[provider] = Date.now();
  const esc = t => String(t == null ? '' : t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).slice(0, 400);
  sendAdminNotification('🚨 Video briefing: ' + provider + ' request failed',
    '<div style="font-size:13px;color:#1e293b;">A video briefing could not start because ' + provider + ' rejected the request (HTTP ' + esc(status) + '). Most likely the account balance or monthly quota is used up — check the ' + provider + ' dashboard and top up. Max users get their video credit back automatically and see "Your video credit was not used".<br><br><span style="color:#64748b;">Provider response: ' + esc(detail) + '</span><br><span style="color:#64748b;">This e-mail is sent at most once every 6 hours per provider.</span></div>').catch(() => {});
}
let lastSkylinkFailMail = 0;
function notifySkylinkFailure(icao) {
  if (Date.now() - lastSkylinkFailMail < 6 * 60 * 60 * 1000) return;
  lastSkylinkFailMail = Date.now();
  sendAdminNotification('🚨 SkyLink returned no NOTAM data',
    '<div style="font-size:13px;color:#1e293b;">SkyLink returned no NOTAM data for ' + icao + '. Likely the monthly RapidAPI quota is exhausted or the provider is down. Briefings and the NOTAM panel now show "NOTAM DATA UNAVAILABLE". Check RapidAPI usage and upgrade the plan if needed.</div>').catch(() => {});
}

// Risk rubric wiring: runs after NOTAM / METAR / TAF / FIR data has been fetched. Never throws into the briefing flow.
async function computeBriefingRisk({ icao_dep, icao_arr, isSingleAirport, notamDepResult, notamArrResult, enrouteCollector, metarDep, metarArr, tafDep, tafArr }) {
  const unavailable = (notamDepResult && notamDepResult.unavailable) || (!isSingleAirport && notamArrResult && notamArrResult.unavailable);
  if (unavailable) { console.log('[RISK] skipped — NOTAM data unavailable'); return null; }
  const build = async (icao, role, res, metar, taf) => ({
    icao, role, metar, taf,
    notams: [...((res && res.activeItems) || []), ...((res && res.nearFutureItems) || [])],
    shownIds: (res && res.shownIds) || [],
    cardCap: isSingleAirport ? 5 : 3,
    runwaySources: await runwayData.getRunwaySources(icao, { fetchJson: fetchURL }),
  });
  const jobs = [build(icao_dep, isSingleAirport ? 'APT' : 'DEP', notamDepResult, metarDep, tafDep)];
  if (!isSingleAirport) jobs.push(build(icao_arr, 'ARR', notamArrResult, metarArr, tafArr));
  const airports = await Promise.all(jobs);
  // Aerodrome positions let the rubric ignore en-route restrictions that are nowhere near the planned route.
  let route = null;
  if (!isSingleAirport) {
    const [pd, pa] = await Promise.all([
      runwayData.getAirportPosition(icao_dep, { fetchJson: fetchURL }),
      runwayData.getAirportPosition(icao_arr, { fetchJson: fetchURL }),
    ]);
    if (pd && pa) route = { dep: pd, arr: pa };
  }
  // FIRs the great-circle track passes through (and those within the corridor) — used by the conflict-zone check. Never blocks the briefing.
  let routeFirList = null;
  if (route) { try { routeFirList = require('./route-firs').routeFirs(route.dep, route.arr); } catch (e) { console.warn('route FIR calc failed:', e.message); } }
  const input = { now: new Date(), airports, enroute: enrouteCollector || [], route, routeFirs: routeFirList ? routeFirList.track : [], routeNearFirs: routeFirList ? routeFirList.near : [] };
  const r = risk.assessRisk(input);
  r.route = route;
  r.modelBlock = risk.buildModelBlock(input, r);
  console.log('[RISK]', JSON.stringify({
    mode: RISK_MODE,
    route: icao_dep + (isSingleAirport ? '' : '-' + icao_arr),
    level: r.level, score: r.score, verdict: r.verdict, override: r.override, concentration: r.concentration, counts: r.counts,
    runway: r.runwayInfo,
    runwaySources: Object.fromEntries(airports.map(a => [a.icao, (a.runwaySources || []).map(x => x.name + ' ' + x.count + ': ' + (x.keys || []).join('|'))])),
    routeGeometry: !!route,
    fir: (enrouteCollector || []).map(x => x.fir + ':' + (x.notams || []).length),
    watch: (r.enrouteWatch || []).length + airports.reduce((n, a) => n + (((r.airportRows || {})[a.icao] || []).filter(x => x.watch).length), 0),
    blockChars: r.modelBlock.length,
    factors: r.factors.slice(0, 30).map(f => `T${f.tier} ${f.label}${f.ids && f.ids.length ? ' [' + f.ids.slice(0, 6).join(',') + (f.ids.length > 6 ? ' +' + (f.ids.length - 6) + ' more' : '') + ']' : ''}`),
  }));
  console.log('[RISK BLOCK]\n' + r.modelBlock.slice(0, 3500));
  return r;
}

async function calibrationExport(dep, arr) {
      const notamDepResult = await fetchNotams(dep);
      const [metarDep, tafDep] = await Promise.all([fetchMetar(dep), fetchTaf(dep)]);
      await new Promise(r => setTimeout(r, 500));
      const notamArrResult = await fetchNotams(arr);
      const enrouteCollector = [];
      await getEnrouteNotams(dep, arr, enrouteCollector, { includeDomestic: RISK_MODE === 'active' });
      const [metarArr, tafArr] = await Promise.all([fetchMetar(arr), fetchTaf(arr)]);
      const now = new Date();
      const stamp = now.toISOString().replace(/[:T]/g, '').slice(0, 13) + 'Z';
      const r = await computeBriefingRisk({ icao_dep: dep, icao_arr: arr, isSingleAirport: false, notamDepResult, notamArrResult, enrouteCollector, metarDep, metarArr, tafDep, tafArr });
      const system = { route: dep + '-' + arr, snapshotUtc: now.toISOString(), rubric: r ? { level: r.level, score: r.score, verdict: r.verdict, override: r.override, counts: r.counts, factors: (r.factors || []).map(f => ({ tier: f.tier, label: f.label, ids: f.ids || [] })) } : null };
      const cfg = risk.CONFIG;
      const status = n => { try { const w = risk.windowStatus(n, now, cfg); if (w.inWindow) return 'IN FORCE IN THE NEXT ' + cfg.windowHours + ' H'; return w.reason === 'later' ? 'STARTS LATER' : (w.reason === 'expired' ? 'EXPIRED' : 'VALID, BUT NOT IN FORCE IN THE NEXT ' + cfg.windowHours + ' H (scheduled days only)'); } catch (e) { return 'STATUS UNKNOWN'; } };
      const block = n => '[' + status(n) + ']\n' + String(n.raw || n.body || '').trim();
      const apt = (icao, res_, metar, taf, role) => {
        const items = [].concat((res_ && res_.activeItems) || [], (res_ && res_.nearFutureItems) || []);
        return '## ' + role + ' ' + icao + '\n\nMETAR: ' + (metar || 'n/a') + '\nTAF: ' + (taf || 'n/a') + '\n\nNOTAMs (' + items.length + '):\n\n' + (items.map(block).join('\n\n') || '(none)') + '\n';
      };
      const enr = enrouteCollector.map(c => {
        const all = c.notams || [];
        const inw = all.filter(n => { try { return risk.windowStatus(n, now, cfg).inWindow; } catch (e) { return false; } });
        const pick = inw.filter(n => { const t = String(n.raw || n.body || ''); const qc = (/Q\)\s*\w{4}\/Q(\w{4})/.exec(t) || [])[1] || ''; return /^[RWG]/.test(qc) || /GNSS|GPS|JAMM|SPOOF|PROHIB/i.test(t) || (/^N/.test(qc) && /U\/S|UNSERVICEABLE/i.test(t)); });
        const prio = n => { const t = String(n.raw || n.body || ''); const qc = (/Q\)\s*\w{4}\/Q(\w{4})/.exec(t) || [])[1] || ''; return (/GNSS|GPS|JAMM|SPOOF/i.test(t) || /^QRP|^QRT/.test('Q' + qc) ? 0 : 1); };
        pick.sort((a, b) => prio(a) - prio(b));
        const cap = 12, shown = pick.slice(0, cap);
        return '### FIR ' + c.fir + ' — ' + all.length + ' NOTAMs published, ' + inw.length + ' in force in the next ' + cfg.windowHours + ' h; ' + pick.length + ' of those are airspace-restriction / warning / GNSS / navaid-U/S type' + (pick.length > cap ? ' (first ' + cap + ' shown, GNSS and prohibited/danger first)' : '') + '\n\n' + (shown.map(block).join('\n\n') || '(none of these types)') + '\n';
      });
      const md = '# BLIND RATER PACKET — ' + dep + ' → ' + arr + '\n\nSnapshot (UTC): ' + now.toISOString() + '\nWindow assessed: the next ' + cfg.windowHours + ' h from the snapshot. The bracketed status above each NOTAM is plain date/time arithmetic against the snapshot (B/C and D items), not a risk judgement.\nEn-route: NOTAMs of the FIRs the route is expected to cross; FIR selection is approximate. Only airspace-restriction, warning, GNSS and navaid-unserviceable types are listed (selection is by type, not by any score); all other FIR NOTAMs are omitted.\n\n' + apt(dep, notamDepResult, metarDep, tafDep, 'DEPARTURE') + '\n' + apt(arr, notamArrResult, metarArr, tafArr, 'ARRIVAL') + '\n## EN-ROUTE\n\n' + enr.join('\n') + '\n';
      return { now, stamp, system, md };
}

async function fetchNotams(icao) {
  if (!icao) return { text: '', total: 0, shown: 0 };
  try {
    // include_future=true — without this, SkyLink's API silently omits NOTAMs whose effective
    // (start) time hasn't arrived yet, even though they're published and will become active soon.
    const url = `https://skylink-api.p.rapidapi.com/notams/${icao}?include_future=true`;
    const data = await fetchURL(url, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': process.env.SKYLINK_KEY,
        'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
      }
    });
    console.log('[NOTAM fetchNotams TYPE]', typeof data);
    console.log('[NOTAM fetchNotams SAMPLE]', JSON.stringify(data).slice(0, 500));
    if (data.error || !skylinkNotamsOk(data)) {
      console.log('[NOTAM DATA UNAVAILABLE]', icao, JSON.stringify(data).slice(0, 200));
      notifySkylinkFailure(icao);
      return { text: `[NOTAM DATA UNAVAILABLE for ${icao}] The NOTAM data provider did not return data for this airport (possible quota limit or outage). Do NOT state or imply that there are no NOTAMs. In the NOTAM section, state clearly that NOTAM data could not be retrieved and must be checked with the official AIS/NOTAM office before flight.`, total: 0, shown: 0, unavailable: true };
    }
    if (data.notams.length === 0) return { text: `No active NOTAMs for ${icao}.`, total: 0, shown: 0, activeItems: [], nearFutureItems: [] };
    const now = new Date();
    const notInFuture = n => {
      if (!n.effective || n.effective.length < 12) return true;
      const eff = n.effective;
      const effDate = new Date(Date.UTC(
        parseInt(eff.slice(0,4)), parseInt(eff.slice(4,6)) - 1, parseInt(eff.slice(6,8)),
        parseInt(eff.slice(8,10)), parseInt(eff.slice(10,12))
      ));
      return effDate <= now;
    };
    const notExpired = n => {
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
    };
    const forThisIcao = n => !n.location || n.location.toUpperCase() === icao.toUpperCase();
    // Content-based detection (not series-letter based, since letter meaning isn't standardized
    // across FIRs): trigger and PERM NOTAMs rarely need direct crew action in a pre-flight
    // briefing, so they're excluded here to save tokens — full text stays available in the
    // NOTAM/MET panel, nothing is permanently hidden from the user.
    const isAdminNotam = n => /\bTRIGGER\b/i.test(n.raw || n.body || '') || (n.expiration || '').toUpperCase() === 'PERM';
    const activeNotams = data.notams.filter(n => notExpired(n) && notInFuture(n) && forThisIcao(n) && !isAdminNotam(n));
    const excludedAdminCount = data.notams.filter(n => notExpired(n) && forThisIcao(n) && isAdminNotam(n)).length;

    // Future (not-yet-effective) NOTAMs are kept OUT of the AI-written briefing entirely — mixing
    // them into the same severity/recency ranking as active NOTAMs risks a burst of future NOTAMs
    // crowding a currently-active CRITICAL one out of the shown slots. Instead: NOTAMs starting
    // within the next 24h get a short, server-authored one-liner each; anything further out is
    // just counted. Both are appended as fixed text, not left to the model to format.
    const NEAR_FUTURE_MS = 24 * 60 * 60 * 1000;
    const futureNotams = data.notams.filter(n => notExpired(n) && !notInFuture(n) && forThisIcao(n) && !isAdminNotam(n));
    const nearFuture = [], laterFuture = [];
    futureNotams.forEach(n => {
      const eff = n.effective;
      const effDate = new Date(Date.UTC(
        parseInt(eff.slice(0,4)), parseInt(eff.slice(4,6)) - 1, parseInt(eff.slice(6,8)),
        parseInt(eff.slice(8,10)), parseInt(eff.slice(10,12))
      ));
      (effDate.getTime() - now.getTime() <= NEAR_FUTURE_MS ? nearFuture : laterFuture).push(n);
    });
    nearFuture.sort((a, b) => (a.effective || '').localeCompare(b.effective || ''));
    const nearFutureLines = nearFuture.map(n => {
      const eff = n.effective ? n.effective.slice(2) : '?';
      const bodyText = (n.body || n.raw || '').replace(/\s+/g, ' ').trim();
      const oneLine = bodyText.length > 200 ? bodyText.slice(0, 197).replace(/\s+\S*$/, '') + '…' : bodyText;
      return `${n.notam_id || ''} (from ${eff}Z): ${oneLine}`;
    });

    console.log('[FILTER]', icao, 'total:', data.notams.length, 'active:', activeNotams.length, 'near-future:', nearFuture.length, 'later-future:', laterFuture.length, 'excluded admin:', excludedAdminCount);
    if (activeNotams.length === 0) return { text: `No active NOTAMs for ${icao}.`, total: 0, shown: 0, excludedAdminCount, nearFutureLines, laterFutureCount: laterFuture.length, activeItems: [], nearFutureItems: nearFuture };
    const SORD = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const classified = activeNotams.map(n => ({
      n, sev: classifyNotamSeverity(n.raw || n.body || ''), key: notamRecencyKey(n)
    }));
    classified.sort((a, b) => {
      if (SORD[a.sev] !== SORD[b.sev]) return SORD[a.sev] - SORD[b.sev];
      return b.key - a.key;
    });
    const eligible = classified.filter(c => c.sev !== 'LOW');
    const shown = Math.min(eligible.length, 8);
    const text = eligible.slice(0, shown).map(({ n, sev }, i) => {
      const raw = (n.raw || n.body || '').trim().slice(0, 500);
      return `[${icao} NOTAM ${i+1}] [${sev}] ${n.notam_id || ''}:\n${raw}`;
    }).join('\n\n---\n\n');
    return { text, total: activeNotams.length, shown, excludedAdminCount, nearFutureLines, laterFutureCount: laterFuture.length, activeItems: activeNotams, nearFutureItems: nearFuture, shownIds: eligible.slice(0, shown).map(c => c.n.notam_id || '') };
  } catch (e) { return { text: `[NOTAM DATA UNAVAILABLE for ${icao}] Could not fetch NOTAMs: ${e.message}. Do NOT state or imply that there are no NOTAMs; they must be checked with the official AIS/NOTAM office.`, total: 0, shown: 0, unavailable: true }; }
}

// Oceanic FIRs that use SkyLink fallback messaging
const OCEANIC_FIRS = new Set(['KZNY', 'CZQX', 'EGGX', 'KZAK']);

// Fetch en-route FIR NOTAMs based on dep/arr ICAO pair
// FIR NOTAM lists change slowly and are shared by many briefings: cache the SkyLink response for 30 minutes.
const firNotamCache = new Map();
async function fetchFirCached(url, options) {
  const hit = firNotamCache.get(url);
  if (hit && Date.now() - hit.t < 30 * 60 * 1000) return hit.data;
  const data = await fetchURL(url, options);
  if (skylinkNotamsOk(data)) firNotamCache.set(url, { t: Date.now(), data });
  return data;
}

async function getEnrouteNotams(dep, arr, collector, opts) {
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
    'UL': 'ULLL', 'UU': 'UUWV', 'UR': 'URRV', 'UW': 'UWWW', 'UK': 'UKBV', 'UN': 'UNNT',
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

  // Short/domestic route - no en-route FIRs needed, unless the risk rubric is active: then the FIR(s) the two
  // aerodromes sit in are fetched as well so that the rating has no information gap.
  if (dep && arr && isShortDomesticRoute(dep, arr)) {
    if (!(opts && opts.includeDomestic)) {
      console.log('[ENROUTE] Short/domestic route, skipping FIR fetch');
      return '';
    }
    if (dep.startsWith('LT') || arr.startsWith('LT')) firs.add('LTAA');   // Turkey: Istanbul (LTBB) and Ankara (LTAA) FIRs
    console.log('[ENROUTE] Domestic route, fetching aerodrome FIRs:', [...firs].join(', '));
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
    'LT-OE': ['LTAA', 'ORBB', 'OEJD'],
    'LT-OT': ['LTAA', 'ORBB', 'OKAC', 'OBBB', 'OTBD'],
    'LT-OM': ['LTAA', 'ORBB', 'OKAC', 'OBBB', 'OMAE'],
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
    .slice(0, 6);
  console.log('[ENROUTE] FIRs to fetch:', firList.join(', '));
  const results = [];

  for (const fir of firList) {
    await new Promise(r => setTimeout(r, 500));

    // Oceanic FIRs: SkyLink may not cover them — use informational fallback
    if (OCEANIC_FIRS.has(fir)) {
      try {
        const data = await fetchFirCached('https://skylink-api.p.rapidapi.com/notams/' + fir + '?include_future=true', {
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
        if (collector) collector.push({ fir, notams: active });
        const SORD = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        const classified = active.map(n => ({ n, sev: classifyNotamSeverity(n.raw || n.body || ''), key: notamRecencyKey(n) }))
          .sort((a, b) => SORD[a.sev] !== SORD[b.sev] ? SORD[a.sev] - SORD[b.sev] : b.key - a.key);
        const summary = classified.slice(0, 3).map(({ n, sev }) => `[${sev}] ${(n.raw || n.body || '').slice(0, 150)}`).join('\n');
        const overflowNote = active.length > 3 ? ` (+${active.length - 3} more — check NOTAMs & MET panel)` : '';
        results.push(`FIR ${fir}: ${active.length} active NOTAMs${overflowNote}\n${summary || 'No active restrictions'}`);
      } catch(e) {
        results.push(`FIR ${fir}: Oceanic FIR — verify current NAT tracks and oceanic NOTAM status via official sources`);
      }
      continue;
    }

    // Standard FIR fetch
    try {
      const data = await fetchFirCached('https://skylink-api.p.rapidapi.com/notams/' + fir + '?include_future=true', {
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
        if (collector) collector.push({ fir, notams: active });
        if (active.length > 0) {
          const SORD = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          const classified = active.map(n => ({ n, sev: classifyNotamSeverity(n.raw || n.body || ''), key: notamRecencyKey(n) }))
            .sort((a, b) => SORD[a.sev] !== SORD[b.sev] ? SORD[a.sev] - SORD[b.sev] : b.key - a.key);
          const summary = classified.slice(0, 3).map(({ n, sev }) => `[${sev}] ${(n.raw || n.body || '').slice(0, 150)}`).join('\n');
          const overflowNote = active.length > 3 ? ` (+${active.length - 3} more — check NOTAMs & MET panel)` : '';
          results.push(`FIR ${fir}: ${active.length} active NOTAMs${overflowNote}\n${summary}`);
        } else {
          results.push(`FIR ${fir}: No active NOTAMs`);
        }
      } else if (data && Array.isArray(data.notams) && !data.error) {
        if (collector) collector.push({ fir, notams: [] });
        results.push(`FIR ${fir}: No active NOTAMs`);
      } else {
        console.log('[ENROUTE] no usable data for FIR', fir, JSON.stringify(data || null).slice(0, 120));
        results.push(`FIR ${fir}: Data unavailable`);
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

function streamClaude(requestBody, onChunk, onDone, onError, onSearchStart) {
  let usageInfo = { input_tokens: 0, output_tokens: 0, text_chars: 0, thinking_chars: 0, thinking_blocks: 0 };
  const searchBlocks = {};
  const req = https.request({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  }, (claudeRes) => {
    const isErrorStatus = claudeRes.statusCode < 200 || claudeRes.statusCode >= 300;
    let buf = '';
    let errorBuf = '';
    claudeRes.on('data', chunk => {
      if (isErrorStatus) {
        errorBuf += chunk.toString();
        return;
      }
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
            usageInfo.input_tokens = u.input_tokens || 0;
            usageInfo.cache_created = u.cache_creation_input_tokens || 0;
            usageInfo.cache_read = u.cache_read_input_tokens || 0;
            console.log('[CACHE /briefing]', {
              input: u.input_tokens,
              output: u.output_tokens,
              cache_created: u.cache_creation_input_tokens || 0,
              cache_read: u.cache_read_input_tokens || 0
            });
          } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'server_tool_use' && evt.content_block?.name === 'web_search') {
            searchBlocks[evt.index] = '';
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && searchBlocks[evt.index] !== undefined) {
            searchBlocks[evt.index] += evt.delta.partial_json || '';
          } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'thinking') {
            usageInfo.thinking_blocks += 1;
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
            usageInfo.thinking_chars += (evt.delta.thinking || '').length;
          } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            usageInfo.text_chars += (evt.delta.text || '').length;
            onChunk(evt.delta.text);
          } else if (evt.type === 'content_block_stop' && searchBlocks[evt.index] !== undefined) {
            try {
              const query = JSON.parse(searchBlocks[evt.index]).query;
              if (query && onSearchStart) onSearchStart(query);
            } catch (_) {}
            delete searchBlocks[evt.index];
          } else if (evt.type === 'message_delta' && evt.usage?.output_tokens) {
            usageInfo.output_tokens = evt.usage.output_tokens;
            if (evt.delta?.stop_reason) usageInfo.stop_reason = evt.delta.stop_reason;
            if (evt.usage.server_tool_use?.web_search_requests) {
              usageInfo.web_search_requests = evt.usage.server_tool_use.web_search_requests;
            }
          } else if (evt.type === 'message_stop') {
            onDone(usageInfo);
          }
        } catch (_) {}
      }
    });
    claudeRes.on('end', () => {
      if (isErrorStatus) {
        let message = `Claude API returned status ${claudeRes.statusCode}`;
        try {
          const parsed = JSON.parse(errorBuf);
          if (parsed?.error?.message) message = parsed.error.message;
        } catch (_) {}
        console.error('[CLAUDE API ERROR]', { status: claudeRes.statusCode, message });
        onError(new Error(message));
        return;
      }
      onDone(usageInfo);
    });
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
  .master-header{border:1px solid var(--border2);border-top:3px solid var(--border2);background:var(--panel);padding:24px 28px 20px;margin-bottom:20px;position:relative;overflow:hidden}
  .master-header::after{content:'';position:absolute;top:0;right:0;width:200px;height:100%;background:linear-gradient(135deg,transparent 60%,rgba(255,255,255,0.03))}
  .master-header.low{border-top-color:var(--green)}
  .master-header.low::after{background:linear-gradient(135deg,transparent 60%,rgba(74,222,128,0.05))}
  .master-header.med{border-top-color:var(--yellow)}
  .master-header.med::after{background:linear-gradient(135deg,transparent 60%,rgba(234,179,8,0.05))}
  .master-header.high{border-top-color:var(--orange)}
  .master-header.high::after{background:linear-gradient(135deg,transparent 60%,rgba(249,115,22,0.05))}
  .master-header.crit{border-top-color:var(--red)}
  .master-header.crit::after{background:linear-gradient(135deg,transparent 60%,rgba(230,57,70,0.05))}
  .header-top{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap}
  .route-id{font-family:var(--head);font-size:28px;font-weight:900;letter-spacing:4px;color:#fff;text-shadow:0 0 24px rgba(74,158,255,0.3)}
  .route-sub{font-family:var(--mono);font-size:11px;color:var(--text3);letter-spacing:2px;margin-top:4px}
  .risk-badge{display:flex;flex-direction:column;align-items:flex-start;gap:4px;margin-top:18px}
  .risk-label{font-family:var(--head);font-size:22px;font-weight:900;letter-spacing:3px}
  @keyframes pulse-red{0%,100%{text-shadow:0 0 16px rgba(230,57,70,0.5)}50%{text-shadow:0 0 28px rgba(230,57,70,0.9)}}
  .risk-score{font-family:var(--mono);font-size:13px;letter-spacing:2px}
  .master-header.low .risk-label,.master-header.low .risk-score{color:var(--green)}
  .master-header.med .risk-label,.master-header.med .risk-score{color:var(--yellow)}
  .master-header.high .risk-label,.master-header.high .risk-score{color:var(--orange)}
  .master-header.crit .risk-label,.master-header.crit .risk-score{color:var(--red)}
  .master-header.crit .risk-label{text-shadow:0 0 16px rgba(230,57,70,0.5);animation:pulse-red 2s ease-in-out infinite}
  .score-bar{display:flex;gap:3px;margin-top:2px}
  .score-pip{width:16px;height:6px;border-radius:2px;background:var(--border2);transition:background 0.3s}
  .master-header.low .score-pip.active{background:var(--green);box-shadow:0 0 6px var(--green)}
  .master-header.med .score-pip.active{background:var(--yellow);box-shadow:0 0 6px var(--yellow)}
  .master-header.high .score-pip.active{background:var(--orange);box-shadow:0 0 6px var(--orange)}
  .master-header.crit .score-pip.active{background:var(--red);box-shadow:0 0 6px var(--red)}
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
  .notam-compact{display:flex;align-items:baseline;gap:8px;padding:7px 12px;border-left:3px solid transparent;background:var(--panel);font-size:13px;line-height:1.5}
  .notam-compact.crit{border-left-color:var(--red)}
  .notam-compact.high{border-left-color:var(--orange)}
  .notam-compact.med{border-left-color:var(--yellow)}
  .notam-compact.low{border-left-color:var(--green)}
  .notam-compact-sev{font-family:var(--mono);font-size:10px;letter-spacing:1px;color:var(--text3);white-space:nowrap;flex-shrink:0}
  .notam-compact-id{font-family:var(--mono);font-size:11px;color:var(--blue);white-space:nowrap;flex-shrink:0}
  .notam-compact-text{color:var(--text2);font-weight:500}
  .notam-overflow-note{padding:10px 14px;background:rgba(74,158,255,0.05);border:1px solid rgba(74,158,255,0.15);border-left:3px solid var(--blue);font-size:13px;color:var(--text2);line-height:1.5}
  .notam-overflow-note .chat-panel-link{background:none;border:none;color:var(--blue);cursor:pointer;font-family:inherit;font-size:inherit;font-weight:600;padding:0;text-decoration:underline}
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
  .wx-decoded{font-family:var(--body);font-size:12.5px;color:var(--text2);line-height:1.6;margin:0 0 8px}
  .wx-decoded b{color:var(--text);font-weight:600}
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

// Appended to the briefing system prompt ONLY when running on Sonnet 5.5. It deliberately overrides the older
// brevity limits that Sonnet 5.5 (medium effort) follows literally, restoring operational depth where it matters.
const BRIEFING_DEPTH_RULES_55 = `DEPTH AND SPECIFICITY RULES — these OVERRIDE any earlier length limit that conflicts with them (the "3-4 sentences", "1-2 sentences max" and "1-2 tight sentences" limits and the "Be concise" instruction). Anything not listed here keeps its existing cap. Concise is good; vague is not: every sentence must carry a specific fact (NOTAM ID, runway, value, time, quantity) and what it means for the crew.

1. EXECUTIVE SUMMARY: first paragraph of 5-6 sentences. Name the 2-3 most critical hazards with their NOTAM IDs and state the operational consequence of each (what the crew can no longer do, or must now do). Second paragraph: the classification and the one-sentence reason for it.
2. COMPOUNDING RISK MATRIX: each compound-item starts with a short bold label naming the interacting hazards, for example <strong>RWY CLOSURE × LLWAS U/S:</strong>, followed by 2 sentences explaining the specific interaction effect. Max 4 items.
3. FULL NOTAM CARDS: the <imp> text must state the concrete effect with values (runway, minima, times). The <act> text must be 2-3 sentences: the specific action, the specific value/time/runway it applies to, and why. Add a <cmp> element (starting with COMPOUNDS WITH:) whenever the NOTAM interacts with another NOTAM in this briefing, citing the NOTAM IDs. The compact one-line format stays as specified.
4. ALTERNATE ASSESSMENT (route briefings, Dispatch Notes - ALTERNATE AERODROME): explicitly assess whether the departure and arrival aerodromes could serve as alternates under the NOTAMs in this data, and say so plainly when one cannot (for example because of runway closures or lost approach capability). Name at least two specific candidate alternates (ICAO code and name) with a one-clause reason each (approach capability, proximity, NOTAM state), labelled as candidates whose weather and NOTAMs must be verified. Never present them as confirmed alternates.
5. ACTION ITEMS (Pilot Action Items, or Airport Operational Considerations in single-airport briefings): 8-10 items, each 2 sentences, each containing at least one concrete parameter (value, time, runway, procedure ID or NOTAM ID) plus the reason.
6. GO/NO-GO (or the airport operational status verdict): every condition must contain at least one concrete value taken from the data (time window, minima or amended OCA(H)/DH value, runway, procedure or NOTAM ID) — never a generic statement. NO-GO IF / AVOID IF triggers must combine the real compounding factors of this briefing, not generic statements.
7. NO FILLER: NEVER write "none were supplied", "none were provided", "no slot data provided" or similar wording anywhere (including action items and the alternate card); omit what has no data. List missing inputs (alternate METAR/TAF, slot data) ONCE, in one short line at the end of the last notes grid (Dispatch Notes, or Ground and ATC Notes), as <div class="notam-overflow-note">DATA GAPS: [comma-separated list]</div>, and omit that line when nothing is missing. The statement about en-route FIR NOTAMs not being retrieved stays in the Airspace section as already required and is not repeated in DATA GAPS.
8. The Go/No-Go box (or the airport status verdict box) and the Footer remain mandatory and must never be cut for space.`;


// Appended to the briefing system prompt for every briefing model: METAR/TAF decoding and interpretation.
const BRIEFING_WX_RULES = `WEATHER DECODING AND ANALYSIS (Weather Assessment section — overrides its earlier length limits): in each aerodrome card, below the raw METAR, write the METAR decoded in plain language inside <div class="wx-decoded"> as 4-6 short labelled items separated by " · ", for example <b>Wind</b> 350° at 4 kt · <b>Visibility</b> 10 km or more · <b>Weather</b> none · <b>Cloud</b> few at 1,500 ft, broken at 4,000 ft · <b>Temp/Dew</b> 16/13 °C (spread 3 °C) · <b>QNH</b> 1021 hPa · <b>Trend</b> no significant change. Decode CAVOK, NOSIG, wind variations, RVR, present-weather and cloud groups correctly. Then show the raw TAF in <div class="wx-raw"> and decode it period by period in <div class="wx-decoded"> (validity, then each BECMG/TEMPO/FM/PROB group with its times and values). Use the data exactly as given; never invent a value. If the TAF is not available, say so in one short clause. The analysis paragraphs below the cards then interpret the weather (see their template) in 4-6 sentences each.`;

// Appended to the briefing system prompt ONLY when RISK_MODE=active and a rubric result exists.
const BRIEFING_RISK_RULES = `RISK RATING RULES — apply to the MASTER HEADER and to the whole briefing. These OVERRIDE the instruction in section 1 that lets you assign the risk score yourself.
- The user message begins with a RISK FLOOR block computed by the server from the NOTAM, weather and route data. It is the MINIMUM rating. Your final RISK SCORE must be at least the FLOOR SCORE. You may RAISE it (up to 10) whenever the complete information provided (the full NOTAM cards, the ADDITIONAL ACTIVE NOTAMs lists, the route-relevant en-route NOTAMs, the WATCHLIST, METAR and TAF, and interactions or timing between hazards) shows a hazard or a combination that the floor does not capture. NEVER go below the floor.
- Use ALL the information in the user message, not only the NOTAMs shown as full cards. Evaluate every WATCHLIST item yourself and decide whether it matters.
- Derive the LEVEL and the master-header class strictly from your final SCORE using the bands 0-2 LOW/low, 3-5 MEDIUM/med, 6-8 HIGH/high, 9-10 CRITICAL/crit. They must always agree with the score.
- If you raise the score above the floor, start the second paragraph of the Executive Summary with: "Rated N/10 (rubric floor F) because" followed by the specific reason. If you keep the floor value no explanation is needed. If you believe a floor factor is overstated, still keep the floor and add one short sentence starting "Rubric note:".
- Verdict: if the RISK FLOOR block says OVERRIDE, the verdict MUST be NO-GO (single airport: SIGNIFICANTLY CONSTRAINED). Otherwise the verdict must be at least GO WITH CONDITIONS (single airport: OPEN WITH CONSTRAINTS) whenever the LEVEL is MEDIUM or higher; GO / OPEN is allowed only for LOW. You may recommend NO-GO when hazards combine so that safe operation cannot be assured, and must say why.
- The rubric tier tags in the user message (T1/T2/T3) are authoritative for how serious a NOTAM is; the [CRITICAL]/[HIGH] tags on the NOTAM cards are only ordering hints.
- Immediately after the closing </div> of the master-header, output this exact placeholder on its own line: <!--RISK_BASIS--> (the server fills it in). Do not write your own risk-basis text there.
- SCHEDULED-DAY NOTAMs: a NOTAM marked "not in force during the next 24 h" / "VALID · SCHEDULED DAYS ONLY" is NOT in effect now. In the Executive Summary, the Compounding Risk Matrix, the weather assessment and the Pilot Action Items never present it as an active hazard or plan the flight around it as if it applied today; if you mention it at all, say it is not in force in the next 24 h and name the dates when it applies. Only NOTAMs that are in force within the next 24 h count as current hazards in those sections.
- If something needed for the rating is missing (for example no TAF, or no en-route FIR data at all), say so once in the DATA GAPS line instead of assuming it is fine.`;

const systemPrompt = `MANDATORY RULES:
- Show every NOTAM included in the data — data is pre-filtered and pre-sorted by the server; render all of them (full card only for the ids on the FULL CARDS line, compact line for the rest, no line for T3 / not-scored NOTAMs)
- ONE compact line or card per NOTAM: never merge several NOTAMs into one line (no "B3202 / B3203 / B4018" lines), and always write every NOTAM id in full including the year (e.g. B3202/2026).
- Immediately after the closing </div> of the notam-list section (right after the last NOTAM card, before starting the next section such as Weather), insert this exact placeholder on its own line: <!--NOTAM_NOTES--> — always include it whenever a NOTAM section is present, even if you believe there's nothing to add there; the server will fill it in automatically. Do not add any text of your own at that spot.
- Each NOTAM card must have correct risk color class: crit (red) for runway closures/GNSS/safety critical, high (orange) for navigation aids/UAS/obstacles, med (yellow) for taxiway/procedures, low (green) for administrative
- NOTAM cards and lines are written in the compact tag format (<nc> / <nl>) shown in the template; the NOTAM id is the only identifier — do not add airport codes to cards or lines
- CRITICAL NOTAMs include: runway closures, GNSS jamming, dual runway closures, emergency-only airports
- Never downgrade GNSS jamming or runway closures to medium or low risk
- TOKEN BUDGET PRIORITY: on an unusually complex route (many NOTAMs, multiple compounding hazards), compress NOTAM Analysis, the Compounding Risk Matrix, and ALL table rows (Airspace, Aerodrome Status, Navigation Aids) further rather than risk running out of room later — every row and compact line in this briefing has a hard length cap specified below for exactly this reason. Sections 9-11 (Pilot Action Items, Dispatch Notes, Go/No-Go) are the decision-critical core of this briefing. Go/No-Go and the Footer in particular are NON-NEGOTIABLE — if you are running low on room by the time you reach Dispatch Notes, shorten Dispatch Notes itself rather than skip ahead without writing Go/No-Go. A briefing that ends without a verdict is worse than one with a slightly thinner Dispatch Notes section. A pilot can always pull more NOTAM detail from the panel; they cannot get a missing Go/No-Go from anywhere.

You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM.

Analyze the provided aviation data and produce a complete pre-flight operational intelligence briefing.

If an image or PDF is provided, analyze it as aviation documentation (NOTAM, chart, weather report, or operational document) and include findings in the briefing.

CRITICAL INSTRUCTIONS:
1. Output ONLY the HTML body content — everything that goes INSIDE <div class="page">...</div>
2. Do NOT include <!DOCTYPE>, <html>, <head>, <style>, <body> or outer <div class="page"> tags
3. Start directly with <div class="master-header [low|med|high|crit]"> and end with </div> for briefing-footer
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
<div class="master-header [low|med|high|crit — pick exactly ONE based on the score you assign below: 0-2=low, 3-5=med, 6-8=high, 9-10=crit. This single class controls every color in this header — label, score number, border, and pips — so they can never disagree with each other or with the score]">
  <div class="route-id">[DEP] → [ARR]</div>
  <div class="route-sub">[DEP FULL NAME] → [ARR FULL NAME] | PRE-FLIGHT OPERATIONAL INTELLIGENCE BRIEFING</div>
  <div class="risk-badge">
    <div class="risk-label">[🟢 LOW | 🟡 MEDIUM | 🟠 HIGH | 🔴 CRITICAL — must match the master-header class above]</div>
    <div class="risk-score">📊 RISK SCORE [X] / 10</div>
    <div class="score-bar">
      [10 score-pip divs total — add class="active" to exactly the first X pips, where X is the score (0-10). Leave the rest with no extra class. Do not add any color class to individual pips — the master-header class above already controls their color.]
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[CURRENT UTC DATE]</span></div>
    <div class="meta-item">VALIDITY <span>[VALIDITY PERIOD]</span></div>
    <div class="meta-item">ROUTE <span>[DEP] → [FIR route] → [ARR]</span></div>
    <div class="meta-item">AIRAC <span>CURRENT CYCLE ACTIVE</span></div>
    <div class="meta-item">PREPARED <span>NOTAM INTELLIGENCE AI</span></div>
  </div>
</div>

2. EXECUTIVE SUMMARY:
<div class="exec-summary">
  <p>✈️ <strong>EXECUTIVE SUMMARY —</strong> [3-4 detailed sentences covering all major risks]</p>
  <p>[Second paragraph with operational classification GO/NO-GO/GO WITH CONDITIONS]</p>
</div>

3. COMPOUNDING RISK MATRIX (always include if multiple NOTAMs; max 4 items — pick the 4 most operationally significant interactions, not every possible combination):
<div class="compound-box">
  <div class="compound-title">🔴 COMPOUNDING RISK MATRIX — SIMULTANEOUS ACTIVE HAZARDS</div>
  <div class="compound-item">[1-2 sentences max, but make them count: state the SPECIFIC interaction effect — why having both hazards together creates a risk neither has alone. This is the analysis a checklist can't give you; don't waste it restating what's already in the NOTAM cards.]</div>
  [up to 3 more compound-item divs, same standard]
</div>

4. NOTAM ANALYSIS:
<div class="section-header"><span class="icon">📋</span><span class="title">NOTAM Analysis — Priority Order</span></div>
<div class="notam-list">
  [ORDER: list ALL NOTAMs of the DEPARTURE airport first (full cards first, then compact lines), then ALL NOTAMs of the ARRIVAL airport — never interleave the two airports. The server groups and labels the list again afterwards. The DEPARTURE and ARRIVAL airport NOTAM lists are two SEPARATE, INDEPENDENT counters — a busy departure airport (e.g. a mega-hub) must NEVER reduce the arrival airport's detail allowance, and vice versa. For EACH airport independently, the user message contains a line "<ICAO> — FULL CARDS (<nc>) for EXACTLY these NOTAMs" (or "FULL CARDS: none"). Write the full card format below ONLY for the NOTAM ids named on that line, in that order, and write every other Tier 1/2 NOTAM of that airport as a compact line. NOTAMs tagged T3 or "not scored" get NO line at all (the user message says how many per airport; the page adds one summary note with the count and a panel link), except one that materially compounds with a Tier 1/2 NOTAM or is named in a COMPOUNDS WITH banner or the executive summary, which gets exactly one line. Never promote a NOTAM to a full card on your own:]

  [FULL CARD — write it in this COMPACT TAG FORMAT, not HTML. The page builds the card layout, the field labels and the RAW NOTAM TEXT from the NOTAM id, so NEVER write the raw NOTAM text or any labels yourself:]
  <nc s="[crit|high]" id="[EXACT NOTAM ID with year, from the data]" type="[TYPE]">
    <h>[Descriptive title]</h>
    <loc>[location]</loc>
    <win>[B/C times]</win>
    <ops>[operations affected]</ops>
    <imp>[impact on flight]</imp>
    <act>[specific action crew must take]</act>
    [Optional, only when this NOTAM interacts with another one: <cmp>COMPOUNDS WITH: [detail]</cmp>]
  </nc>

  [COMPACT LINE — also in compact tag format:]
  <nl s="[crit|high|med]" id="[EXACT NOTAM ID with year]">[ONE short sentence, under 20 words — what it affects and when. No semicolons or compound clauses.]</nl>

  [Tag rules: exactly one <nc> or <nl> per NOTAM; never merge ids; every tag needs its closing tag; tag content is plain text (inline <strong> is fine), never block HTML; do not add airport codes to the id.]

  [Do NOT write an overflow note or a "not shown" note: the page adds the summary of the minor NOTAMs itself.]
</div>

5. AIRSPACE AND RESTRICTIONS:
<div class="section-header"><span class="icon">🚫</span><span class="title">Airspace and Restrictions</span></div>
<div class="airspace-grid">
  <div class="airspace-row header"><span>NOTAM / REF</span><span>DESCRIPTION</span><span>VERTICAL LIMITS</span><span>ACTIVE (UTC)</span></div>
  [airspace-row divs with ar-id, ar-desc, ar-fl, ar-time spans — ar-desc is ONE concise sentence, under 25 words, not 2-3 sentences. If this item already has a full NOTAM card or appears elsewhere, this row is just the at-a-glance reference, not a second full explanation.]
</div>

6. AERODROME STATUS:
<div class="section-header"><span class="icon">🛬</span><span class="title">Aerodrome Status</span></div>
<div class="dual-col">
  <div class="status-panel dep">
    <div class="status-airport">[DEP]</div>
    <div class="status-sub">[DEP CORRECT FULL NAME] — DEPARTURE</div>
    [status-row divs with status-key and status-val (ok/warn/bad) spans — runway, taxiway, lighting, and closure status ONLY. Do NOT include navaid (VOR/NDB/ILS/GNSS) rows here — those belong exclusively in Navigation Aids Status below, so the same fact is never stated in both places. status-val: a short phrase, under 12 words, not a full sentence.]
  </div>
  <div class="status-panel arr">
    <div class="status-airport">[ARR]</div>
    <div class="status-sub">[ARR CORRECT FULL NAME] — ARRIVAL</div>
    [status-row divs, same scope — runway/taxiway/lighting/closures only, no navaid rows. Same brevity: status-val under 12 words.]
  </div>
</div>

7. NAVIGATION AIDS:
<div class="section-header"><span class="icon">📡</span><span class="title">Navigation Aids Status</span></div>
<div class="navaid-grid">
  <div class="navaid-row header"><span>NAVAID / TYPE</span><span>LOCATION</span><span>STATUS</span><span>NOTES</span></div>
  [navaid-row divs with navaid-name, navaid-loc, navaid-status (ok/ux/deg), navaid-note spans — this is the SINGLE authoritative table for every navaid: aerodrome ILS/VOR/NDB AND en-route VOR/NDB/GNSS. These facts must not be repeated in Aerodrome Status above. navaid-note: one short phrase, under 15 words, not a full sentence with NOTAM cross-references — that detail already lives in the NOTAM card.]
</div>

8. WEATHER ASSESSMENT:
<div class="section-header"><span class="icon">🌤️</span><span class="title">Weather Assessment</span></div>
<div class="wx-grid">
  <div class="wx-card"><div class="wx-icao">[DEP]</div><div class="wx-role">DEPARTURE</div><div class="wx-raw">[METAR]</div><div class="wx-decoded">[METAR DECODED — see the weather decoding rule]</div><div class="wx-raw">[TAF raw]</div><div class="wx-decoded">[TAF DECODED — see the weather decoding rule]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ARR]</div><div class="wx-role">ARRIVAL — PRIMARY</div><div class="wx-raw">[METAR]</div><div class="wx-decoded">[METAR DECODED — see the weather decoding rule]</div><div class="wx-raw">[TAF raw]</div><div class="wx-decoded">[TAF DECODED — see the weather decoding rule]</div>[wx-tags]</div>
  <div class="wx-card"><div class="wx-icao">[ALTERNATE]</div><div class="wx-role">ALTERNATE</div><div class="wx-raw">[METAR or N/A]</div>[when alternate data exists: <div class="wx-decoded">[METAR DECODED — see the weather decoding rule]</div>][wx-tags]</div>
</div>
<div class="wx-analysis">
  [Operational weather analysis, one paragraph per aerodrome (4-6 sentences each). The decoded METAR/TAF are already in the cards above, so here INTERPRET them: what the conditions mean for the approach and landing or the departure (ceiling/visibility versus the minima and procedures in this briefing's NOTAMs, wind versus the runways that are actually open, temperature and dew-point spread for fog or icing, density-altitude or braking effects), when the TAF changes things (BECMG/TEMPO/PROB periods with their times) and what the crew should plan because of it (fuel, alternate need, timing).]
  <p>[Dep weather analysis]</p><p>[Arr weather analysis with concerns]</p><p>[Alternate and additional info]</p>
</div>

9. PILOT ACTION ITEMS:
<div class="section-header"><span class="icon">✅</span><span class="title">Pilot Action Items</span></div>
<div class="action-list">
  [8-10 action-item divs each with action-num (01-10) and action-text with em tags for key terms. Each action-text: 1-2 tight sentences — the specific action PLUS the specific reason it matters right now on this route. Cut the throat-clearing and generic safety framing; keep the part a pilot actually needs to act on. This section is never shortened or cut for space — see the TOKEN BUDGET PRIORITY rule near the top of this prompt.]
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
  <div class="footer-sig">NOTAM INTELLIGENCE — AI-POWERED OPERATIONAL BRIEFING<br>ROUTE: [DEP]–[ARR] | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">AI-GENERATED BRIEFING — MAY CONTAIN ERRORS OR OMISSIONS. PROVIDED "AS-IS" FOR PLANNING PURPOSES ONLY; DOES NOT REPLACE OFFICIAL PRE-FLIGHT DOCUMENTATION. FLIGHT SAFETY IS THE OVERRIDING PRIORITY — INDEPENDENTLY VERIFY ALL NOTAM, WEATHER, AND ATC DATA AGAINST CURRENT OFFICIAL SOURCES BEFORE FLIGHT, AS CONDITIONS MAY HAVE CHANGED SINCE GENERATION. NOTAM INTELLIGENCE ASSUMES NO LIABILITY FOR DECISIONS MADE IN RELIANCE ON THIS BRIEFING WITHOUT SUCH INDEPENDENT VERIFICATION.</div>
</div>

MANDATORY: Analyze and include en-route NOTAMs for ALL FIRs along the route. For each FIR on the route (e.g. LTBB, LKAA, EGTT, EDGG etc.), check for:
- Airspace closures or restrictions
- Military exercise areas (MATZ, danger areas, restricted areas)
- Temporary Flight Restrictions (TFRs)
- Active SIGMETs along route
- FIR crossing procedures or special requirements
Include a dedicated AIRSPACE section in the briefing that specifically covers en-route hazards separate from aerodrome NOTAMs. If no en-route NOTAMs exist for a FIR, explicitly state 'No active en-route restrictions for [FIR]'.

EN-ROUTE FIR ANALYSIS: For each intermediate FIR along the route, create a dedicated subsection in the AIRSPACE section. List specific NOTAM numbers, types, and operational impact. If military exercise areas, TFRs, or airspace restrictions exist, classify them as HIGH or CRITICAL risk as appropriate. Never say 'limited information available' - either provide the data or explicitly state 'No active NOTAMs for [FIR]'.

CRITICAL REQUIREMENT: You MUST fetch and analyze NOTAMs for ALL intermediate FIRs between departure and arrival. Never say a FIR's data is 'not available in this briefing' - if en-route FIR NOTAMs are provided in the EN-ROUTE FIR NOTAMs section, analyze them ALL. If a FIR shows 'No active NOTAMs', state that no active NOTAMs were found for it. AIRSPACE FOOTER: directly after the airspace table write exactly ONE neutral line of the form 'En-route FIRs analysed: <FIR codes whose data was provided, including those with no active NOTAMs>.' Do NOT add disclaimers or caveats there ('not a guarantee of clear airspace', 'review elsewhere', 'check official sources', or any advice to look for en-route NOTAMs elsewhere), and do not mention FIRs that are not in the data; a FIR whose data line says 'Data unavailable' is simply left out of that list.

NEVER say 'sınırlı bilgi', 'limited information', 'bu briefingde yer almıyor' or similar. If FIR NOTAM data is provided, analyze it fully. If the data section says 'No FIR data available', state plainly in the Airspace section that en-route FIR NOTAMs were NOT retrieved for this briefing and must be checked via official sources. NEVER present missing data as confirmation of clear airspace.

For transatlantic routes, always mention NAT (North Atlantic Track) system status and oceanic clearance requirements. For routes over conflict zones (Middle East, Eastern Europe), specifically check for active airspace closures and NOTAM to Airmen.

Use real data from provided NOTAMs and weather. Be detailed and operationally specific. Cover all NOTAM types including SNOWTAM, BIRDTAM, ASHTAM, Military, Navigation, Airspace, Aerodrome NOTAMs.

IMPORTANT: Be concise. Limit each NOTAM card to essential information only. Ensure ALL sections are completed including Go/No-Go and Footer.

IMPORTANT: Never use markdown backticks or code blocks. For RAW NOTAM TEXT field, output the exact NOTAM text inside a pre HTML tag with inline styles. Example:
<pre style='font-family:monospace;white-space:pre-wrap;font-size:11px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid #1a2a3a;line-height:1.6;color:#8a9bb0;margin:8px 0;'>NOTAM TEXT</pre>
The ! prefix and date format (YYMMDDHHmm) are standard ICAO format - keep them exactly as received.

NOTAM LIMITS: Render every NOTAM provided in the data — they are already pre-sorted and capped by the server. Use full cards only for the ids the FULL CARDS line names; every other Tier 1/2 NOTAM gets the compact format and T3 / not-scored NOTAMs get no line (the page summarises them). For en-route FIRs, use brief summaries only — no raw NOTAM text blocks.`;

const singleAirportSystemPrompt = `MANDATORY RULES:
- Show every NOTAM included in the data — data is pre-filtered and pre-sorted by the server; render all of them (full card only for the ids on the FULL CARDS line, compact line for the rest, no line for T3 / not-scored NOTAMs)
- ONE compact line or card per NOTAM: never merge several NOTAMs into one line (no "B3202 / B3203 / B4018" lines), and always write every NOTAM id in full including the year (e.g. B3202/2026).
- Immediately after the closing </div> of the notam-list section (right after the last NOTAM card, before starting the next section such as Weather), insert this exact placeholder on its own line: <!--NOTAM_NOTES--> — always include it whenever a NOTAM section is present, even if you believe there's nothing to add there; the server will fill it in automatically. Do not add any text of your own at that spot.
- Each NOTAM card must have correct risk color class: crit (red) for runway closures/GNSS/safety critical, high (orange) for navigation aids/UAS/obstacles, med (yellow) for taxiway/procedures, low (green) for administrative
- NOTAM cards and lines are written in the compact tag format (<nc> / <nl>) shown in the template; the NOTAM id is the only identifier — do not add airport codes to cards or lines
- CRITICAL NOTAMs include: runway closures, GNSS jamming, dual runway closures, emergency-only airports
- Never downgrade GNSS jamming or runway closures to medium or low risk
- TOKEN BUDGET PRIORITY: on an unusually busy airport (many NOTAMs, multiple compounding hazards), compress NOTAM Analysis, the Compounding Risk Matrix, and all table rows further rather than risk running out of room later. Sections 9-11 (Airport Operational Considerations, Ground & ATC Notes, Airport Operational Status) are the decision-critical core of this briefing — the Operational Status verdict and Footer in particular are NON-NEGOTIABLE and must always be written, even if it means shortening Ground & ATC Notes itself. A reader can always pull more NOTAM detail from the panel; they cannot get a missing verdict from anywhere.

You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM.

Analyze the provided aviation data for this SINGLE AIRPORT and produce a complete airport operational intelligence briefing. This is NOT a route briefing — there is no departure/arrival pair and no flight-specific Go/No-Go decision. Frame everything around "what does someone operating into, out of, or through this airport right now need to know."

If an image or PDF is provided, analyze it as aviation documentation (NOTAM, chart, weather report, or operational document) and include findings in the briefing.

CRITICAL INSTRUCTIONS:
1. Output ONLY the HTML body content — everything that goes INSIDE <div class="page">...</div>
2. Do NOT include <!DOCTYPE>, <html>, <head>, <style>, <body> or outer <div class="page"> tags
3. Start directly with <div class="master-header [low|med|high|crit]"> and end with </div> for briefing-footer
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
<div class="master-header [low|med|high|crit — pick exactly ONE based on the score you assign below: 0-2=low, 3-5=med, 6-8=high, 9-10=crit. This single class controls every color in this header — label, score number, border, and pips — so they can never disagree with each other or with the score]">
  <div class="route-id">[ICAO]</div>
  <div class="route-sub">[FULL AIRPORT NAME] | AIRPORT OPERATIONAL INTELLIGENCE BRIEFING</div>
  <div class="risk-badge">
    <div class="risk-label">[🟢 LOW | 🟡 MEDIUM | 🟠 HIGH | 🔴 CRITICAL — must match the master-header class above]</div>
    <div class="risk-score">📊 RISK SCORE [X] / 10</div>
    <div class="score-bar">
      [10 score-pip divs total — add class="active" to exactly the first X pips, where X is the score (0-10). Leave the rest with no extra class.]
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[CURRENT UTC DATE]</span></div>
    <div class="meta-item">VALIDITY <span>[VALIDITY PERIOD]</span></div>
    <div class="meta-item">AIRPORT <span>[ICAO] — [FULL NAME]</span></div>
    <div class="meta-item">AIRAC <span>CURRENT CYCLE ACTIVE</span></div>
    <div class="meta-item">PREPARED <span>NOTAM INTELLIGENCE AI</span></div>
  </div>
</div>

2. EXECUTIVE SUMMARY:
<div class="exec-summary">
  <p>✈️ <strong>EXECUTIVE SUMMARY —</strong> [3-4 detailed sentences covering this airport's current operational picture — the major active hazards and what they mean in combination]</p>
  <p>[Second paragraph: OPERATIONAL STATUS — OPEN / OPEN WITH CONSTRAINTS / SIGNIFICANTLY CONSTRAINED, with the key reasons]</p>
</div>

3. COMPOUNDING RISK MATRIX (always include if multiple NOTAMs; max 4 items — pick the 4 most operationally significant interactions, not every possible combination):
<div class="compound-box">
  <div class="compound-title">🔴 COMPOUNDING RISK MATRIX — SIMULTANEOUS ACTIVE HAZARDS</div>
  <div class="compound-item">[1-2 sentences max, but make them count: state the SPECIFIC interaction effect — why having both hazards together creates a risk neither has alone.]</div>
  [up to 3 more compound-item divs, same standard]
</div>

4. NOTAM ANALYSIS:
<div class="section-header"><span class="icon">📋</span><span class="title">NOTAM Analysis — Priority Order</span></div>
<div class="notam-list">
  [The user message contains a line "<ICAO> — FULL CARDS (<nc>) for EXACTLY these NOTAMs" (or "FULL CARDS: none"). Write the full card format below ONLY for the NOTAM ids named on that line, in that order, and write every other Tier 1/2 NOTAM as a compact line. NOTAMs tagged T3 or "not scored" get NO line at all (the user message says how many; the page adds one summary note with the count and a panel link), except one that materially compounds with a Tier 1/2 NOTAM or is named in a COMPOUNDS WITH banner or the executive summary, which gets exactly one line. Never promote a NOTAM to a full card on your own.]

  [FULL CARD — write it in this COMPACT TAG FORMAT, not HTML. The page builds the card layout, the field labels and the RAW NOTAM TEXT from the NOTAM id, so NEVER write the raw NOTAM text or any labels yourself:]
  <nc s="[crit|high]" id="[EXACT NOTAM ID with year, from the data]" type="[TYPE]">
    <h>[Descriptive title]</h>
    <loc>[location]</loc>
    <win>[B/C times]</win>
    <ops>[operations affected]</ops>
    <imp>[impact on flight]</imp>
    <act>[specific action crew must take]</act>
    [Optional, only when this NOTAM interacts with another one: <cmp>COMPOUNDS WITH: [detail]</cmp>]
  </nc>

  [COMPACT LINE — also in compact tag format:]
  <nl s="[crit|high|med]" id="[EXACT NOTAM ID with year]">[ONE short sentence, under 20 words — what it affects and when. No semicolons or compound clauses.]</nl>

  [Tag rules: exactly one <nc> or <nl> per NOTAM; never merge ids; every tag needs its closing tag; tag content is plain text (inline <strong> is fine), never block HTML; do not add airport codes to the id.]

  [Do NOT write an overflow note or a "not shown" note: the page adds the summary of the minor NOTAMs itself.]
</div>

5. AIRSPACE AND RESTRICTIONS (scoped to the FIR this airport sits in — not a multi-FIR route table):
<div class="section-header"><span class="icon">🚫</span><span class="title">Airspace and Restrictions</span></div>
<div class="airspace-grid">
  <div class="airspace-row header"><span>NOTAM / REF</span><span>DESCRIPTION</span><span>VERTICAL LIMITS</span><span>ACTIVE (UTC)</span></div>
  [airspace-row divs with ar-id, ar-desc, ar-fl, ar-time spans — ar-desc is ONE concise sentence, under 25 words. Cover TFRs, danger areas, GNSS jamming, or military activity in this airport's own FIR only.]
</div>

6. AERODROME STATUS (single panel — no second airport):
<div class="section-header"><span class="icon">🛬</span><span class="title">Aerodrome Status</span></div>
<div class="status-panel dep">
  <div class="status-airport">[ICAO]</div>
  <div class="status-sub">[FULL NAME]</div>
  [status-row divs with status-key and status-val (ok/warn/bad) spans — runway, taxiway, lighting, and closure status ONLY. Do NOT include navaid rows here — those belong in Navigation Aids Status below. status-val: a short phrase, under 12 words.]
</div>

7. NAVIGATION AIDS:
<div class="section-header"><span class="icon">📡</span><span class="title">Navigation Aids Status</span></div>
<div class="navaid-grid">
  <div class="navaid-row header"><span>NAVAID / TYPE</span><span>LOCATION</span><span>STATUS</span><span>NOTES</span></div>
  [navaid-row divs with navaid-name, navaid-loc, navaid-status (ok/ux/deg), navaid-note spans — this airport's own ILS/VOR/NDB plus any GNSS/regional navaid issues in its FIR. navaid-note: one short phrase, under 15 words.]
</div>

8. WEATHER ASSESSMENT (single airport — no dual dep/arr/alternate cards):
<div class="section-header"><span class="icon">🌤️</span><span class="title">Weather Assessment</span></div>
<div class="wx-card">
  <div class="wx-icao">[ICAO]</div><div class="wx-role">CURRENT CONDITIONS</div><div class="wx-raw">[METAR]</div><div class="wx-decoded">[METAR DECODED — see the weather decoding rule]</div><div class="wx-raw">[TAF raw]</div><div class="wx-decoded">[TAF DECODED — see the weather decoding rule]</div>[wx-tags]
</div>
<div class="wx-analysis">
  [Operational weather analysis, 4-6 sentences. The decoded METAR/TAF are in the card above, so INTERPRET them: effect on approaches and departures given the NOTAMs, wind versus the runways that are open, fog/icing/density-altitude indications, and what the TAF changes and when.]
  <p>[Weather analysis paragraph]</p>
</div>

9. AIRPORT OPERATIONAL CONSIDERATIONS:
<div class="section-header"><span class="icon">✅</span><span class="title">Airport Operational Considerations</span></div>
<div class="action-list">
  [As many action-item divs as genuinely warranted (typically 6-10), each with action-num and action-text with em tags for key terms. Each action-text: 1-2 tight sentences — the specific thing to confirm or do PLUS why it matters at this airport right now, framed around operating into, out of, or through it (not a specific flight's route). Never cut short for space — see TOKEN BUDGET PRIORITY.]
</div>

10. GROUND & ATC NOTES:
<div class="section-header"><span class="icon">📦</span><span class="title">Ground & ATC Notes</span></div>
<div class="dispatch-grid">
  <div class="dispatch-card"><span class="dispatch-icon">🛻</span><div class="dispatch-label">GROUND OPERATIONS</div><div class="dispatch-value">[ramp/taxi/stand considerations relevant to active NOTAMs. If this airport is slot-coordinated, fold the slot/CTOT note into this same card — only mention it when actually relevant, don't pad with "not applicable".]</div></div>
  <div class="dispatch-card"><span class="dispatch-icon">📻</span><div class="dispatch-label">ATC COORDINATION</div><div class="dispatch-value">[ATC details with hl spans]</div></div>
</div>

11. AIRPORT OPERATIONAL STATUS:
<div class="gng-box">
  <div class="gng-verdict">🎯 [OPEN ✅ / SIGNIFICANTLY CONSTRAINED ❌ / OPEN WITH CONSTRAINTS ⚠️]</div>
  <p style="font-size:14px;font-weight:600;color:var(--text);line-height:1.6;">[Main reasoning — the overall operational picture of this airport right now]</p>
  <div class="gng-conditions">
    [gng-cond divs — things to verify or confirm before operating into or out of this airport]
  </div>
  [Optional: <div class="gng-nogo-cond">AVOID IF: [condition]</div>]
</div>

12. FOOTER:
<div class="briefing-footer">
  <div class="footer-sig">NOTAM INTELLIGENCE — AI-POWERED OPERATIONAL BRIEFING<br>AIRPORT: [ICAO] | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">AI-GENERATED BRIEFING — MAY CONTAIN ERRORS OR OMISSIONS. PROVIDED "AS-IS" FOR PLANNING PURPOSES ONLY; DOES NOT REPLACE OFFICIAL PRE-FLIGHT DOCUMENTATION. FLIGHT SAFETY IS THE OVERRIDING PRIORITY — INDEPENDENTLY VERIFY ALL NOTAM, WEATHER, AND ATC DATA AGAINST CURRENT OFFICIAL SOURCES BEFORE FLIGHT, AS CONDITIONS MAY HAVE CHANGED SINCE GENERATION. NOTAM INTELLIGENCE ASSUMES NO LIABILITY FOR DECISIONS MADE IN RELIANCE ON THIS BRIEFING WITHOUT SUCH INDEPENDENT VERIFICATION.</div>
</div>

Use real data from provided NOTAMs and weather. Be detailed and operationally specific. Cover all NOTAM types including SNOWTAM, BIRDTAM, ASHTAM, Military, Navigation, Airspace, Aerodrome NOTAMs.

IMPORTANT: Be concise. Limit each NOTAM card to essential information only. Ensure ALL sections are completed including Airport Operational Status and Footer.

IMPORTANT: Never use markdown backticks or code blocks. For RAW NOTAM TEXT field, output the exact NOTAM text inside a pre HTML tag with inline styles. Example:
<pre style='font-family:monospace;white-space:pre-wrap;font-size:11px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid #1a2a3a;line-height:1.6;color:#8a9bb0;margin:8px 0;'>NOTAM TEXT</pre>
The ! prefix and date format (YYMMDDHHmm) are standard ICAO format - keep them exactly as received.

NOTAM LIMITS: Render every NOTAM provided in the data — they are already pre-sorted and capped by the server. Use full cards only for the ids the FULL CARDS line names; every other Tier 1/2 NOTAM gets the compact format and T3 / not-scored NOTAMs get no line (the page summarises them).`;

const quickAnalysisSystemPrompt = `MANDATORY RULES:
- This is a QUICK ANALYSIS of whatever aviation data was provided — an image, a PDF, or pasted raw text (NOTAM, METAR, TAF, SIGMET, AIRMET, or a mix). There is no confirmed airport or route context. Do not invent one.
- If an image or PDF is provided, read it carefully and transcribe the relevant raw text accurately before analyzing it — the reader needs to be able to verify what was actually read.
- Each item gets a severity-correct risk color: crit (red) for runway closures/GNSS jamming/safety-critical NOTAMs or severe SIGMET/AIRMET hazards, high (orange) for navigation aid/obstacle NOTAMs or significant SIGMET/AIRMET activity, med (yellow) for procedural/taxiway-level NOTAMs or marginal weather, low (green) for administrative NOTAMs or routine METAR/TAF conditions with nothing of note.
- Never downgrade GNSS jamming, runway closures, or active SIGMET/AIRMET hazards to medium or low risk.

You are a senior Aeronautical Information Management (AIM) specialist with 20+ years of operational experience. Expert in ICAO Annex 15, PANS-AIM Doc 10066, PANS-OPS Doc 8168, DOC 4444 PANS-ATM, and WMO meteorological codes (METAR/TAF/SIGMET/AIRMET).

CRITICAL INSTRUCTIONS:
1. Output ONLY the HTML body content — everything that goes INSIDE <div class="page">...</div>
2. Do NOT include <!DOCTYPE>, <html>, <head>, <style>, <body> or outer <div class="page"> tags
3. Start directly with <div class="master-header [low|med|high|crit]"> and end with </div> for briefing-footer
4. Use EXACTLY these CSS classes — they are already loaded
5. NEVER write "Content Under Review" or any placeholder text — analyze the actual data provided.

REQUIRED SECTIONS IN ORDER:

1. HEADER:
<div class="master-header [low|med|high|crit — pick ONE based on the highest-severity item detected: 0-2=low, 3-5=med, 6-8=high, 9-10=crit. Controls every color in this header.]">
  <div class="route-id">[DETECTED TYPE — e.g. "NOTAM ANALYSIS", "METAR/TAF ANALYSIS", "SIGMET ANALYSIS", or "MIXED DATA ANALYSIS" if several types are present]</div>
  <div class="route-sub">[ONE short phrase describing the source — e.g. "1 NOTAM detected from uploaded image" or "Pasted METAR + TAF text"] | AI-POWERED QUICK ANALYSIS</div>
  <div class="risk-badge">
    <div class="risk-label">[🟢 LOW | 🟡 MEDIUM | 🟠 HIGH | 🔴 CRITICAL — must match the master-header class above]</div>
    <div class="risk-score">📊 RISK SCORE [X] / 10</div>
    <div class="score-bar">
      [10 score-pip divs total — add class="active" to exactly the first X pips.]
    </div>
  </div>
  <div class="header-meta">
    <div class="meta-item">DATE <span>[CURRENT UTC DATE]</span></div>
    <div class="meta-item">SOURCE <span>[Image | PDF | Pasted Text]</span></div>
    <div class="meta-item">ITEMS DETECTED <span>[N]</span></div>
    <div class="meta-item">PREPARED <span>NOTAM INTELLIGENCE AI</span></div>
  </div>
</div>

2. WHAT WAS DETECTED:
<div class="exec-summary">
  <p>🔍 <strong>DETECTED —</strong> [1-2 sentences: what type(s) of aviation data were found, how many items, and a one-line characterization of overall significance]</p>
</div>

3. ITEM ANALYSIS:
<div class="section-header"><span class="icon">📋</span><span class="title">Item Analysis</span></div>
<div class="notam-list">
  [For each detected NOTAM (or SIGMET/AIRMET, which should use the same full-card treatment given their inherent significance — never the compact format), use this structure, choosing crit/high/med/low by severity:]
  <div class="notam-card [crit|high|med|low]">
    <div class="notam-head">
      <div class="notam-dot"></div>
      <div>
        <div class="notam-id">[🔴/🟠/🟡/🟢] [ID if available] | TYPE: [TYPE]</div>
        <div class="notam-title">[Descriptive title]</div>
      </div>
    </div>
    <div class="notam-grid">
      <div class="notam-field"><div class="notam-field-label">📍 Location</div><div class="notam-field-value">[location]</div></div>
      <div class="notam-field"><div class="notam-field-label">⏰ Time Window UTC</div><div class="notam-field-value">[time window]</div></div>
      <div class="notam-field"><div class="notam-field-label">✈️ Affected Operations</div><div class="notam-field-value">[operations affected]</div></div>
      <div class="notam-field"><div class="notam-field-label">📐 Operational Impact</div><div class="notam-field-value">[impact]</div></div>
    </div>
    <div class="notam-field" style="margin:10px 0 6px"><div class="notam-field-label">📄 RAW TEXT (AS READ)</div><div class="notam-field-value" style="font-family:monospace;font-size:12px;background:rgba(0,0,0,0.3);padding:8px;border:1px solid var(--border);white-space:pre-wrap;word-break:break-all">[verbatim transcribed text — exactly as it appears in the source]</div></div>
    <div class="notam-field-label" style="margin-top:10px">🤖 AI Analysis</div>
    <div class="notam-action"><span class="action-label">⚠️ REQUIRED ACTION</span>[specific action]</div>
  </div>

  [For each detected METAR or TAF, use this structure instead:]
  <div class="wx-card">
    <div class="wx-icao">[ICAO if identifiable, else "—"]</div><div class="wx-role">[METAR | TAF]</div><div class="wx-raw">[raw text as read]</div>[wx-tags]
  </div>
  <div class="wx-analysis"><p>[2-3 sentences: operational significance — do not just restate the raw product, say what it actually means]</p></div>
</div>

4. FOOTER:
<div class="briefing-footer">
  <div class="footer-sig">NOTAM INTELLIGENCE — AI-POWERED OPERATIONAL BRIEFING<br>QUICK ANALYSIS | [DATE] | [TIME UTC]</div>
  <div class="footer-disclaimer">AI-GENERATED ANALYSIS — MAY CONTAIN ERRORS OR OMISSIONS, INCLUDING MISREAD TEXT FROM IMAGES/PDFS. PROVIDED "AS-IS" FOR PLANNING PURPOSES ONLY; DOES NOT REPLACE OFFICIAL PRE-FLIGHT DOCUMENTATION. INDEPENDENTLY VERIFY AGAINST CURRENT OFFICIAL SOURCES BEFORE FLIGHT. NOTAM INTELLIGENCE ASSUMES NO LIABILITY FOR DECISIONS MADE IN RELIANCE ON THIS ANALYSIS WITHOUT SUCH INDEPENDENT VERIFICATION.</div>
</div>

Never use markdown backticks or code blocks. Be concise but specific — this is a quick analysis, not a full briefing, so don't pad it with sections that don't apply.`;

const AIRCRAFT_PERF_FALLBACK = {
  'B747': { icao_type:'B747', name:'BOEING 747-400', engine_type:'Jet', engine_code:'L4J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:45000, max_range_nm:7260, wing_span_m:64.4, length_m:70.7, mtow_t:396.9, max_passengers:524 },
  'B748': { icao_type:'B748', name:'BOEING 747-8', engine_type:'Jet', engine_code:'L4J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:43100, max_range_nm:7730, wing_span_m:68.4, length_m:76.3, mtow_t:447.7, max_passengers:467 },
  'B777': { icao_type:'B777', name:'BOEING 777-200', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:43100, max_range_nm:5240, wing_span_m:60.9, length_m:63.7, mtow_t:247.2, max_passengers:440 },
  'B77W': { icao_type:'B77W', name:'BOEING 777-300ER', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:43100, max_range_nm:7370, wing_span_m:64.8, length_m:73.9, mtow_t:351.5, max_passengers:550 },
  'B772': { icao_type:'B772', name:'BOEING 777-200', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:43100, max_range_nm:5240, wing_span_m:60.9, length_m:63.7, mtow_t:247.2, max_passengers:440 },
  'B773': { icao_type:'B773', name:'BOEING 777-300', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:490, service_ceiling_ft:43100, max_range_nm:6030, wing_span_m:60.9, length_m:73.9, mtow_t:299.4, max_passengers:550 },
  'B787': { icao_type:'B787', name:'BOEING 787-8 Dreamliner', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43000, max_range_nm:7355, wing_span_m:60.1, length_m:56.7, mtow_t:227.9, max_passengers:359 },
  'B788': { icao_type:'B788', name:'BOEING 787-8 Dreamliner', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43000, max_range_nm:7355, wing_span_m:60.1, length_m:56.7, mtow_t:227.9, max_passengers:359 },
  'B789': { icao_type:'B789', name:'BOEING 787-9 Dreamliner', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43000, max_range_nm:7635, wing_span_m:60.1, length_m:62.8, mtow_t:254.0, max_passengers:406 },
  'B78X': { icao_type:'B78X', name:'BOEING 787-10 Dreamliner', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43000, max_range_nm:6430, wing_span_m:60.1, length_m:68.3, mtow_t:254.0, max_passengers:440 },
  'A330': { icao_type:'A330', name:'AIRBUS A330-300', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:470, service_ceiling_ft:41450, max_range_nm:6340, wing_span_m:60.3, length_m:63.7, mtow_t:242.0, max_passengers:440 },
  'A332': { icao_type:'A332', name:'AIRBUS A330-200', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:470, service_ceiling_ft:41450, max_range_nm:7250, wing_span_m:60.3, length_m:58.8, mtow_t:242.0, max_passengers:406 },
  'A333': { icao_type:'A333', name:'AIRBUS A330-300', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:470, service_ceiling_ft:41450, max_range_nm:6340, wing_span_m:60.3, length_m:63.7, mtow_t:242.0, max_passengers:440 },
  'A35K': { icao_type:'A35K', name:'AIRBUS A350-1000', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43100, max_range_nm:8700, wing_span_m:64.75, length_m:73.8, mtow_t:319.0, max_passengers:480 },
  'A359': { icao_type:'A359', name:'AIRBUS A350-900', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43100, max_range_nm:8100, wing_span_m:64.75, length_m:66.8, mtow_t:280.0, max_passengers:440 },
  'A350': { icao_type:'A350', name:'AIRBUS A350-900', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:488, service_ceiling_ft:43100, max_range_nm:8100, wing_span_m:64.75, length_m:66.8, mtow_t:280.0, max_passengers:440 },
  'A380': { icao_type:'A380', name:'AIRBUS A380-800', engine_type:'Jet', engine_code:'L4J', wake_category:'J', cruise_speed_ktas:488, service_ceiling_ft:43000, max_range_nm:8000, wing_span_m:79.8, length_m:72.7, mtow_t:575.0, max_passengers:853 },
  'MD11': { icao_type:'MD11', name:'MCDONNELL DOUGLAS MD-11', engine_type:'Jet', engine_code:'L3J', wake_category:'H', cruise_speed_ktas:475, service_ceiling_ft:43100, max_range_nm:6480, wing_span_m:51.7, length_m:61.6, mtow_t:285.99, max_passengers:410 },
  'B767': { icao_type:'B767', name:'BOEING 767-300', engine_type:'Jet', engine_code:'L2J', wake_category:'H', cruise_speed_ktas:459, service_ceiling_ft:43100, max_range_nm:6385, wing_span_m:47.6, length_m:54.9, mtow_t:186.9, max_passengers:375 },
  // General Aviation
  'C172': { icao_type:'C172', name:'CESSNA 172 Skyhawk', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:122, service_ceiling_ft:14000, max_range_nm:640, wing_span_m:11.0, length_m:8.28, mtow_t:1.157, max_passengers:4 },
  'C152': { icao_type:'C152', name:'CESSNA 152', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:107, service_ceiling_ft:14700, max_range_nm:415, wing_span_m:10.2, length_m:7.34, mtow_t:0.757, max_passengers:2 },
  'C182': { icao_type:'C182', name:'CESSNA 182 Skylane', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:145, service_ceiling_ft:18100, max_range_nm:915, wing_span_m:11.0, length_m:8.84, mtow_t:1.406, max_passengers:4 },
  'C208': { icao_type:'C208', name:'CESSNA 208 Caravan', engine_type:'Turboprop', engine_code:'T1', wake_category:'L', cruise_speed_ktas:184, service_ceiling_ft:25000, max_range_nm:1070, wing_span_m:15.9, length_m:12.7, mtow_t:3.97, max_passengers:14 },
  'PA28': { icao_type:'PA28', name:'PIPER PA-28 Cherokee', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:128, service_ceiling_ft:14000, max_range_nm:560, wing_span_m:9.14, length_m:7.34, mtow_t:1.157, max_passengers:4 },
  'BE20': { icao_type:'BE20', name:'BEECHCRAFT King Air 200', engine_type:'Turboprop', engine_code:'T2', wake_category:'L', cruise_speed_ktas:280, service_ceiling_ft:35000, max_range_nm:1580, wing_span_m:16.6, length_m:13.34, mtow_t:5.67, max_passengers:13 },
  'BE9L': { icao_type:'BE9L', name:'BEECHCRAFT King Air 90', engine_type:'Turboprop', engine_code:'T2', wake_category:'L', cruise_speed_ktas:250, service_ceiling_ft:30000, max_range_nm:1390, wing_span_m:13.98, length_m:10.82, mtow_t:4.58, max_passengers:9 },
  'DA40': { icao_type:'DA40', name:'DIAMOND DA40', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:147, service_ceiling_ft:16400, max_range_nm:700, wing_span_m:11.94, length_m:8.0, mtow_t:1.2, max_passengers:4 },
  'DA42': { icao_type:'DA42', name:'DIAMOND DA42 Twin Star', engine_type:'Piston', engine_code:'P2', wake_category:'L', cruise_speed_ktas:148, service_ceiling_ft:18000, max_range_nm:910, wing_span_m:13.55, length_m:8.56, mtow_t:1.785, max_passengers:4 },
  'SR22': { icao_type:'SR22', name:'CIRRUS SR22', engine_type:'Piston', engine_code:'P1', wake_category:'L', cruise_speed_ktas:183, service_ceiling_ft:17500, max_range_nm:1040, wing_span_m:11.68, length_m:7.92, mtow_t:1.633, max_passengers:4 },
  // Business Jets
  'C25A': { icao_type:'C25A', name:'CESSNA Citation CJ2', engine_type:'Jet', engine_code:'L2J', wake_category:'L', cruise_speed_ktas:418, service_ceiling_ft:45000, max_range_nm:1613, wing_span_m:14.32, length_m:14.39, mtow_t:5.67, max_passengers:8 },
  'C510': { icao_type:'C510', name:'CESSNA Citation Mustang', engine_type:'Jet', engine_code:'L2J', wake_category:'L', cruise_speed_ktas:340, service_ceiling_ft:41000, max_range_nm:1150, wing_span_m:13.16, length_m:12.36, mtow_t:3.93, max_passengers:4 },
  'C525': { icao_type:'C525', name:'CESSNA CitationJet', engine_type:'Jet', engine_code:'L2J', wake_category:'L', cruise_speed_ktas:380, service_ceiling_ft:41000, max_range_nm:1480, wing_span_m:13.16, length_m:12.57, mtow_t:4.65, max_passengers:6 },
  'C56X': { icao_type:'C56X', name:'CESSNA Citation Excel', engine_type:'Jet', engine_code:'L2J', wake_category:'L', cruise_speed_ktas:441, service_ceiling_ft:45000, max_range_nm:1858, wing_span_m:15.9, length_m:15.9, mtow_t:9.16, max_passengers:9 },
  'GLEX': { icao_type:'GLEX', name:'BOMBARDIER Global Express', engine_type:'Jet', engine_code:'L2J', wake_category:'M', cruise_speed_ktas:488, service_ceiling_ft:51000, max_range_nm:6150, wing_span_m:28.65, length_m:30.3, mtow_t:45.13, max_passengers:19 },
  'GLF6': { icao_type:'GLF6', name:'GULFSTREAM G650', engine_type:'Jet', engine_code:'L2J', wake_category:'M', cruise_speed_ktas:516, service_ceiling_ft:51000, max_range_nm:7000, wing_span_m:30.4, length_m:30.4, mtow_t:45.18, max_passengers:18 },
  'GLF5': { icao_type:'GLF5', name:'GULFSTREAM G550', engine_type:'Jet', engine_code:'L2J', wake_category:'M', cruise_speed_ktas:488, service_ceiling_ft:51000, max_range_nm:6750, wing_span_m:28.5, length_m:29.4, mtow_t:41.28, max_passengers:18 },
  'CL60': { icao_type:'CL60', name:'BOMBARDIER Challenger 600', engine_type:'Jet', engine_code:'L2J', wake_category:'M', cruise_speed_ktas:459, service_ceiling_ft:41000, max_range_nm:3950, wing_span_m:19.61, length_m:20.85, mtow_t:21.86, max_passengers:19 },
  'LJ45': { icao_type:'LJ45', name:'LEARJET 45', engine_type:'Jet', engine_code:'L2J', wake_category:'L', cruise_speed_ktas:464, service_ceiling_ft:51000, max_range_nm:1960, wing_span_m:14.57, length_m:17.7, mtow_t:9.526, max_passengers:9 },
  // Turboprops & Trainers
  'PC12': { icao_type:'PC12', name:'PILATUS PC-12', engine_type:'Turboprop', engine_code:'T1', wake_category:'L', cruise_speed_ktas:270, service_ceiling_ft:30000, max_range_nm:1845, wing_span_m:16.28, length_m:14.4, mtow_t:4.74, max_passengers:9 },
  'TBM9': { icao_type:'TBM9', name:'DAHER TBM 900', engine_type:'Turboprop', engine_code:'T1', wake_category:'L', cruise_speed_ktas:330, service_ceiling_ft:31000, max_range_nm:1730, wing_span_m:12.85, length_m:10.68, mtow_t:3.354, max_passengers:6 },
};

const ipHits = new Map();
const IP_LIMIT_PER_MIN = 240;
function ipRateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let e = ipHits.get(ip);
  if (!e || now - e.windowStart > 60000) { e = { count: 0, windowStart: now }; ipHits.set(ip, e); }
  e.count++;
  return e.count > IP_LIMIT_PER_MIN;
}
setInterval(() => { const cutoff = Date.now() - 120000; for (const [ip, e] of ipHits) if (e.windowStart < cutoff) ipHits.delete(ip); }, 60000);

const server = http.createServer(async (req, res) => {
  try {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.method === 'GET' && req.url.startsWith('/api/') && !req.url.startsWith('/api/health') && ipRateLimited(req)) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

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

  if (req.method === 'GET' && (req.url === '/og-image.png' || req.url === '/og-image.jpg')) {
    const ext = req.url.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    const fname = fs.existsSync(path.join(__dirname, 'og-image.jpg')) ? 'og-image.jpg' : 'og-image.png';
    res.writeHead(200, { 'Content-Type': ext });
    res.end(fs.readFileSync(path.join(__dirname, fname)));
    return;
  }

  if (req.method === 'GET' && req.url === '/favicon.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(fs.readFileSync(path.join(__dirname, 'favicon.png')));
    return;
  }
  if (req.method === 'GET' && req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(path.join(__dirname, 'favicon.svg')));
    return;
  }
  if (req.method === 'GET' && req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
    return;
  }
  if (req.method === 'GET' && req.url === '/sw.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8'));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/health') {
    try {
      const usersSnap = await adminDb.collection('users').get();
      const users = usersSnap.docs.map(d => d.data());
      const pro = users.filter(u => u.plan === 'pro').length;
      const max = users.filter(u => u.plan === 'max').length;
      const mrr = (pro * 49) + (max * 99);
      const skylinkDoc = await adminDb.collection('system').doc('skylink_usage').get();
      const skylink = skylinkDoc.exists ? skylinkDoc.data() : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        users: usersSnap.size,
        pro, max, mrr,
        skylink_pct: skylink.pct || 0,
        skylink_count: skylink.count || 0
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(fs.readFileSync(path.join(__dirname, 'sitemap.xml'), 'utf8'));
    return;
  }
  if (req.method === 'GET' && req.url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(fs.readFileSync(path.join(__dirname, 'robots.txt'), 'utf8'));
    return;
  }
  if (req.method === 'GET' && (req.url === '/admin' || req.url === '/admin/')) {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // Calibration export (admin only, protected by CALIBRATION_KEY): one route -> a blind rater packet and, separately, the system's own rating.
  // Risk-rating feedback ("too low / about right / too high"): ongoing real-world validation data. Anonymous allowed; rate limited.
  if (req.method === 'POST' && req.url === '/api/rating-feedback') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4000) req.destroy(); });
    req.on('end', async () => {
      try {
        if (ipRateLimited(req)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'rate_limited' })); return; }
        const b = JSON.parse(body || '{}');
        const vote = String(b.vote || '');
        const route = String(b.route || '').toUpperCase().replace(/[^A-Z0-9 →>-]/g, '').slice(0, 24);
        const level = String(b.level || '').toUpperCase();
        const score = Number(b.score);
        if (!['low', 'ok', 'high'].includes(vote) || !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(level) || !(score >= 0 && score <= 10) || !route) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid' })); return;
        }
        const userId = await getVerifiedUserId(req).catch(() => null);
        await adminDb.collection('ratingFeedback').add({
          vote, route, level, score: Math.round(score), userId: userId || null,
          briefingId: String(b.briefingId || '').slice(0, 64) || null,
          note: String(b.note || '').slice(0, 300) || null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'failed' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/admin/rating-feedback')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const keyEnv = process.env.CALIBRATION_KEY || '';
    const given = q.get('key') || '';
    let okKey = keyEnv.length >= 16 && given.length === keyEnv.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(keyEnv));
    if (!okKey) {   // the admin page calls this with the signed-in admin's Firebase token
      try { const dec = await admin.auth().verifyIdToken((req.headers.authorization || '').replace('Bearer ', '')); okKey = dec.email === 'arslanni@gmail.com'; } catch (e) { okKey = false; }
    }
    if (!okKey) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    try {
      const snap = await adminDb.collection('ratingFeedback').orderBy('createdAt', 'desc').limit(2000).get();
      const total = { low: 0, ok: 0, high: 0 }, byLevel = {}, routes = {}, recent = [];
      snap.forEach(d => {
        const x = d.data();
        if (recent.length < 25) recent.push({ at: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null, route: x.route, level: x.level, score: x.score, vote: x.vote, user: x.userId ? 'signed-in' : 'anonymous' });
        total[x.vote]++;
        const L = (byLevel[x.level] = byLevel[x.level] || { low: 0, ok: 0, high: 0 }); L[x.vote]++;
        const R = (routes[x.route] = routes[x.route] || { low: 0, ok: 0, high: 0, scores: [] }); R[x.vote]++; R.scores.push(x.score);
      });
      const n = total.low + total.ok + total.high;
      const disagree = Object.entries(routes).filter(([, r]) => r.low + r.high >= 2 && r.low + r.high > r.ok).map(([k, r]) => ({ route: k, ...r }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n, agreement: n ? +(total.ok / n).toFixed(3) : null, total, byLevel, routesToReview: disagree, recent, note: 'low = rating too low (under-warns), high = rating too high (over-warns); last 2000 votes' }, null, 1));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Error'); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/admin/calibration')) {
    const q = new URL(req.url, 'http://x').searchParams;
    const keyEnv = process.env.CALIBRATION_KEY || '';
    const given = q.get('key') || '';
    const okKey = keyEnv.length >= 16 && given.length === keyEnv.length && require('crypto').timingSafeEqual(Buffer.from(given), Buffer.from(keyEnv));
    if (!okKey) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return; }
    const dep = (q.get('dep') || '').toUpperCase().trim(), arr = (q.get('arr') || '').toUpperCase().trim();
    const part = q.get('part') === 'system' ? 'system' : 'blind';
    if (!q.get('set') && (!/^[A-Z]{4}$/.test(dep) || !/^[A-Z]{4}$/.test(arr))) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('dep and arr must be 4-letter ICAO codes'); return; }
    try {
      const batch = q.get('set');
      if (batch) {
        const SETS = { '1': [['R01','LTAC','LTFM'],['R02','EHAM','LIRF'],['R03','KJFK','KLAX'],['R04','LTFM','OMDB']],
                       '2': [['R05','LTAC','OTHH'],['R06','LTFM','OLBA'],['R07','LTFM','LCLK'],['R08','LTFM','HECA']],
                       '3': [['R09','LTFM','UBBB'],['R10','LEMD','LEST'],['R11','YSSY','YPPH'],['R12','LTFM','OIIE']],
                       // hold-out routes (not used for tuning)
                       '4': [['H01','EGLL','LFPG'],['H02','EGLL','KJFK'],['H03','RJTT','RJOO'],['H04','LTFM','OERK']],
                       '5': [['H05','LTFM','OEJN'],['H06','LGAV','LLBG'],['H07','EFHK','EETN'],['H08','EGLL','EICK']],
                       '6': [['H09','DNMM','DNIM'],['H10','EBBR','EGLL'],['H11','UKBB','UKLL'],['H12','UUEE','URRR']],
                       // second hold-out (not used for tuning, after v3.29)
                       '7': [['H13','KATL','KORD'],['H14','OMDB','VIDP'],['H15','LFPG','GMMN'],['H16','OTHH','OMDB']],
                       '8': [['H17','LLBG','LCLK'],['H18','VHHH','RCTP'],['H19','SBGR','SCEL'],['H20','YSSY','NZAA']],
                       '9': [['H21','HECA','OJAI'],['H22','OIIE','OIII'],['H23','LTFM','LGAV'],['H24','EDDF','LOWW']] };
        const list = SETS[batch];
        if (!list) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('set must be 1 to 9'); return; }
        const outRoutes = [];
        for (const [id, d, a] of list) {
          try { const x = await calibrationExport(d, a); outRoutes.push({ id, dep: d, arr: a, snapshotUtc: x.now.toISOString(), system: x.system, packetMd: x.md }); }
          catch (e) { outRoutes.push({ id, dep: d, arr: a, error: e.message }); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="calibration_set' + batch + '_' + new Date().toISOString().replace(/[:T]/g, '').slice(0, 13) + 'Z.json"' });
        res.end(JSON.stringify({ set: batch, routes: outRoutes }, null, 1)); return;
      }
      const x = await calibrationExport(dep, arr);
      if (part === 'system') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="system_' + dep + '-' + arr + '_' + x.stamp + '.json"' });
        res.end(JSON.stringify(x.system, null, 2)); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="packet_' + dep + '-' + arr + '_' + x.stamp + '.md"' });
      res.end(x.md);
    } catch (e) {
      console.log('[CALIBRATION] error:', e.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Calibration export failed: ' + e.message);
    }
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
      <a href="https://notamai.onrender.com" style="text-decoration:none;display:flex;align-items:center;gap:8px;">
        <img src="https://notamai.onrender.com/favicon.png" alt="" style="width:30px;height:30px;border-radius:7px;">
        <span>
          <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#ffffff;">NOTAM</span>
          <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#4a9eff;">INTELLIGENCE</span>
        </span>
      </a>
      <span style="color:#1a2a3a;">|</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#2ec4b6;display:inline-block;animation:blinkDot 1.5s ease-in-out infinite;flex-shrink:0;"></span>
        <span style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;">SHARED BRIEFING</span>
      </div>
    </div>
    <a id="getAccessBtn" href="https://notamai.onrender.com/?signup=true" style="display:flex;align-items:center;gap:8px;background:transparent;border:1px solid rgba(74,158,255,0.3);color:#8a9bb0;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:500;letter-spacing:2px;padding:6px 14px;border-radius:6px;cursor:pointer;text-decoration:none;transition:color 0.2s,border-color 0.2s;" onmouseover="this.style.color='#c8daf0';this.style.borderColor='rgba(74,158,255,0.6)'" onmouseout="this.style.color='#8a9bb0';this.style.borderColor='rgba(74,158,255,0.3)'">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z" /></svg>
      GET STARTED FREE
    </a>
  </div>
  <div id="getAccessTooltip" style="display:none;position:fixed;background:#0a0f18;color:#cdd9e5;font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:400;padding:10px 14px;border-radius:8px;border:1px solid #1a2a3a;box-shadow:0 4px 20px rgba(0,0,0,0.5);white-space:normal;line-height:1.5;pointer-events:none;z-index:9999;max-width:280px;">Create a free account to generate your own AI-powered pre-flight briefings.</div>
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

  if (req.method === 'GET' && req.url.startsWith('/c/')) {
    const chatId = req.url.split('/c/')[1].split('?')[0];
    const shareHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NOTAM Intelligence — Aviation Chat</title>
<link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700;900&family=Rajdhani:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore-compat.js"></script>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #060a0f; color: #cdd9e5; font-family: 'Rajdhani', sans-serif; min-height: 100vh; }
#loadingScreen { display: flex; align-items: center; justify-content: center; min-height: 100vh; flex-direction: column; gap: 16px; }
#loadingText { font-family: 'Share Tech Mono', monospace; font-size: 14px; letter-spacing: 3px; color: #4a9eff; }
#chatContent { max-width: 680px; margin: 40px auto; padding: 0 24px 80px; }
@keyframes blinkDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
.msg-row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 18px; }
.msg-row.user { flex-direction: row-reverse; }
.msg-icon { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 2px; }
.msg-row.ai .msg-icon { background: rgba(74,158,255,0.12); border: 1px solid rgba(74,158,255,0.3); }
.msg-row.user .msg-icon { background: rgba(255,255,255,0.06); }
.msg-bubble { font-size: 15px; line-height: 1.55; color: #c8daf0; white-space: pre-wrap; max-width: 540px; padding-top: 2px; }
.msg-row.user .msg-bubble { color: rgba(255,255,255,0.82); text-align: right; }
</style>
</head>
<body>
<div id="loadingScreen">
  <div id="loadingText">LOADING CHAT...</div>
</div>
<div id="chatContent" style="display:none;">
  <div style="position:sticky;top:0;z-index:100;background:rgba(6,10,15,0.95);border-bottom:1px solid #1a2a3a;padding:0 24px;height:48px;display:flex;align-items:center;justify-content:space-between;backdrop-filter:blur(8px);">
    <div style="display:flex;align-items:center;gap:12px;">
      <a href="https://notamai.onrender.com" style="text-decoration:none;display:flex;align-items:center;gap:8px;">
        <img src="https://notamai.onrender.com/favicon.png" alt="" style="width:30px;height:30px;border-radius:7px;">
        <span>
          <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#ffffff;">NOTAM</span>
          <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#4a9eff;">INTELLIGENCE</span>
        </span>
      </a>
      <span style="color:#1a2a3a;">|</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#2ec4b6;display:inline-block;animation:blinkDot 1.5s ease-in-out infinite;flex-shrink:0;"></span>
        <span style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;">SHARED AVIATION CHAT</span>
      </div>
    </div>
    <a href="https://notamai.onrender.com/?signup=true" style="display:flex;align-items:center;gap:6px;background:rgba(74,158,255,0.08);border:1px solid rgba(74,158,255,0.2);color:#ffffff;font-family:'Rajdhani',sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;padding:6px 14px;border-radius:6px;cursor:pointer;text-decoration:none;">
      <span style="font-size:12px;">✨</span>
      GET FULL ACCESS
    </a>
  </div>
  <div style="max-width:680px;margin:16px auto 0;padding:0 24px;">
    <div style="background:rgba(244,132,26,0.07);border:1px solid rgba(244,132,26,0.25);border-radius:8px;padding:10px 14px;font-family:'Rajdhani',sans-serif;font-size:12.5px;color:rgba(244,180,120,0.9);">
      This is a shared conversation. Anyone with this link can view it — avoid sharing chats containing personal or sensitive information.
    </div>
  </div>
  <div id="chatBody" style="padding-top:24px;max-width:680px;margin:0 auto;padding-left:24px;padding-right:24px;"></div>
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

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

db.collection('general_chats').doc('${chatId}').get().then(doc => {
  if (doc.exists) {
    document.getElementById('loadingScreen').style.display = 'none';
    document.getElementById('chatContent').style.display = 'block';
    const messages = doc.data().messages || [];
    const body = document.getElementById('chatBody');
    messages.forEach(m => {
      const row = document.createElement('div');
      row.className = 'msg-row ' + (m.role === 'ai' ? 'ai' : 'user');
      const iconSvg = m.role === 'ai'
        ? '<svg width="13" height="13" viewBox="0 0 18 18" fill="none" stroke="#4a9eff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2 h16 a4 4 0 0 1 4 4 v9 a4 4 0 0 1 -4 4 h-9 l-4.5 4.5 v-4.5 h-2.5 a4 4 0 0 1 -4 -4 v-9 a4 4 0 0 1 4 -4 z" transform="scale(0.72)"/><path d="M14 9 L15 11.5 L17.5 12.5 L15 13.5 L14 16 L13 13.5 L10.5 12.5 L13 11.5 Z" fill="#4a9eff" stroke="none" transform="scale(0.72)"/></svg>'
        : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#8a9bb0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>';
      row.innerHTML = '<div class="msg-icon">' + iconSvg + '</div><div class="msg-bubble"></div>';
      row.querySelector('.msg-bubble').textContent = m.text;
      body.appendChild(row);
    });
    document.title = 'NOTAM Intelligence — Aviation Chat';
  } else {
    document.getElementById('loadingText').textContent = 'CHAT NOT FOUND';
  }
}).catch(() => {
  document.getElementById('loadingText').textContent = 'ERROR LOADING CHAT';
});
</script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(shareHtml);
    return;
  }

  // ── GENERATE VIDEO BRIEFING ───────────────────────────────────
  // ELEVENLABS_KEY must be set in Render environment variables
  if (req.method === 'POST' && req.url === '/api/generate-video-briefing') {
    console.log('[VIDEO BRIEFING] Request received');
    if (videoBriefingLock) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already processing, please wait' }));
      return;
    }
    videoBriefingLock = true;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let chargedUser = null, started = false;   // a video that fails before it starts gives the credit back
      try {
        const { route, briefingId, risk: clientRisk, localHour } = JSON.parse(body);
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }

        const vPlan = await getUserPlan(userId);
        if (limitPlanOf(vPlan) !== 'max' && vPlan !== 'admin') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'limit_reached', plan: vPlan, feature: 'video' }));
          return;
        }
        if (limitPlanOf(vPlan) === 'max') {
          const vUsed = await getUserUsage(userId, 'video');
          if (vUsed >= 5) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan: vPlan, feature: 'video', usage: vUsed, limit: 5 }));
            return;
          }
        }
        await incrementUsage(userId, 'video');
        chargedUser = userId;

        // Parse ICAO codes from route
        const icaos = route.trim().toUpperCase().split(/[\s,->]+/).filter(s => s.length === 4);
        const depIcao = icaos[0] || '';
        const arrIcao = icaos[1] || '';
        const T0 = Date.now(), lap = {};
        console.log('[VIDEO BRIEFING] Route:', route, 'DEP:', depIcao, 'ARR:', arrIcao);

        // NOTAMs through the same filter as the written briefing (in force now, not expired, not yet-to-start, no TRIGGER / PERM admin items;
        // SkyLink 5-min shared cache, normally already warm) and METARs, all four in parallel.
        console.log('[VIDEO] Fetching data for DEP:', depIcao, 'ARR:', arrIcao);
        const metarOf = icao => icao
          ? fetchURL('https://aviationweather.gov/api/data/metar?ids=' + icao + '&format=json').then(d => d?.[0]?.rawOb || '').catch(() => '')
          : Promise.resolve('');
        const [depRes, arrRes, depMetar, arrMetar, depName, arrName] = await Promise.all([fetchNotams(depIcao), fetchNotams(arrIcao), metarOf(depIcao), metarOf(arrIcao), fetchAndCacheAirportName(depIcao), fetchAndCacheAirportName(arrIcao)]);
        console.log('[VIDEO] NOTAMs in force DEP/ARR:', (depRes.activeItems || []).length, (arrRes.activeItems || []).length);
        lap.dataMs = Date.now() - T0;

        // The few NOTAMs worth speaking about: operational severity first (closures, navaid outages, restrictions), then recency. Purely
        // administrative text (AIRAC / AIP amendments, checklists) never reaches the script prompt.
        function getCriticalNotams(res, icao) {
          if (res && res.unavailable) return '[NOTAM data could not be retrieved for this airport — say so in one short sentence; do not say there are no NOTAMs]';
          const SORD = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
          const admin = t => /AIRAC|AIP\s*(AMDT|SUP|AIC)|CHECKLIST|\bTRIGGER\b|\bAIC\b/i.test(t);
          return [...((res && res.activeItems) || [])]
            .map(n => ({ n, t: String(n.raw || n.body || ''), sev: classifyNotamSeverity(n.raw || n.body || '') }))
            .filter(x => x.t && x.sev !== 'LOW' && !admin(x.t))
            .sort((a, b) => (SORD[a.sev] - SORD[b.sev]) || (notamRecencyKey(b.n) - notamRecencyKey(a.n)))
            .slice(0, 4)
            .map(x => x.t.replace(/\s+/g, ' ').trim().slice(0, 400))
            .join('\n');
        }

        let depNotamText = getCriticalNotams(depRes);
        let arrNotamText = getCriticalNotams(arrRes);
        console.log('[VIDEO] DEP NOTAM text length:', depNotamText.length);
        console.log('[VIDEO] ARR NOTAM text length:', arrNotamText.length);

        // Step 2: script. Fed with the written briefing's own deterministic risk result (posted by the page and validated here), so the
        // video can never contradict it; an elevated rating is stated plainly and the cheerful sign-off is replaced (video-script.js).
        let vRisk = videoScript.sanitizeRisk(clientRisk);
        if (!vRisk && depIcao && arrIcao) {
          // Video mode runs without a written briefing, so rate the route here with the same rubric (aerodromes + conflict-zone check;
          // no en-route NOTAM fetch, to keep time and SkyLink calls unchanged). Marked partial so the closing line never implies a clear route.
          try {
            const [mD, tD, mA, tA] = await Promise.all([fetchMetar(depIcao), fetchTaf(depIcao), fetchMetar(arrIcao), fetchTaf(arrIcao)]);
            const rr = await Promise.race([
              computeBriefingRisk({ icao_dep: depIcao, icao_arr: arrIcao, isSingleAirport: false, notamDepResult: depRes, notamArrResult: arrRes, enrouteCollector: [], metarDep: mD, metarArr: mA, tafDep: tD, tafArr: tA }),
              new Promise(resolve => setTimeout(() => resolve(null), 10000))
            ]);
            if (rr) {
              vRisk = videoScript.sanitizeRisk(risk.finalizeForClient(rr, '').riskSummary); if (vRisk) vRisk.partial = true;
              // Speak only about what the rubric itself rates Tier 1/2 at each aerodrome; minor items (e.g. one approach-light section) are left out.
              const keyNotams = (res, icao) => {
                if (!res || res.unavailable) return null;
                const ids = new Set((rr.factors || []).filter(f => f.scope === icao && f.tier <= 2).flatMap(f => f.ids || []));
                if (!ids.size) return '[No NOTAM at this airport is rated significant by the risk assessment — say there is nothing significant, in a few words]';
                const picked = (res.activeItems || []).concat(res.nearFutureItems || []).filter(n => ids.has(risk.idOf(n))).slice(0, 3);
                return picked.length ? picked.map(n => String(n.raw || n.body || '').replace(/\s+/g, ' ').trim().slice(0, 400)).join('\n') : null;
              };
              const kd = keyNotams(depRes, depIcao), ka = keyNotams(arrRes, arrIcao);
              if (kd) depNotamText = kd;
              if (ka) arrNotamText = ka;
            }
          } catch (e) { console.log('[VIDEO] risk fallback error:', e.message); }
        }
        lap.riskMs = Date.now() - T0;
        const greeting = videoScript.greetingFor(Number.isInteger(localHour) ? localHour : null, new Date().getUTCHours());
        const scriptPrompt = videoScript.buildScriptPrompt({ dep: depIcao, arr: arrIcao, depName, arrName, depNotamText, arrNotamText, depMetar, arrMetar, greeting, risk: vRisk });
        const scriptModels = [process.env.VIDEO_SCRIPT_MODEL || 'claude-sonnet-5-5', HAIKU_MODEL];
        let script = '';
        for (const model of scriptModels) {
          try {
            const scriptRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({
                model,
                max_tokens: 600,
                // Sonnet 5.5 settings as proven in the main briefing call: medium effort, lowest thinking level
                ...(model === 'claude-sonnet-5-5' ? { output_config: { effort: 'medium' }, thinking: { type: 'between_tools' } } : {}),
                ...(/^claude-haiku-5/i.test(model) ? { thinking: { type: 'disabled' } } : {}),
                messages: [{ role: 'user', content: scriptPrompt }]
              })
            });
            if (!scriptRes.ok) { console.log('[VIDEO SCRIPT] ' + model + ' HTTP ' + scriptRes.status, (await scriptRes.text()).slice(0, 200)); continue; }
            const scriptData = await scriptRes.json();
            const text = (scriptData.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
            const rawWords = videoScript.wordCount(text);
            const cleaned = videoScript.fitScript(videoScript.enforceSignoff(videoScript.cleanScript(text), vRisk), vRisk, 82);
            if (videoScript.wordCount(cleaned) >= 40) { script = cleaned; console.log('[VIDEO SCRIPT]', { model, rawWords, words: videoScript.wordCount(cleaned), risk: vRisk ? vRisk.level + ' ' + vRisk.score : null }); console.log('[VIDEO SCRIPT TEXT]', cleaned); break; }
            console.log('[VIDEO SCRIPT] ' + model + ' returned a script that is too short');
          } catch (e) { console.log('[VIDEO SCRIPT] ' + model + ' error:', e.message); }
        }
        if (!script) throw new Error('Script generation failed');
        lap.scriptMs = Date.now() - T0;

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
            // speed 1.1 (ElevenLabs range 0.7-1.2): same words in ~9% less audio, i.e. less WaveSpeed time and cost. VIDEO_TTS_SPEED overrides, 1 = old pace.
            voice_settings: { stability: 0.75, similarity_boost: 0.85, speed: Math.min(1.2, Math.max(0.9, parseFloat(process.env.VIDEO_TTS_SPEED) || 1.1)) }
          })
        });
        console.log('[TTS STATUS]', ttsRes.status);
        if (!ttsRes.ok) {
          const errText = await ttsRes.text();
          console.log('[TTS ERROR]', errText.slice(0, 200));
          notifyVideoProviderFailure('ElevenLabs', ttsRes.status, errText);
          throw new Error('ElevenLabs TTS failed: ' + ttsRes.status);
        }
        const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
        console.log('[VIDEO AUDIO] Size:', audioBuffer.length, 'bytes');
        lap.ttsMs = Date.now() - T0;
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
        if (!wsRes.ok || !predictionId) notifyVideoProviderFailure('WaveSpeed', wsRes.status, JSON.stringify(wsData));
        if (!wsRes.ok || !predictionId) throw new Error('Video service did not start the job: ' + JSON.stringify(wsData).slice(0, 200));
        lap.submitMs = Date.now() - T0;
        console.log('[VIDEO TIMING] cumulative ms since request start:', JSON.stringify(lap), 'script words:', videoScript.wordCount(script), 'audio bytes:', audioBuffer.length);
        console.log('[VIDEO BRIEFING] Started:', predictionId, 'Script:', script.slice(0, 50));

        // Step 5: Save to Firestore videos collection
        // Document id sorts newest-first in the Firestore console (which lists by id): "0-" + inverted timestamp + readable date/route.
        const nowD = new Date();
        const videoDocId = '0-' + String(9999999999999 - nowD.getTime()).padStart(13, '0') + '_' + nowD.toISOString().slice(0, 16).replace(/[-:T]/g, '') + '_' + (depIcao + '-' + arrIcao).replace(/[^A-Z0-9-]/g, '');
        await adminDb.collection('videos').doc(videoDocId).set({
          userId,
          route,
          briefingId: briefingId || null,
          predictionId,
          script,
          status: 'processing',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        started = true;
        watchVideo(predictionId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ predictionId, script }));
      } catch(e) {
        if (chargedUser && !started) { await decrementUsage(chargedUser, 'video'); console.log('[VIDEO BRIEFING] failed before start, credit restored:', e.message); }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        videoBriefingLock = false;
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/check-video-briefing/')) {
    const predId = req.url.split('/api/check-video-briefing/')[1];
    try {
      const out = await finalizeVideo(predId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
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
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/airports/search/text?q=' + encodeURIComponent(query) + '&limit=8', {
        headers: {
          'X-RapidAPI-Key': process.env.SKYLINK_KEY,
          'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
        }
      });

      console.log('[AIRPORT TEXT SEARCH]', query, JSON.stringify(data).slice(0,300));

      const airports = Array.isArray(data) ? data : (data?.airports || data?.results || []);
      const mapped = airports
        .filter(a => (a.icao || a.ident))
        .map(a => ({
          id: a.icao || a.ident,
          name: a.name || '',
          country: a.country || a.iso_country || '',
          city: a.city || a.municipality || ''
        }));

      // Sort: exact ICAO match first, then starts-with, then rest
      const q = query.toUpperCase();
      const results = mapped.sort((a, b) => {
        const aId = (a.id || '').toUpperCase();
        const bId = (b.id || '').toUpperCase();
        if (aId === q && bId !== q) return -1;
        if (bId === q && aId !== q) return 1;
        if (aId.startsWith(q) && !bId.startsWith(q)) return -1;
        if (bId.startsWith(q) && !aId.startsWith(q)) return 1;
        return 0;
      }).slice(0, 8);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch(e) {
      console.log('[AIRPORT SEARCH ERROR]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/pireps/')) {
    const icao = req.url.split('/api/raw/pireps/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://aviationweather.gov/api/data/pirep?id=' + icao + '&format=json&age=3&distance=200');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/delays/')) {
    const icao = req.url.split('/api/raw/delays/')[1].toUpperCase();
    if (!icao.startsWith('K') && !icao.startsWith('P')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ground_delays: [], ground_stops: [], closures: [], airspace_flow_programs: [], total_alerts: 0, not_us_airport: true }));
      return;
    }
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/delays/faa/' + icao, {
        headers: {
          'X-RapidAPI-Key': process.env.SKYLINK_KEY,
          'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
        }
      });
      console.log('[FAA DELAYS]', icao, JSON.stringify(data).slice(0,300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/charts/')) {
    const icao = req.url.split('/api/raw/charts/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/charts/' + icao, {
        headers: {
          'X-RapidAPI-Key': process.env.SKYLINK_KEY,
          'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
        }
      });
      console.log('[CHARTS]', icao, JSON.stringify(data).slice(0, 200));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/distance/')) {
    const parts = req.url.split('/api/distance/')[1].split('/');
    const origin = parts[0].toUpperCase();
    const dest = parts[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/distance?from_icao=' + origin + '&to_icao=' + dest, {
        headers: {
          'X-RapidAPI-Key': process.env.SKYLINK_KEY,
          'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
        }
      });
      console.log('[DISTANCE]', origin, dest, JSON.stringify(data).slice(0, 200));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/navaids/')) {
    const icao = req.url.split('/api/navaids/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/navaids?airport=' + icao, {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/ml-flighttime/')) {
    const parts = req.url.split('/api/ml-flighttime/')[1].split('/');
    const origin = parts[0].toUpperCase();
    const dest = parts[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/ml/flight-time?from=' + origin + '&to=' + dest, {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/flight-status/')) {
    const flightNum = req.url.split('/api/flight-status/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/flight_status/' + flightNum, {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      console.log('[FLIGHT STATUS]', flightNum, JSON.stringify(data).slice(0,300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/carbon/')) {
    const parts = req.url.split('/api/carbon/')[1].split('/');
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/carbon/estimate?departure_icao=' + parts[0] + '&arrival_icao=' + parts[1], {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      console.log('[CARBON]', parts[0], parts[1], JSON.stringify(data).slice(0,300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/aircraft-performance/')) {
    const icaoType = req.url.split('/api/aircraft-performance/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/aircraft/performance/' + icaoType, {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      console.log('[AIRCRAFT PERF]', icaoType, JSON.stringify(data).slice(0,300));
      if (data.detail || !data.icao_type) {
        if (AIRCRAFT_PERF_FALLBACK[icaoType]) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(AIRCRAFT_PERF_FALLBACK[icaoType]));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/routes/')) {
    const icao = req.url.split('/api/routes/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/routes/airport/' + icao + '?limit=20&direction=both', {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      console.log('[ROUTES]', icao, JSON.stringify(data).slice(0,300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/aircraft/')) {
    const reg = req.url.split('/api/aircraft/')[1].toUpperCase();
    try {
      const data = await fetchURL('https://skylink-api.p.rapidapi.com/aircraft/registration/' + reg, {
        headers: { 'X-RapidAPI-Key': process.env.SKYLINK_KEY, 'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com' }
      });
      console.log('[AIRCRAFT]', reg, JSON.stringify(data).slice(0,300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/airmet/')) {
    const icao = req.url.split('/api/airmet/')[1].toUpperCase();

    try {
      const data = await fetchURL('https://aviationweather.gov/api/data/airmet?format=json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/airsigmet/')) {
    const icao = req.url.split('/api/airsigmet/')[1].toUpperCase();
    try {
      // First get airport coordinates from aviationweather.gov
      const airportData = await fetchURL('https://aviationweather.gov/api/data/airport?ids=' + icao + '&format=json');
      const airport = Array.isArray(airportData) ? airportData[0] : null;

      if (!airport || !airport.lat || !airport.lon) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }

      const lat = airport.lat;
      const lon = airport.lon;
      const buffer = 3; // degrees, roughly 200nm
      const bbox = (lat - buffer) + ',' + (lon - buffer) + ',' + (lat + buffer) + ',' + (lon + buffer);

      const data = await fetchURL('https://skylink-api.p.rapidapi.com/weather/airsigmet?bbox=' + bbox, {
        headers: {
          'X-RapidAPI-Key': process.env.SKYLINK_KEY,
          'X-RapidAPI-Host': 'skylink-api.p.rapidapi.com'
        }
      });
      console.log('[AIRSIGMET]', icao, 'bbox:', bbox, JSON.stringify(data).slice(0, 300));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      console.log('[AIRSIGMET ERROR]', e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/raw/')) {
    const urlParams = req.url.replace('/api/raw/', '');
    const [type, icao] = urlParams.split('/');

    if (type === 'notam') {
      // v3.75: sign-in required and a per-user daily cap (METAR/TAF stay open: they come from the free aviationweather.gov).
      const rawUserId = await getVerifiedUserId(req);
      if (!rawUserId) {
        const notVerified = req._authError === 'email_not_verified';
        res.writeHead(notVerified ? 403 : 401, { 'Content-Type': 'text/plain' });
        res.end(notVerified ? 'VERIFY YOUR E-MAIL ADDRESS to view NOTAMs. METAR and TAF remain available.' : 'SIGN IN to view NOTAMs. METAR and TAF remain available without an account.');
        return;
      }
      const rawPlan = await getUserPlan(rawUserId);
      const rawSlot = await reserveRawNotamLookup(rawUserId, rawPlan);
      if (!rawSlot.ok) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('DAILY NOTAM LOOKUP LIMIT REACHED (' + rawSlot.limit + ' per day on your plan). It resets at 00:00 UTC. METAR and TAF remain available.' + (rawPlan === 'free' ? ' Upgrade to Pro for a higher limit.' : ''));
        return;
      }
      try {
        const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao + '?include_future=true';
        const data = await fetchURL(skyUrl, {
          method: 'GET',
          headers: {
            'x-rapidapi-key': process.env.SKYLINK_KEY,
            'x-rapidapi-host': 'skylink-api.p.rapidapi.com'
          }
        });
        console.log('[NOTAM RAW RESPONSE TYPE]', typeof data);
        console.log('[NOTAM RAW RESPONSE SAMPLE]', JSON.stringify(data).slice(0, 500));
        if (!skylinkNotamsOk(data)) {
          notifySkylinkFailure(icao);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('NOTAM DATA UNAVAILABLE for ' + icao + ' — the data provider returned no data (possible quota limit or outage). Do NOT assume there are no NOTAMs; check the official AIS/NOTAM office.');
          return;
        }
        if (data.notams.length === 0) {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('No active NOTAMs for ' + icao);
          return;
        }
        const now = new Date();
        const notExpired = n => {
          if (!n.expiration || n.expiration.length < 12) return true;
          const e = n.expiration;
          const expDate = new Date(Date.UTC(
            parseInt(e.slice(0,4)), parseInt(e.slice(4,6)) - 1, parseInt(e.slice(6,8)),
            parseInt(e.slice(8,10)), parseInt(e.slice(10,12))
          ));
          return expDate > now;
        };
        const isFutureEffective = n => {
          if (!n.effective || n.effective.length < 12) return false;
          const eff = n.effective;
          const effDate = new Date(Date.UTC(
            parseInt(eff.slice(0,4)), parseInt(eff.slice(4,6)) - 1, parseInt(eff.slice(6,8)),
            parseInt(eff.slice(8,10)), parseInt(eff.slice(10,12))
          ));
          return effDate > now;
        };
        const forThisIcao = n => !n.location || n.location.toUpperCase() === icao.toUpperCase();
        const active = data.notams.filter(n => notExpired(n) && !isFutureEffective(n) && forThisIcao(n))
        .sort((a, b) => {
          const dateA = a.effective || '0';
          const dateB = b.effective || '0';
          return dateB.localeCompare(dateA);
        });
        const futureNotams = data.notams.filter(n => notExpired(n) && isFutureEffective(n) && forThisIcao(n));
        const combined = [...active, ...futureNotams];
        const notamText = combined.map(n => {
          const isFuture = futureNotams.find(f => f.notam_id === n.notam_id);
          const id = n.notam_id || '';
          const refM = /NOTAM[RC]\s+([A-Z]\d{3,5}\/\d{2,4})/.exec(n.raw || '');   // the NOTAM that is replaced / cancelled
          const ntype = (n.type === 'R' ? 'NOTAMR' : n.type === 'C' ? 'NOTAMC' : 'NOTAMN') + (refM && n.type !== 'N' ? ' ' + refM[1] : '');
          const location = n.location || icao;
          const effective = n.effective ? n.effective.slice(2) : '';
          const expiration = n.expiration ? (n.expiration === 'PERM' ? 'PERM' : n.expiration.slice(2)) : 'PERM';
          const body = (n.body || '').trim() || (n.raw || '').replace(/^![A-Z]+ [A-Z0-9/]+\s*/, '').trim();
          let formatted = (isFuture ? '[FUTURE NOTAM - NOT YET ACTIVE]\n' : '') + id + '\t' + ntype + '\n';
          const qTxt = risk.qLine(n.raw || '');
          if (qTxt) formatted += 'Q) ' + qTxt + '\n';
          formatted += 'A) ' + location + '\n';
          formatted += 'B) ' + effective + ' C) ' + expiration + '\n';
          // Item D (daily / day-of-month schedule) decides on which days the NOTAM is really active — never leave it out of the panel.
          const dTxt = risk.dLine(n.raw || '');
          if (dTxt) formatted += 'D) ' + dTxt + '\n';
          formatted += 'E) ' + body;
          const fgTxt = risk.fgLine(n.raw || '');
          if (fgTxt) formatted += '\n' + fgTxt;
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

  // ── STRIPE CHECKOUT ──
  if (req.method === 'POST' && req.url === '/api/create-checkout') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }
        if (!stripe) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'payments_not_configured' })); return; }
        const { plan, interval } = JSON.parse(body);
        const iv = interval === 'year' ? 'year' : 'month';
        const priceId = STRIPE_PRICES[plan]?.[iv];
        if (!priceId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid_plan' })); return; }
        const snap = await adminDb.collection('users').doc(userId).get();
        const u = snap.exists ? snap.data() : {};
        if (u.stripeSubscriptionId && ['active', 'trialing', 'past_due'].includes(u.subscriptionStatus)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'already_subscribed' }));
          return;
        }
        const params = {
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          client_reference_id: userId,
          metadata: { user_id: userId, plan },
          subscription_data: { metadata: { user_id: userId, plan } },
          success_url: PUBLIC_BASE_URL + '/?upgrade=success',
          cancel_url: PUBLIC_BASE_URL + '/?upgrade=cancelled'
        };
        if (u.stripeCustomerId) params.customer = u.stripeCustomerId;
        else params.customer_email = (await admin.auth().getUser(userId)).email;
        if (!u.trialUsed) params.subscription_data.trial_period_days = 7;
        if (process.env.STRIPE_MANAGED_PAYMENTS !== 'false') params.managed_payments = { enabled: true };
        const session = await stripe.checkout.sessions.create(params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: session.url }));
      } catch (e) {
        console.log('[CHECKOUT ERROR]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STRIPE BILLING PORTAL ──
  if (req.method === 'POST' && req.url === '/api/billing-portal') {
    req.on('data', () => {});
    req.on('end', async () => {
      try {
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }
        const snap = await adminDb.collection('users').doc(userId).get();
        const u = snap.exists ? snap.data() : {};
        if (!stripe || !u.stripeCustomerId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no_subscription' })); return; }
        try {
          const portal = await stripe.billingPortal.sessions.create({ customer: u.stripeCustomerId, return_url: PUBLIC_BASE_URL + '/' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: portal.url }));
        } catch (pe) {
          console.log('[PORTAL] Falling back to Link:', pe.message);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: 'https://link.com', fallback: true }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── STRIPE WEBHOOK ──
  if (req.method === 'POST' && req.url === '/api/stripe-webhook') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let event;
      try {
        event = stripe.webhooks.constructEvent(Buffer.concat(chunks), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        console.log('[STRIPE WEBHOOK] Invalid signature:', e.message);
        res.writeHead(400); res.end('Bad signature'); return;
      }
      try {
        const obj = event.data.object;
        if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
          const sub = await stripe.subscriptions.retrieve(obj.subscription);
          await syncStripeSubscription(sub, obj.client_reference_id);
        } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
          await syncStripeSubscription(obj);
        } else if (event.type === 'invoice.payment_failed') {
          const uid = await findUserByStripeCustomer(obj.customer);
          await sendAdminNotification('⚠️ Payment failed — ' + (obj.customer_email || uid || obj.customer),
            '<div style="font-size:13px;color:#1e293b;">Stripe reported a failed invoice payment for ' + (obj.customer_email || obj.customer) + '. Stripe will retry automatically; the plan stays active until the subscription is cancelled.</div>');
        }
        res.writeHead(200); res.end('OK');
      } catch (e) {
        console.log('[STRIPE WEBHOOK ERROR]', e.message);
        res.writeHead(500); res.end('Error');
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/usage') {
    const authHeader = req.headers['authorization'] || '';
    let usageUserId = req.headers['x-user-id'];
    if (!usageUserId && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
        usageUserId = decoded.uid;
      } catch(e) {}
    }
    if (!usageUserId) { res.writeHead(401); res.end('Unauthorized'); return; }
    const userId = usageUserId;
    try {
      const plan = await getUserPlan(userId);
      const effectivePlan = limitPlanOf(plan);
      const limits = PLAN_LIMITS[effectivePlan] || PLAN_LIMITS.free;
      const now = new Date();
      const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const usageDoc = await adminDb.collection('usage').doc(userId + '_' + monthKey).get();
      const usageData = usageDoc.exists ? usageDoc.data() : {};
      const briefingsUsed = usageData.briefings || 0;
      const analysisUsed = usageData.analysis || 0;
      const videoUsed = usageData.video || 0;
      const { count: chatCount, tokenTotal: chatTokens, oldestTimestamp } = await getGeneralChatWindowUsage(userId, 300);
      const chatCfg = GENERAL_CHAT_LIMITS[effectivePlan] || GENERAL_CHAT_LIMITS.free;
      const resetInMinutes = minutesUntilWindowReset(oldestTimestamp, 300);
      const userDoc = await adminDb.collection('users').doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const daysUntilReset = Math.ceil((nextMonth - now) / (1000 * 60 * 60 * 24));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        plan,
        briefings: { used: briefingsUsed, limit: limits.briefings },
        analysis: { used: analysisUsed, limit: limits.analysis },
        video: { used: videoUsed, limit: plan === 'admin' ? 9999 : (limitPlanOf(plan) === 'max' ? 5 : 0) },
        chat: { tokens: chatTokens, limit: chatCfg.limit, resetInMinutes },
        monthlyResetDays: daysUntilReset,
        memberSince: userData.createdAt ? userData.createdAt.toDate().toISOString() : null
      }));
    } catch(e) {
      res.writeHead(500); res.end('Error');
    }
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
            model: HAIKU_MODEL, ...HAIKU_EXTRA,
            max_tokens: 50,
            system: 'You are an expert aviation dispatcher with complete knowledge of all world airports and their ICAO codes. Your only job is to extract one or two airports from any natural language input (in any language) and return their ICAO codes.\n\nRules:\n- Always use the main international airport for a city unless specified otherwise\n- Convert city names, country names, airport names, or any hint to the correct ICAO code\n- Support any language input (Turkish, English, Spanish, Arabic, etc.)\n- Examples: "Istanbul Frankfurt" -> "LTFM EDDF", "Barcelona Milan dedim" -> "LEBL LIMC", "Paris CDG to Dubai" -> "LFPG OMDB", "bugün istanbul londra var" -> "LTFM EGLL", "مطار دبي إلى لندن" -> "OMDB EGLL"\n- If the input contains ANY hint of two distinct locations — two city/airport names, two codes, or connecting words like "to"/"and"/"için"/"ile" — always return BOTH as a pair. Never silently drop the one you are less confident about; if you can identify it at all, include it.\n- Only return a single ICAO code when there is truly just one location mentioned with no indication of a second (e.g. "Istanbul", "tell me about LTFM")\n- Return ONLY the format: XXXX (single airport) or XXXX XXXX (two airports, space-separated) — exactly 4 letters per code\n- Return UNKNOWN only if you truly cannot identify even one airport',
            messages: [{ role: 'user', content: text }]
          })
        });
        const claudeData = await claudeRes.json();
        const result = claudeData.content?.[0]?.text?.trim() || 'UNKNOWN';
        if (result === 'UNKNOWN' || !result.match(/^[A-Z]{4}(\s[A-Z]{4})?$/)) {
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
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }
        {
          const plan = await getUserPlan(userId);
          if (plan === 'free') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upgrade_required', feature: 'analysis' }));
            return;
          }
          const effectivePlan = plan === 'admin' ? 'max' : limitPlanOf(plan);
          const usage = await getUserUsage(userId, 'analysis');
          const limit = PLAN_LIMITS[effectivePlan]?.analysis || 0;
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
        // No prefix filtering — let SkyLink validate, skip words that aren't airports
        const stopWords = new Set(['NOTAM','METAR','SIGMET','AIRMET','PIREP','SNOWTAM','ASHTAM','FROM','UNTIL','VALID','INFO','PERM','PANS','ICAO','NATO','TRUE','WIND','TEMP','DEW','PRES','FEET','KNOT','MILE','HOUR','TIME','DATE','ITEM','NOTE','TYPE','AREA','ACFT']);
        const uniqueIcaos = [...new Set(icaoMatches.filter(c => !stopWords.has(c)))];

        const airportNames = {};
        // Use aviationweather.gov for airport lookup — free, comprehensive, covers all ICAO codes
        const allIcaos = [...new Set([...uniqueIcaos, ...(notam || '').match(/\b[A-Z]{4}\b/g) || []])].filter(c => !stopWords.has(c)).slice(0, 10);
        for (const icao of allIcaos) {
          try {
            const data = await fetchURL(`https://aviationweather.gov/api/data/airport?ids=${icao}&format=json`);
            if (data && Array.isArray(data) && data.length > 0 && data[0].name) {
              const apt = data[0];
              const name = apt.name || '';
              const city = apt.city || '';
              const country = apt.country || '';
              airportNames[icao] = [name, city, country].filter(Boolean).join(', ');
              console.log('[ANALYSIS] AWC verified:', icao, '=', airportNames[icao]);
            }
          } catch(e) {
            console.log('[ANALYSIS] AWC lookup failed for', icao, e.message);
          }
        }

        // Fallback known airports for common codes not in SkyLink
        const KNOWN_AIRPORTS = {
          'LTFM': 'Istanbul Airport, Istanbul, Turkey',
          'LTBA': 'Istanbul Atatürk Airport, Istanbul, Turkey (CLOSED)',
          'LTAI': 'Antalya Airport, Antalya, Turkey',
          'LTAC': 'Ankara Esenboğa International Airport, Ankara, Turkey',
          'LTBJ': 'İzmir Adnan Menderes Airport, İzmir, Turkey',
          'LTFE': 'Milas-Bodrum Airport, Muğla, Turkey',
          'LTBS': 'Dalaman Airport, Muğla, Turkey',
          'LTCG': 'Trabzon Airport, Trabzon, Turkey',
          'LTCE': 'Erzurum Airport, Erzurum, Turkey',
          'LTCA': 'Elazığ Airport, Elazığ, Turkey',
          'LTAF': 'Adana Şakirpaşa Airport, Adana, Turkey',
          'LTAG': 'İncirlik Air Base, Adana, Turkey',
          'EGLL': 'London Heathrow Airport, London, United Kingdom',
          'EGKK': 'London Gatwick Airport, London, United Kingdom',
          'EHAM': 'Amsterdam Schiphol Airport, Amsterdam, Netherlands',
          'EDDF': 'Frankfurt Airport, Frankfurt, Germany',
          'LFPG': 'Paris Charles de Gaulle Airport, Paris, France',
          'LEMD': 'Madrid Barajas Airport, Madrid, Spain',
          'LIRF': 'Rome Fiumicino Airport, Rome, Italy',
          'LSZH': 'Zurich Airport, Zurich, Switzerland',
          'LOWW': 'Vienna International Airport, Vienna, Austria',
          'EPWA': 'Warsaw Chopin Airport, Warsaw, Poland',
          'LHBP': 'Budapest Ferenc Liszt Airport, Budapest, Hungary',
          'LKPR': 'Prague Václav Havel Airport, Prague, Czech Republic',
          'KJFK': 'John F. Kennedy International Airport, New York, USA',
          'KLAX': 'Los Angeles International Airport, Los Angeles, USA',
          'KORD': "O'Hare International Airport, Chicago, USA",
          'KATL': 'Hartsfield-Jackson Atlanta Airport, Atlanta, USA',
          'OMDB': 'Dubai International Airport, Dubai, UAE',
          'OMSJ': 'Sharjah International Airport, Sharjah, UAE',
          'OMAA': 'Abu Dhabi International Airport, Abu Dhabi, UAE',
          'OERK': 'King Khalid International Airport, Riyadh, Saudi Arabia',
          'OEDF': 'King Fahd International Airport, Dammam, Saudi Arabia',
          'OTHH': 'Hamad International Airport, Doha, Qatar',
          'OBBI': 'Bahrain International Airport, Manama, Bahrain',
          'OKBK': 'Kuwait International Airport, Kuwait City, Kuwait',
          'HECA': 'Cairo International Airport, Cairo, Egypt',
          'FACT': 'Cape Town International Airport, Cape Town, South Africa',
          'FAOR': 'O.R. Tambo International Airport, Johannesburg, South Africa',
          'VHHH': 'Hong Kong International Airport, Hong Kong',
          'RJTT': 'Tokyo Haneda Airport, Tokyo, Japan',
          'RJAA': 'Tokyo Narita Airport, Tokyo, Japan',
          'RKSI': 'Incheon International Airport, Seoul, South Korea',
          'WSSS': 'Singapore Changi Airport, Singapore',
          'YSSY': 'Sydney Kingsford Smith Airport, Sydney, Australia',
          'YMML': 'Melbourne Airport, Melbourne, Australia',
          'ULLI': 'Pulkovo Airport, Saint Petersburg, Russia',
          'UUEE': 'Sheremetyevo International Airport, Moscow, Russia',
          'UUWW': 'Vnukovo International Airport, Moscow, Russia',
          'UUDD': 'Domodedovo International Airport, Moscow, Russia',
          'URSS': 'Sochi International Airport, Sochi, Russia',
          'USSS': 'Koltsovo International Airport, Yekaterinburg, Russia',
          'UNNT': 'Tolmachevo Airport, Novosibirsk, Russia',
          'UHWW': 'Vladivostok International Airport, Vladivostok, Russia',
          'UHMM': 'Magadan Airport, Magadan, Russia',
          'UKBB': 'Boryspil International Airport, Kyiv, Ukraine',
          'UKLL': 'Lviv Danylo Halytskyi International Airport, Lviv, Ukraine',
          'UMMS': 'Minsk National Airport, Minsk, Belarus',
          'EVRA': 'Riga International Airport, Riga, Latvia',
          'EYVI': 'Vilnius Airport, Vilnius, Lithuania',
          'EETN': 'Lennart Meri Tallinn Airport, Tallinn, Estonia',
          'UGGG': 'Tbilisi International Airport, Tbilisi, Georgia',
          'UBBB': 'Heydar Aliyev International Airport, Baku, Azerbaijan',
          'UDYZ': 'Zvartnots International Airport, Yerevan, Armenia',
          'UAAA': 'Almaty International Airport, Almaty, Kazakhstan',
          'UACC': 'Nursultan Nazarbayev International Airport, Astana, Kazakhstan',
          'UTDD': 'Dushanbe International Airport, Dushanbe, Tajikistan',
          'UTAA': 'Ashgabat International Airport, Ashgabat, Turkmenistan',
          'UTTT': 'Tashkent International Airport, Tashkent, Uzbekistan',
          'UCFM': 'Manas International Airport, Bishkek, Kyrgyzstan',
        };

        // Merge SkyLink results with known airports fallback
        // The curated list wins over the AWC name (AWC still returns 'ISTANBUL INTERNATIONAL AIRPORT' for LTFM); the briefing uses SkyLink's current name.
        const mergedAirportNames = Object.assign({}, airportNames, KNOWN_AIRPORTS);

        const airportContext = Object.keys(mergedAirportNames).length > 0
          ? '\n\nVERIFIED AIRPORT NAMES (use EXACTLY as provided, never modify):\n' + Object.entries(mergedAirportNames).map(([k, v]) => k + ' = ' + v).join('\n')
          : '';

        let analyzeSystemPrompt;
        if (type === 'SIGMET') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist and AIM specialist with complete and verified knowledge of all world FIRs.\n\nVERIFIED FIR IDENTIFIERS (use ONLY these, never guess):\n\nTURKEY:\nLTAA = Ankara FIR (Turkey) - covers central/eastern Turkey\nLTBB = Istanbul FIR (Turkey) - covers western Turkey and Thrace\n\nEUROPE:\nEGTT = London FIR (UK)\nEGPX = Scottish FIR (UK)\nEGGX = Shanwick Oceanic FIR (UK/Ireland)\nEISN = Shannon FIR (Ireland)\nLFFF = Paris FIR (France)\nLFMM = Marseille FIR (France)\nEDGG = Langen FIR (Germany)\nEDMM = Munich FIR (Germany)\nLIIV = Roma FIR (Italy)\nLIPZ = Padova FIR (Italy)\nLECM = Madrid FIR (Spain)\nLEMD = Canarias FIR (Spain)\nLPPC = Lisboa FIR (Portugal)\nEBUR = Brussels FIR (Belgium)\nEHAA = Amsterdam FIR (Netherlands)\nEKDK = Copenhagen FIR (Denmark)\nENOR = Oslo FIR (Norway)\nESAA = Stockholm FIR (Sweden)\nEFIN = Helsinki FIR (Finland)\nBIRD = Reykjavik FIR (Iceland)\nEPWW = Warsaw FIR (Poland)\nLKAA = Praha FIR (Czech Republic)\nLOVV = Wien FIR (Austria)\nLSZR = Zurich FIR (Switzerland)\nLJLA = Ljubljana FIR (Slovenia)\nLDZO = Zagreb FIR (Croatia)\nLYBA = Beograd FIR (Serbia)\nLBSR = Sofia FIR (Bulgaria)\nLRBB = Bucuresti FIR (Romania)\nLHCC = Budapest FIR (Hungary)\nLZBB = Bratislava FIR (Slovakia)\nLGGG = Athinai FIR (Greece)\nLCCC = Nicosia FIR (Cyprus)\n\nMIDDLE EAST:\nORBB = Baghdad FIR (Iraq)\nOSTT = Damascus FIR (Syria)\nOJAC = Amman FIR (Jordan)\nOLBB = Beirut FIR (Lebanon)\nHECC = Cairo FIR (Egypt)\nOEJD = Jeddah FIR (Saudi Arabia)\nOOKB = Muscat FIR (Oman)\nOMAE = Emirates FIR (UAE)\nOBBB = Bahrain FIR (Bahrain/Qatar area)\nOTBD = Doha FIR (Qatar)\nOYSC = Sanaa FIR (Yemen)\nOIIX = Tehran FIR (Iran)\nOPKR = Karachi FIR (Pakistan)\nOPLA = Lahore FIR (Pakistan)\n\nCENTRAL ASIA:\nUTAA = Ashgabat FIR (Turkmenistan)\nUCFM = Bishkek FIR (Kyrgyzstan)\nUAAA = Almaty FIR (Kazakhstan)\nUACC = Astana FIR (Kazakhstan)\nUGGG = Tbilisi FIR (Georgia)\nUDDD = Yerevan FIR (Armenia)\nUBBA = Baku FIR (Azerbaijan)\n\nRUSSIA/CIS:\nUUWV = Moskva FIR (Russia - Moscow)\nULLL = Sankt-Peterburg FIR (Russia)\nUNNT = Novosibirsk FIR (Russia)\nUHHH = Khabarovsk FIR (Russia)\nUEEE = Yakutsk FIR (Russia)\nUHPP = Petropavlovsk FIR (Russia)\nUKBV = Kyiv FIR (Ukraine)\nUMMV = Minsk FIR (Belarus)\n\nSOUTH ASIA:\nVIDF = Delhi FIR (India)\nVECF = Calcutta FIR (India)\nVAAF = Mumbai FIR (India)\nVOCB = Chennai FIR (India)\nVCCF = Colombo FIR (Sri Lanka)\nVNKT = Kathmandu FIR (Nepal)\nVGDT = Dhaka FIR (Bangladesh)\n\nSOUTHEAST ASIA:\nVTBB = Bangkok FIR (Thailand)\nVVHM = Ho Chi Minh FIR (Vietnam)\nVVHN = Hanoi FIR (Vietnam)\nWMFC = Kuala Lumpur FIR (Malaysia)\nWBFC = Kota Kinabalu FIR (Malaysia)\nWSJC = Singapore FIR (Singapore - NOT Jakarta)\nWAAF = Jakarta FIR (Indonesia)\nWIIF = Ujung Pandang FIR (Indonesia)\nRPHI = Manila FIR (Philippines)\nVDPP = Phnom Penh FIR (Cambodia)\nVLVT = Vientiane FIR (Laos)\nVYYY = Yangon FIR (Myanmar)\n\nEAST ASIA:\nZBPE = Beijing FIR (China)\nZSHA = Shanghai FIR (China)\nZGZU = Guangzhou FIR (China)\nZWWW = Urumqi FIR (China)\nRJJJ = Fukuoka FIR (Japan)\nRKRR = Incheon FIR (South Korea)\nRCTP = Taipei FIR (Taiwan)\nVHHH = Hongkong FIR (China/HK)\nVMMC = Macau FIR\nZPKM = Kunming FIR (China)\n\nOCEANIC:\nKZNY = New York Oceanic FIR (USA)\nKZAK = Oakland Oceanic FIR (USA)\nCZQX = Gander Oceanic FIR (Canada)\nNFFF = Nadi FIR (Fiji)\nNTTT = Tahiti FIR (French Polynesia)\nYMMM = Melbourne FIR (Australia)\nNZZC = Auckland FIR (New Zealand)\n\nNORTH AMERICA:\nKZJX = Jacksonville FIR (USA)\nKZHU = Houston FIR (USA)\nKZFW = Fort Worth FIR (USA)\nKZKC = Kansas City FIR (USA)\nKZMP = Minneapolis FIR (USA)\nKZMA = Miami FIR (USA)\nKZSE = Seattle FIR (USA)\nKZLA = Los Angeles FIR (USA)\nCZUL = Montreal FIR (Canada)\nCZVR = Vancouver FIR (Canada)\nCZEG = Edmonton FIR (Canada)\nCZWG = Winnipeg FIR (Canada)\nMMEX = Mexico FIR (Mexico)\n\nAFRICA:\nDAAA = Alger FIR (Algeria)\nDTTC = Tunis FIR (Tunisia)\nGMMM = Casablanca FIR (Morocco)\nHECC = Cairo FIR (Egypt)\nHAAA = Addis Abeba FIR (Ethiopia)\nHCSM = Mogadishu FIR (Somalia)\nHKNA = Nairobi FIR (Kenya)\nHRRR = Kigali FIR (Rwanda)\nHTTT = Dar es Salaam FIR (Tanzania)\nFAJA = Johannesburg FIR (South Africa)\nFZAA = Kinshasa FIR (DRC)\nDNKK = Kano FIR (Nigeria)\nDGAC = Accra FIR (Ghana)\nDBBB = Cotonou FIR (Benin)\nGOOO = Dakar Oceanic FIR (Senegal)\n\nAnalyze this SIGMET and provide:\n1. Correct FIR name and country using mappings above\n2. Hazard type with operational significance\n3. Affected altitude range (FL)\n4. Active time period (UTC)\n5. Operational impact and specific crew actions\n\nBe concise, 4-5 bullet points, practical for crews.';
        } else if (type === 'METAR') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. Extract the 4-letter ICAO code directly from the METAR/TAF text (first identifier after the report type).\n2. If verified airport names are provided in the prompt, use them EXACTLY as given.\n3. If no verified name is provided, use ONLY the raw ICAO code — write "Airport [ICAO CODE]". Do NOT guess the name.\n4. NEVER invent, guess, or hallucinate airport names.\n\nDecode this METAR and provide:\n1. Airport name and ICAO code (verified correct)\n2. Current conditions summary (wind, visibility, weather)\n3. Ceiling and cloud layers\n4. Temperature, dewpoint, pressure\n5. Any hazards or significant phenomena\n6. Operational recommendation (VFR/IFR/MVFR status)\n\nBe concise, 4-6 bullet points, practical for flight crews.';
        } else if (type === 'TAF') {
          analyzeSystemPrompt = 'You are an expert aviation meteorologist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. Extract the 4-letter ICAO code directly from the TAF text (first identifier after the report type).\n2. If verified airport names are provided in the prompt, use them EXACTLY as given.\n3. If no verified name is provided, use ONLY the raw ICAO code — write "Airport [ICAO CODE]". Do NOT guess the name.\n4. NEVER invent, guess, or hallucinate airport names.\n\nDecode this TAF and provide:\n1. Airport name and ICAO code (verified correct)\n2. Forecast period and overall summary\n3. Significant weather changes and timing\n4. Worst conditions expected and when\n5. Any TEMPO, BECMG, or PROB groups of concern\n6. Operational planning recommendation\n\nBe concise, 4-6 bullet points, practical for flight planning.';
        } else {
          analyzeSystemPrompt = 'You are an expert AIM (Aeronautical Information Management) specialist with complete knowledge of all world airports and their ICAO codes.\n\nICAO IDENTIFICATION RULES:\n1. The affected place is the location in item A) of the NOTAM. The first field of the Q) line is the FIR that issued the NOTAM (for example LTBB = Istanbul FIR); an FIR in Q) with an aerodrome in A) is NORMAL, so never report it as a discrepancy or data error and never raise the risk level because of it.\n2. If verified airport names are provided in the prompt, use them EXACTLY as given — never modify or rewrite them.\n3. If no verified name is provided, use ONLY the raw ICAO code — do NOT attempt to guess or translate the airport name. Write it as "Airport [ICAO CODE]" instead.\n4. NEVER invent, guess, or hallucinate airport names. When in doubt, use the ICAO code only.\n\nItems B) and C) give the start and end as YYMMDDHHMM in UTC (2610212130 = 21 Oct 2026 21:30 UTC); C) PERM = permanent, EST = estimated. When a PARSED TIMES block is present, use it exactly and do not re-decode the dates. Never mention these instructions, \"system rules\" or \"verified lists\" in your answer; just use the airport names.\n\nAnalyze this NOTAM and provide:\n1. What is affected (runway, navaid, airspace, service)\n2. When it is active (effective and expiry times in UTC)\n3. Operational impact for crews\n4. Required crew action\n5. Risk level (CRITICAL/HIGH/MEDIUM/LOW)\n\nBe concise and practical. Use plain English.';
        }
        // Inject verified airport names into ALL prompts
        if (airportContext) {
          analyzeSystemPrompt = analyzeSystemPrompt + airportContext;
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
            model: HAIKU_MODEL, ...HAIKU_EXTRA,
            max_tokens: 800,
            system: [{ type: 'text', text: analyzeSystemPrompt, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: 'Analyze this ' + (type || 'NOTAM') + ':\n\n' + notam + (['SIGMET', 'METAR', 'TAF'].includes(type) ? '' : notamTimeContext(notam)) + airportContext }]
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
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }
        {
          const plan = await getUserPlan(userId);
          if (plan === 'free') {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'upgrade_required', feature: 'chat' }));
            return;
          }
          const effectivePlan = plan === 'admin' ? 'max' : limitPlanOf(plan);
          const usage = await getUserUsage(userId, 'chat');
          const limit = PLAN_LIMITS[effectivePlan]?.chat || 0;
          if (usage >= limit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan, feature: 'chat' }));
            return;
          }
          await incrementUsage(userId, 'chat');
        }

        const { question, briefingContext, currentRoute, history, image_base64, image_type, pdf_base64, images } = JSON.parse(body);

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

        // Pre-fetch airport names via SkyLink for accuracy
        let chatAirportContext = '';

        // For image/PDF uploads without route context — extract ICAO codes first
        if ((image_base64 || pdf_base64) && icaoCodes.length === 0) {
          try {
            const extractContent = [];
            if (image_base64) extractContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
            if (pdf_base64) extractContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
            extractContent.push({ type: 'text', text: 'Extract ALL 4-letter ICAO airport codes from this document. Return ONLY the codes separated by spaces, nothing else.' });
            const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: HAIKU_MODEL, ...HAIKU_EXTRA, max_tokens: 50, messages: [{ role: 'user', content: extractContent }] })
            });
            const extractData = await extractRes.json();
            const extractedText = extractData.content?.[0]?.text || '';
            const stopWords = new Set(['NOTAM','METAR','SIGMET','FROM','UNTIL','VALID','INFO','PERM','TRUE','WIND','TEMP','PRES','FEET','KNOT']);
            const imageCodes = [...new Set((extractedText.match(/\b[A-Z]{4}\b/g) || []).filter(c => !stopWords.has(c)))].slice(0, 5);
            imageCodes.forEach(c => { if (!icaoCodes.includes(c)) icaoCodes.push(c); });
            console.log('[CHAT] Extracted ICAO codes from image:', imageCodes);
          } catch(e) {
            console.log('[CHAT] ICAO extraction failed:', e.message);
          }
        }

        if (icaoCodes.length > 0) {
          const names = await Promise.all(icaoCodes.slice(0, 5).map(c => fetchAndCacheAirportName(c)));
          const verified = icaoCodes.slice(0, 5).map((c, i) => names[i] !== c ? `${c} = ${names[i]}` : null).filter(Boolean);
          if (verified.length > 0) {
            chatAirportContext = `\n\nVERIFIED AIRPORT NAMES (from SkyLink database — use EXACTLY, never modify):\n${verified.join('\n')}\nFor any ICAO code not listed, write "Airport [ICAO CODE]" — never guess.`;
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
              const skyUrl = 'https://skylink-api.p.rapidapi.com/notams/' + icao + '?include_future=true';
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

${liveData ? 'LIVE REAL-TIME DATA FETCHED:\n' + liveData : ''}${chatAirportContext}

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
        if (images && Array.isArray(images)) {
          images.forEach(img => userContent.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data } }));
        } else if (image_base64) {
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
            model: HAIKU_MODEL, ...HAIKU_EXTRA,
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

  if (req.method === 'POST' && req.url === '/api/general-chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }

        const plan = await getUserPlan(userId);
        const cfg = GENERAL_CHAT_LIMITS[limitPlanOf(plan)] || GENERAL_CHAT_LIMITS.free;
        const { count, tokenTotal, searchTotal, oldestTimestamp } = await getGeneralChatWindowUsage(userId, cfg.windowMinutes);
        const resetInMinutes = minutesUntilWindowReset(oldestTimestamp, cfg.windowMinutes);

        const currentUsage = tokenTotal; // all plans are token-based now
        const hardLimitReached = currentUsage >= cfg.limit;
        const softLimitThreshold = cfg.softLimitRatio ? cfg.limit * cfg.softLimitRatio : cfg.limit;
        const pastSoftLimit = currentUsage >= softLimitThreshold;

        if (hardLimitReached) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'limit_reached',
            usagePercent: 100,
            resetInMinutes,
            message: plan === 'free'
              ? "You've reached your chat limit for this window. Upgrade to Pro for much higher limits, or try again once it resets."
              : "You've reached your chat limit for this window. Try again once it resets."
          }));
          return;
        }

        const modelToUse = pastSoftLimit ? GENERAL_CHAT_FALLBACK_MODEL : cfg.model;
        const searchCapForPlan = GENERAL_CHAT_WEB_SEARCH_CAP[limitPlanOf(plan)] || 0;
        const webSearchEnabled = GENERAL_CHAT_WEB_SEARCH_PLANS.includes(limitPlanOf(plan)) && !pastSoftLimit && searchTotal < searchCapForPlan;

        const { question, history, image_base64, image_type, pdf_base64, extra_text, images } = JSON.parse(body);
        if (!question && !image_base64 && !pdf_base64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ answer: 'No question provided.' }));
          return;
        }
        const effectiveQuestion = question || 'Please analyze this attached document.';

        // Extract ICAO codes from file if uploaded — fetch verified names via SkyLink
        let generalChatAirportContext = '';
        if (image_base64 || pdf_base64) {
          try {
            const extractContent = [];
            if (image_base64) extractContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
            if (pdf_base64) extractContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
            extractContent.push({ type: 'text', text: 'Extract ALL 4-letter ICAO airport codes from this document. Return ONLY the codes separated by spaces, nothing else.' });
            const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: HAIKU_MODEL, ...HAIKU_EXTRA, max_tokens: 50, messages: [{ role: 'user', content: extractContent }] })
            });
            const extractData = await extractRes.json();
            const extractedText = extractData.content?.[0]?.text || '';
            const stopWords = new Set(['NOTAM','METAR','SIGMET','FROM','UNTIL','VALID','INFO','PERM','TRUE','WIND','TEMP','PRES','FEET','KNOT']);
            const imageCodes = [...new Set((extractedText.match(/\b[A-Z]{4}\b/g) || []).filter(c => !stopWords.has(c)))].slice(0, 5);
            if (imageCodes.length > 0) {
              const names = await Promise.all(imageCodes.map(c => fetchAndCacheAirportName(c)));
              const verified = imageCodes.map((c, i) => names[i] !== c ? `${c} = ${names[i]}` : null).filter(Boolean);
              // Also add FIR name corrections
              const firNames = {
                'LTBB': 'Istanbul FIR', 'LTAA': 'Ankara FIR', 'LTCC': 'Istanbul Oceanic FIR',
                'EGTT': 'London FIR', 'EGPX': 'Scottish FIR', 'EDGG': 'Langen FIR',
                'EDWW': 'Bremen FIR', 'EDMM': 'Munich FIR', 'LFBB': 'Bordeaux FIR',
                'LFEE': 'Reims FIR', 'LFMM': 'Marseille FIR', 'LFPP': 'Paris FIR',
                'LECB': 'Barcelona FIR', 'LECM': 'Madrid FIR', 'LIBB': 'Brindisi FIR',
                'LIMM': 'Milano FIR', 'LIRR': 'Roma FIR', 'OMAE': 'Emirates FIR',
                'OKAC': 'Kuwait FIR', 'ORBB': 'Baghdad FIR', 'OSTT': 'Damascus FIR'
              };
              const firContext = imageCodes.filter(c => firNames[c]).map(c => `${c} = ${firNames[c]}`).join('\n');
              if (verified.length > 0 || firContext) {
                generalChatAirportContext = `\n\nVERIFIED NAMES (from SkyLink database — use EXACTLY, never modify):\n${[...verified, ...(firContext ? [firContext] : [])].join('\n')}\nFor any code not listed, write the code only — never guess.`;
              }
            }
          } catch(e) {
            console.log('[GENERAL CHAT] ICAO extraction failed:', e.message);
          }
        }

        // Detect NOTAM production/drafting requests — use Opus 5 for accuracy
        const isNotamProduction = /notam.*hazırla|notam.*yaz|notam.*üret|yayına hazırla|notam talep.*form|produce.*notam|draft.*notam|generate.*notam|notam.*draft|icao.*format.*notam|q.?line.*oluştur/i.test(effectiveQuestion);
        const opusAllowed = isNotamProduction && ['pro', 'max', 'admin'].includes(plan) && !pastSoftLimit;
        const chatModel = opusAllowed ? 'claude-opus-5-5' : modelToUse;
        if (opusAllowed) console.log('[NOTAM PRODUCTION] Using Opus 5.5 for NOTAM drafting');

        const systemPrompt = `You are a world-class aviation expert assistant and certified AIM (Aeronautical Information Management) specialist embedded in NOTAM Intelligence, a professional pre-flight briefing platform used by pilots and flight dispatchers. You have the depth of knowledge of a senior airline captain, a flight dispatcher, an AIM specialist working under DHMI/EUROCONTROL standards, and an aviation safety instructor combined.

## NOTAM PRODUCTION CAPABILITY
When asked to draft, produce, validate, or format a NOTAM (in any language), you follow ICAO Annex 15 and PANS-AIM Doc 10066 strictly. You are an expert in:

### NOTAM FORMAT (ICAO):
\`\`\`
[NOTAM NUMBER]/[YEAR] NOTAM[N/R/C]
Q) [FIR]/[QCODE]/[TRAFFIC]/[PURPOSE]/[SCOPE]/[LOWER]/[UPPER]/[COORDINATES RADIUS]
A) [LOCATION ICAO]
B) [START: YYMMDDHHmm]
C) [END: YYMMDDHHmm or PERM or EST]
D) [SCHEDULE - if applicable]
E) [FREE TEXT - English, clear, concise]
F) [LOWER LIMIT - if applicable]
G) [UPPER LIMIT - if applicable]
\`\`\`

### Q-LINE CODES (most common):
- QOBCE — Obstacle (crane, building, structure) — new
- QOBCA — Obstacle cancelled
- QMXXX — Aerodrome closed
- QMKXX — Aerodrome operating hours
- QRALC — Low-level windshear alert cancelled
- QWLLW — Low-level windshear
- QICAS — ILS critical/sensitive area
- QILAS — ILS approach system
- QNVAS — VOR/NDB unserviceable
- QRTCA — Restricted area activated
- QLCAS — Apron/taxiway closed
- QMRXX — Runway condition
- QFAHX — Aerodrome fire service
- QPNLT — PAPI/VASI unserviceable

### Q-LINE STRUCTURE:
\`Q) FIR/QCODE/IV/BO/AE/000/999/COORDSRADIUS\`
- Traffic (IV = IFR+VFR, I = IFR only, V = VFR only, K = checklist)
- Purpose (N=Notam, B=Briefing, O=Pre-flight, M=Misc, BO=Briefing+Pre-flight)
- Scope (A=Aerodrome, E=En-route, W=Nav warning, AE=Aerodrome+En-route)
- Lower/Upper limits in FL (000/999 = SFC to UNL)
- Coordinates: DDMMN/DDDMME + radius in NM (e.g. 3933N02701E005)

### ICAO CODE POLICY:
- You cover ALL countries worldwide — not just Turkey
- For ANY airport/FIR ICAO code, use web search to verify if not 100% certain
- Common prefixes: LT* = Turkey, EG* = UK, ED* = Germany, LF* = France, K* = USA, Y* = Australia, Z* = China, etc.
- Turkish airports are common in your usage context — extra caution: LTFD=Balıkesir Koca Seyit, LTFE=Milas-Bodrum, LTBS=Dalaman, LTBF=Balıkesir Merkez (these are commonly confused)
- For any other country: ALWAYS verify via web search before using

### COORDINATE FORMAT (ICAO):
- DMS to decimal: DD°MM'SS.ss" → DDMM.ssN/DDDDMM.ssE
- Q-line format: DDMMN/DDDMME (e.g. 3933N02701E)
- E) bölümündeki koordinatlar: DDMMSSsN DDDMMSSsE (e.g. 393332N 0270117E)

### NOTAM VALIDATION RULES:
1. B) ve C) süreleri UTC olmalı — yerel saat kabul edilmez
2. E) metni İngilizce, büyük harf, ICAO abbreviation kullanılmalı
3. Koordinatlar WGS-84 sisteminde olmalı
4. OBCE (mania) NOTAMlarında: koordinat, yükseklik (AMSL ve AGL), etki yarıçapı zorunlu
5. D) bölümü: günlük schedule varsa HH:MM-HH:MM UTC formatı
6. NOTAM C) süresi EST ise açıklama E) bölümünde olmalı

### MANIA (OBCE) NOTAM KURALLARI:
- Vinç/yapı yüksekliği AMSL (above mean sea level) ve AGL (above ground level) olarak belirtilmeli
- Q-line scope: AE (aerodrome + en-route)
- F) alt limit: SFC veya GND
- G) üst limit: yükseklik FT AMSL (örn: 500FT AMSL)
- Koordinat: yapının tam koordinatı + etki yarıçapı NM olarak
- Işık durumu: LGT veya UNLTD (if lit)

### WHEN GIVEN A NOTAM REQUEST FORM:
1. Önce form verilerini analiz et
2. Eksik/hatalı bilgileri listele
3. ICAO formatında tam NOTAM metnini üret
4. Q-line'ı oluştur
5. D) schedule varsa ekle
6. Olası hataları ve dikkat edilmesi gereken noktaları belirt

Produce the NOTAM summary and explanation in the SAME LANGUAGE the user is asking in — if they ask in Turkish, respond in Turkish; if in English, respond in English; etc. ALWAYS produce the actual NOTAM text itself (Q-line, A/B/C/D/E) in ICAO standard English format regardless of the conversation language, since that is the international standard — but your explanations, summaries, and validation notes should match the user's language.
Remember: LTBB = Istanbul FIR (western Turkey), LTAA = Ankara FIR (central/eastern Turkey)

### ICAO CODE VERIFICATION:
${webSearchEnabled ? `- You have web search capability — USE IT to verify any ICAO code you are not 100% certain about
- For Turkish airports especially, ALWAYS web search "DHMI [airport name] ICAO code" before using a code
- NEVER guess or assume an ICAO code — if uncertain, search first` : `- You have NO web search in this conversation. Never say you will search or look something up.
- NEVER guess or assume an ICAO code — if you are not certain of a code, say so and give the airport name instead.`}
- The verified airport names injected in this prompt (from SkyLink database) take priority over your training data
- If a code is provided in the request form, verify it matches the airport name via web search

LANGUAGE: Always respond in the same language the user writes in, regardless of what language that is. Match their language fluently and naturally — do not default to English unless they write in English.

DEPTH AND QUALITY — calibrate length to the actual question, don't default to maximum depth every time:
- Quick factual questions (a single number, a yes/no, a short definition — e.g. "what's the RVR minimum for CAT IIIB", "is ETOPS required for this route type") get a direct 1-4 sentence answer. No headers, no tables, no bullet list scaffolding for something this simple.
- Conceptual or "explain X" questions of moderate scope get a focused answer of a few short paragraphs — only add structure (headers, a list) if it genuinely helps organize distinct sub-points, not as decoration.
- Genuinely broad or multi-part questions (e.g. "explain everything about CAT III ILS operations", "walk me through ETOPS planning end to end") earn a longer, structured answer with headers/tables/lists, because the question itself spans multiple distinct sub-topics that benefit from separation.
- The test is: does this specific question have multiple distinct sub-topics that need separating? If not, don't manufacture structure. A long answer to a narrow question isn't more expert — it's padding.
- Whatever the length, be accurate and use correct terminology — depth means precision and correctness, not word count. Cite regulatory context (ICAO Annexes, FAA/EASA differences) when relevant, briefly if the question is narrow, more fully if it's broad.

GENERAL FACTS AND STATISTICS — questions about a country's or region's aviation in general (for example how many airports, helipads, airlines or air traffic controllers a country has) are NOT live data and NOT a platform feature: never redirect them to a panel. Answer from your knowledge with your best figure, say plainly that it is approximate and may have changed, and name the official source to confirm it (for Turkey: DHMI or SHGM). Do not answer with only 'I don't know'.

SCOPE BOUNDARY — these are paid platform features you cannot do conversationally, and must NOT fabricate or guess at. When a question clearly needs one of these, do not attempt to answer from memory or estimate current data. Instead, briefly redirect (1-2 sentences) and include the matching marker below so the user gets a real clickable button to the actual feature — never just describe it in prose without the marker, and never follow the redirect with a guessed answer anyway.

- Live/current NOTAM, METAR, TAF, SIGMET, or AIRMET data for a SPECIFIC airport, route, or FIR right now — you have no live data feed. Never invent or guess current conditions for a specific location. Redirect using: [[panel:rawData|Open NOTAMs & MET]]. Do NOT redirect for general/theoretical questions about what NOTAMs or METARs are, how to read them, or aviation weather concepts — answer those directly.
- Generating an actual pre-flight briefing (Go/No-Go assessment, risk scoring) for a specific route or airport — tell them to type the ICAO code or route in the main input with Briefing mode selected. No panel marker needed for this one since it's the main input itself, not a side panel.
- AI Video Briefing generation — tell them to type the ICAO code or route in the main input with Video mode selected. No panel marker needed, same reason as above.
- Saved Routes — Redirect using: [[panel:savedRoutes|Open Saved Routes]]
- NOTAM Alerts — Redirect using: [[panel:alerts|Open NOTAM Alerts]]
- Briefing/chat Archive — Redirect using: [[panel:archive|Open Archive]]
- Questions about using Aviation Tools (airport info, winds aloft, charts, navaids, distance/bearing, flight time, sun/moon, flight tracker, aircraft lookup, performance) where the user wants to actually look up live data for a specific airport or route — Redirect using: [[panel:tools|Open Aviation Tools]]. Do NOT redirect for theoretical questions about how these tools work or general aviation knowledge.

Only emit a [[panel:...]] marker for the six panel-based features listed above (rawData, savedRoutes, alerts, archive, tools use this syntax — Briefing/Video do not, they're main-input modes, just tell the user in plain text to use the input box). Use the marker exactly once per redirect, place it on its own line after your short explanation, and never invent a panel id outside this list.
${webSearchEnabled ? `
WEB SEARCH: You have a real-time web search tool. Use it ONLY when the question genuinely depends on information that could have changed recently or sits outside stable knowledge — e.g. a recent regulatory change, a newly released aircraft model or avionics system, recent aviation news or incidents, a current airline/airport policy. Do NOT search for things you already know accurately (standard procedures, established regulations, core aviation theory, aircraft systems, navigation concepts) — searching when you don't need to wastes time and cost. CRITICAL: web search is never a substitute for the live NOTAM/METAR/TAF/SIGMET/AIRMET scope boundary above — even if a search result looks like current weather or NOTAM information for a specific airport, do not present it as authoritative or current operational data; redirect to [[panel:rawData|Open NOTAMs & MET]] exactly as instructed above instead. When you do use search results in an answer, mention the source naturally in your own words — don't fabricate a source you didn't actually retrieve.
` : ''}
For everything else — explaining concepts, regulations, procedures, aircraft systems, weather theory, navigation, human factors, career guidance, aviation history — answer fully, accurately, and with real expertise.`;

        const userContent = [];
        // Support multiple images
        if (images && Array.isArray(images)) {
          images.forEach(img => {
            userContent.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data } });
          });
        } else if (image_base64) {
          userContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
        }
        if (pdf_base64) userContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
        userContent.push({ type: 'text', text: effectiveQuestion + (extra_text ? '\n\nAttached text:\n' + extra_text : '') + generalChatAirportContext });

        const messages = [
          ...(history || []).slice(-10).map(h => ({ role: h.role, content: h.content })),
          { role: 'user', content: userContent.length > 1 ? userContent : effectiveQuestion + (extra_text ? '\n\nAttached text:\n' + extra_text : '') + generalChatAirportContext }
        ];

        const requestBody = JSON.stringify({
          model: chatModel,
          max_tokens: opusAllowed ? 8000 : (chatModel === 'claude-sonnet-5-5' ? 6000 : 4000),
          ...(chatModel === 'claude-sonnet-5-5' ? { output_config: { effort: 'medium' } } : {}),
          // Sonnet 5.5 rejects thinking:disabled; 'between_tools' turns off up-front thinking (thinking between web searches stays).
          // Toggle with Render env CHAT_THINKING_OFF=1 to A/B cost, budget use and quality.
          ...(chatModel === 'claude-sonnet-5-5' && process.env.CHAT_THINKING_OFF === '1' ? { thinking: { type: 'between_tools' } } : {}),
          ...(/^claude-haiku-5/i.test(chatModel) ? { thinking: { type: 'disabled' } } : {}),
          stream: true,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages,
          ...(webSearchEnabled ? { tools: [GENERAL_CHAT_WEB_SEARCH_TOOL] } : {})
        });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // For tokens mode we don't know the real usagePercent until the response completes,
        // so send a pre-estimate now (based on current usage only) and let the frontend
        // treat the post-response value (sent in a later step if needed) as authoritative.
        const preEstimatePercent = Math.min(100, Math.round((currentUsage / cfg.limit) * 100));
        res.write(`data: ${JSON.stringify({ type: 'init', usagePercent: preEstimatePercent, resetInMinutes })}\n\n`);

        let doneSent = false;
        console.log('[GENERAL CHAT]', { userId, plan, model: modelToUse, pastSoftLimit, webSearchEnabled, searchTotal, searchCap: searchCapForPlan, currentUsage, limit: cfg.limit });

        streamClaude(requestBody,
          (text) => { res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
          (usageInfo) => {
            if (doneSent) return;
            doneSent = true;
            const totalTokens = (usageInfo?.input_tokens || 0) + (usageInfo?.output_tokens || 0);
            console.log('[GENERAL CHAT USAGE]', { plan, model: chatModel, input: usageInfo?.input_tokens || 0, output: usageInfo?.output_tokens || 0, stop: usageInfo?.stop_reason || 'unknown', text_chars: usageInfo?.text_chars || 0, thinking_blocks: usageInfo?.thinking_blocks || 0, thinkingOff: process.env.CHAT_THINKING_OFF === '1' });
            const searchCount = usageInfo?.web_search_requests || 0;
            if (searchCount > 0) {
              console.log('[GENERAL CHAT] Web search used', { userId, plan, searchCount });
            }
            recordGeneralChatRateLimitEntry(userId, totalTokens, searchCount)
              .catch(e => console.error('[GENERAL CHAT] Post-response record error:', e.message));
            const newUsage = currentUsage + totalTokens;
            const finalUsagePercent = Math.min(100, Math.round((newUsage / cfg.limit) * 100));
            res.write(`data: ${JSON.stringify({ type: 'done', usagePercent: finalUsagePercent })}\n\n`);
            res.end();
          },
          (err) => {
            console.error('[GENERAL CHAT] Stream error:', err.message);
            if (!doneSent) { doneSent = true; res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream interrupted' })}\n\n`); res.end(); }
          },
          (query) => { res.write(`data: ${JSON.stringify({ type: 'search', query })}\n\n`); }
        );

      } catch(e) {
        console.error('[GENERAL CHAT ERROR]', e.message);
        if (res.headersSent) {
          res.end();
        } else {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ answer: 'Error processing request.' }));
        }
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
        const userId = await getVerifiedUserId(req);
        if (!userId) { sendUnauthorized(res, req); return; }
        let reqPlan = 'free';      // plan and monthly count before this briefing; used below for the Free FIR gate and the Max hybrid model
        let reqUsage = 0;
        {
          const plan = await getUserPlan(userId);
          const usage = await getUserUsage(userId, 'briefings');
          reqPlan = plan; reqUsage = usage;
          const limit = PLAN_LIMITS[limitPlanOf(plan)]?.briefings || (plan === 'admin' ? 9999 : 3);
          if (usage >= limit) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'limit_reached', plan, usage, limit }));
            return;
          }
          if (plan === 'free' && !(await reserveFreeBriefingSlot())) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'free_capacity', plan }));
            return;
          }
          await incrementUsage(userId, 'briefings');
          const newUsage = usage + 1;
          const remaining = limit - newUsage;
          if (remaining <= Math.floor(limit * 0.2) && remaining > 0) {
            res.setHeader('x-usage-warning', JSON.stringify({ remaining, limit, feature: 'briefings' }));
          }
        }

        const { icao_dep, icao_arr, notam_text, image_base64, image_type, pdf_base64, images } = JSON.parse(body);

        const isValidIcaoCode = (code) => !!code && /^[A-Z]{4}$/.test(code.trim());
        const isQuickAnalysis = !isValidIcaoCode(icao_dep);
        const isSingleAirport = !isQuickAnalysis && !isValidIcaoCode(icao_arr);

        let notamDepResult = { text: '', total: 0, shown: 0 };
        let notamArrResult = { text: '', total: 0, shown: 0 };
        let enrouteNotamData = '';
        const enrouteCollector = [];
        let metarDep = '', tafDep = '', metarArr = '', tafArr = '';

        if (!isQuickAnalysis) {
          notamDepResult = await fetchNotams(icao_dep);
          [metarDep, tafDep] = await Promise.all([fetchMetar(icao_dep), fetchTaf(icao_dep)]);
          if (!isSingleAirport) {
            await new Promise(r => setTimeout(r, 500));
            notamArrResult = await fetchNotams(icao_arr);
            // v3.71: En-route FIR NOTAMs are not part of the Free plan (pricing table); skipping saves the FIR SkyLink calls.
            // The prompt then states plainly that FIR NOTAMs were not retrieved (see 'No FIR data available').
            if (reqPlan === 'free') console.log('[ENROUTE] skipped: Free plan');
            else enrouteNotamData = await getEnrouteNotams(icao_dep, icao_arr, enrouteCollector, { includeDomestic: RISK_MODE === 'active' });
            [metarArr, tafArr] = await Promise.all([fetchMetar(icao_arr), fetchTaf(icao_arr)]);
          }
        }

        const now = new Date();
        const utcDate = now.toUTCString().slice(5, 16).toUpperCase();

        // Risk rubric — SHADOW MODE: computed and logged only, in the background (nothing waits for it).
        const riskPromise = !isQuickAnalysis
          ? computeBriefingRisk({ icao_dep, icao_arr, isSingleAirport, notamDepResult, notamArrResult, enrouteCollector, metarDep, metarArr, tafDep, tafArr }).catch(e => { console.log('[RISK] error:', e.message); return null; })
          : Promise.resolve(null);
        const riskActive = RISK_MODE === 'active' && !isQuickAnalysis;
        let riskResult = null;
        if (riskActive) {
          try { riskResult = await Promise.race([riskPromise, new Promise(resolve => setTimeout(() => resolve(null), 6000))]); }
          catch (e) { riskResult = null; }
          if (!riskResult) console.log('[RISK] active mode but no result — falling back to the model-only rating');
        }

        const depOverflow = notamDepResult.total > notamDepResult.shown
          ? `\n[${notamDepResult.total - notamDepResult.shown} additional NOTAMs not shown — open the NOTAMs & MET panel or use Single NOTAM Analysis for details]`
          : '';
        const arrOverflow = notamArrResult.total > notamArrResult.shown
          ? `\n[${notamArrResult.total - notamArrResult.shown} additional NOTAMs not shown — open the NOTAMs & MET panel or use Single NOTAM Analysis for details]`
          : '';

        // Pre-fetch airport names for accurate display
        await Promise.all([
          icao_dep ? fetchAndCacheAirportName(icao_dep) : Promise.resolve(),
          icao_arr ? fetchAndCacheAirportName(icao_arr) : Promise.resolve()
        ]);

        // For quick analysis — extract ICAO codes from text and fetch names via SkyLink
        let quickAirportContext = '';
        if (isQuickAnalysis && notam_text) {
          const stopWords = new Set(['NOTAM','METAR','SIGMET','AIRMET','PIREP','FROM','UNTIL','VALID','INFO','PERM','TRUE','WIND','TEMP','PRES','FEET','KNOT']);
          const icaoCodes = [...new Set((notam_text.match(/\b[A-Z]{4}\b/g) || []).filter(c => !stopWords.has(c)))].slice(0, 5);
          if (icaoCodes.length > 0) {
            const names = await Promise.all(icaoCodes.map(c => fetchAndCacheAirportName(c)));
            const verified = icaoCodes.map((c, i) => names[i] !== c ? `${c} = ${names[i]}` : null).filter(Boolean);
            if (verified.length > 0) {
              quickAirportContext = `\n\nVERIFIED AIRPORT NAMES (from SkyLink database — use EXACTLY as provided):\n${verified.join('\n')}\nFor any other ICAO code not listed above, write "Airport [ICAO CODE]" — never guess.`;
            }
          }
        }

        // For image/PDF uploads — first extract ICAO codes, then fetch verified names
        let imageAirportContext = quickAirportContext;
        if (isQuickAnalysis && (image_base64 || pdf_base64) && !notam_text) {
          try {
            // Step 1: Quick ICAO extraction from image
            const extractContent = [];
            if (image_base64) extractContent.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
            if (pdf_base64) extractContent.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
            extractContent.push({ type: 'text', text: 'Extract ALL 4-letter ICAO airport codes from this document. Return ONLY the codes separated by spaces, nothing else. Example: LTFD LTBB LTFM' });

            const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
              body: JSON.stringify({ model: HAIKU_MODEL, ...HAIKU_EXTRA, max_tokens: 50, messages: [{ role: 'user', content: extractContent }] })
            });
            const extractData = await extractRes.json();
            const extractedText = extractData.content?.[0]?.text || '';
            const stopWords = new Set(['NOTAM','METAR','SIGMET','FROM','UNTIL','VALID','INFO','PERM','TRUE','WIND','TEMP','PRES','FEET','KNOT']);
            const imageCodes = [...new Set((extractedText.match(/\b[A-Z]{4}\b/g) || []).filter(c => !stopWords.has(c)))].slice(0, 5);

            if (imageCodes.length > 0) {
              console.log('[QUICK ANALYSIS] Extracted ICAO codes from image:', imageCodes);
              const names = await Promise.all(imageCodes.map(c => fetchAndCacheAirportName(c)));
              const verified = imageCodes.map((c, i) => names[i] !== c ? `${c} = ${names[i]}` : null).filter(Boolean);
              const firNames = {'LTBB':'Istanbul FIR','LTAA':'Ankara FIR','EGTT':'London FIR','EGPX':'Scottish FIR','EDGG':'Langen FIR','EDWW':'Bremen FIR','EDMM':'Munich FIR','LFPP':'Paris FIR','LECB':'Barcelona FIR','LECM':'Madrid FIR','LIBB':'Brindisi FIR','LIMM':'Milano FIR','LIRR':'Roma FIR','OMAE':'Emirates FIR'};
              const firCtx = imageCodes.filter(c => firNames[c]).map(c => `${c} = ${firNames[c]}`).join('\n');
              if (verified.length > 0 || firCtx) {
                imageAirportContext = `\n\nVERIFIED NAMES (use EXACTLY, never modify):\n${[...verified, ...(firCtx ? [firCtx] : [])].join('\n')}\nFor any code not listed, write the code only — never guess.`;
                console.log('[QUICK ANALYSIS] Airport context:', imageAirportContext);
              }
            }
          } catch(e) {
            console.log('[QUICK ANALYSIS] ICAO extraction failed:', e.message);
          }
        }

        const userMessage = isQuickAnalysis
          ? `Analyze the aviation data provided below and/or any attached image or PDF. There is no confirmed airport or route — just analyze exactly what was given, nothing more.\n\nTODAY'S DATE: ${utcDate}\n${notam_text ? `\nPROVIDED TEXT:\n${notam_text}` : '\n(No text provided — analyze the attached image/PDF only.)'}${imageAirportContext}\n\nGenerate the complete quick analysis HTML content.`
          : isSingleAirport
          ? `Must complete ALL sections including Weather, Airport Operational Considerations, Ground & ATC Notes, Airport Operational Status, and Footer. Be concise in each section. This is a SINGLE AIRPORT briefing — there is no second airport and no flight-specific Go/No-Go decision.

TODAY'S DATE: ${utcDate}
AIRPORT: ${icao_dep || 'NOT PROVIDED'} — ${airportName(icao_dep)}

LIVE NOTAMs (${icao_dep} / ${airportName(icao_dep)}) — top ${notamDepResult.shown} of ${notamDepResult.total} active, sorted CRITICAL first then most recent:
${notamDepResult.text || 'No active NOTAMs retrieved'}${depOverflow}

METAR: ${metarDep || 'Not available'}
TAF: ${tafDep || 'Not available'}
${notam_text ? `\nADDITIONAL USER DATA:\n${notam_text}` : ''}

Generate the complete airport operational intelligence briefing HTML content.`
          : `Must complete ALL sections including Weather, Pilot Actions, Dispatch Notes, Go/No-Go and Footer. Be concise in each section.

TODAY'S DATE: ${utcDate}
DEPARTURE: ${icao_dep || 'NOT PROVIDED'} — ${airportName(icao_dep)}
ARRIVAL: ${icao_arr || 'NOT PROVIDED'} — ${airportName(icao_arr)}

LIVE NOTAMs - DEPARTURE (${icao_dep} / ${airportName(icao_dep)}) — top ${notamDepResult.shown} of ${notamDepResult.total} active, sorted CRITICAL first then most recent:
${notamDepResult.text || 'No active NOTAMs retrieved'}${depOverflow}

LIVE NOTAMs - ARRIVAL (${icao_arr} / ${airportName(icao_arr)}) — top ${notamArrResult.shown} of ${notamArrResult.total} active, sorted CRITICAL first then most recent:
${notamArrResult.text || 'No active NOTAMs retrieved'}${arrOverflow}

METAR DEPARTURE: ${metarDep || 'Not available'}
METAR ARRIVAL: ${metarArr || 'Not available'}
TAF DEPARTURE: ${tafDep || 'Not available'}
TAF ARRIVAL: ${tafArr || 'Not available'}
${enrouteNotamData ? '\nEN-ROUTE FIR NOTAMs:\n' + enrouteNotamData : '\nEN-ROUTE FIR NOTAMs: No FIR data available — advise crew to check current FIR NOTAMs via official sources.'}
${notam_text ? `\nADDITIONAL USER DATA:\n${notam_text}` : ''}

Generate the complete pre-flight operational intelligence briefing HTML content.`;

        const riskPrefix = (riskActive && riskResult && riskResult.modelBlock) ? riskResult.modelBlock + '\n\n---\n\n' : '';
        const contentBlocks = [{ type: 'text', text: riskPrefix + userMessage }];
        if (images && Array.isArray(images)) {
          images.forEach(img => contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.type || 'image/jpeg', data: img.data } }));
        } else if (image_base64) {
          contentBlocks.push({ type: 'image', source: { type: 'base64', media_type: image_type || 'image/jpeg', data: image_base64 } });
        }
        if (pdf_base64) {
          contentBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } });
        }

        // Canary: admin accounts run the briefing on Sonnet 5.5 (medium effort) so cost and quality can be
        // compared with Sonnet 4.6 on identical routes before any rollout to paying plans.
        const briefingPlan = userId ? await getUserPlan(userId) : 'free';
        // BRIEFING_MODEL (Render env) selects the model for non-admin plans; admin always runs the newest.
        const briefingModel = briefingModelFor(briefingPlan, reqUsage);
        const is55Family = /-5-5$/.test(briefingModel);   // Sonnet 5.5 and Haiku 5.5 share the depth rules and the larger output ceiling
        console.log('[BRIEFING MODEL]', { model: briefingModel, plan: briefingPlan, usedThisMonth: reqUsage, thinkingOff: process.env.BRIEFING_THINKING_OFF === '1' });
        const claudeBody = JSON.stringify({
          model: briefingModel,
          max_tokens: is55Family ? 24000 : 16000,
          ...(is55Family ? { output_config: { effort: (briefingModel === 'claude-haiku-5-5' && process.env.BRIEFING_HAIKU_EFFORT) || 'medium' } } : {}),
          // Sonnet 5.5 rejects thinking:disabled; 'between_tools' is its lowest setting (no up-front thinking).
          // Toggle with Render env BRIEFING_THINKING_OFF=1 to A/B cost vs quality.
          // v3.69: Haiku 5.5 also thinks up front by default (measured 20 Oct: 3 of 4 briefings hit max_tokens, thinking ate ~18K tokens), so it gets the same switch.
          // v3.70: Haiku 5.5 rejects 'between_tools' (live error 20 Oct). It gets thinking only via Render env BRIEFING_HAIKU_THINKING=disabled (untested), otherwise no thinking param.
          ...(briefingModel === 'claude-sonnet-5-5' && process.env.BRIEFING_THINKING_OFF === '1' ? { thinking: { type: 'between_tools' } } : {}),
          ...(briefingModel === 'claude-haiku-5-5' && process.env.BRIEFING_HAIKU_THINKING === 'disabled' ? { thinking: { type: 'disabled' } } : {}),
          stream: true,
          system: [{ type: 'text', text: (isQuickAnalysis ? quickAnalysisSystemPrompt : (isSingleAirport ? singleAirportSystemPrompt : systemPrompt)) + ((is55Family && !isQuickAnalysis) ? '\n\n' + BRIEFING_DEPTH_RULES_55 : '') + (!isQuickAnalysis ? '\n\n' + BRIEFING_WX_RULES : '') + ((riskActive && riskResult) ? '\n\n' + BRIEFING_RISK_RULES : ''), cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: contentBlocks }]
        });

        // Switch to SSE streaming response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.writeHead(200);

        // Send HTML_HEAD and HTML_FOOT to client so it can wrap content
        // Raw NOTAM texts by id: the page fills them into the cards (the model no longer copies them).
        const notamRaw = {};
        [notamDepResult, notamArrResult].forEach(r => { if (r) [...(r.activeItems || []), ...(r.nearFutureItems || [])].forEach(n => { if (n && n.notam_id) notamRaw[n.notam_id] = String(n.raw || n.body || ''); }); });
        res.write(`data: ${JSON.stringify({ type: 'init', html_head: HTML_HEAD, html_foot: HTML_FOOT, notamRaw })}\n\n`);

        let doneSent = false;
        let modelHeadText = '';
        streamClaude(claudeBody,
          (text) => { if (modelHeadText.length < 4000) modelHeadText += text; res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`); },
          (usageInfo) => {
            if (doneSent) return;
            doneSent = true;
            {
              const costUsd = briefingCostUsd(briefingModel, usageInfo);
              console.log('[BRIEFING COST]', { model: briefingModel, plan: briefingPlan, input: usageInfo?.input_tokens || 0, output: usageInfo?.output_tokens || 0, cache_created: usageInfo?.cache_created || 0, cache_read: usageInfo?.cache_read || 0, usd: costUsd === null ? null : Math.round(costUsd * 10000) / 10000 });
              if (costUsd !== null && userId) {
                adminDb.collection('briefingCosts').add({
                  userId, plan: briefingPlan, model: briefingModel, route: icao_dep + (isSingleAirport ? '' : '-' + (icao_arr || '')),
                  input: usageInfo?.input_tokens || 0, output: usageInfo?.output_tokens || 0,
                  cacheCreated: usageInfo?.cache_created || 0, cacheRead: usageInfo?.cache_read || 0,
                  thinkingBlocks: usageInfo?.thinking_blocks || 0, stopReason: usageInfo?.stop_reason || 'unknown',
                  costUsd, createdAt: admin.firestore.FieldValue.serverTimestamp()
                }).catch(e => console.log('[BRIEFING COST] save error:', e.message));
              }
            }
            console.log('[BRIEFING STOP REASON]', { stop_reason: usageInfo?.stop_reason || 'unknown', output_tokens: usageInfo?.output_tokens || 0, text_chars: usageInfo?.text_chars || 0, thinking_blocks: usageInfo?.thinking_blocks || 0, thinking_chars: usageInfo?.thinking_chars || 0 });
            Promise.resolve(riskPromise).then(riskResult => {
              const mScore = (modelHeadText.match(/RISK\s*SCORE\s*(?:<[^>]*>)?\s*(\d+)\s*\/\s*10/i) || [])[1];
              const mLevel = (modelHeadText.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/) || [])[1];
              console.log('[RISK COMPARE]', JSON.stringify({ route: icao_dep + (isSingleAirport ? '' : '-' + icao_arr), computed: riskResult ? `${riskResult.level} ${riskResult.score}` : 'n/a', model: mScore ? `${mLevel || '?'} ${mScore}` : 'n/a' }));
            }).catch(() => {});
            // Fixed, server-authored notes (not left to the model) about NOTAMs not included in
            // the main briefing, so the wording and counts are always accurate. Sent as part of
            // the 'done' event (notamNotesHtml) so the client can splice it in right after the
            // NOTAM section — at the <!--NOTAM_NOTES--> placeholder Claude was told to leave —
            // instead of it landing at the very end of the whole document, after the closing
            // signature.
            // Upcoming (not yet effective, next 24h): grouped per aerodrome / FIR, each line carries its owner.
            const upcomingGroups = [];
            const addUp = (key, title, lines) => { if (lines && lines.length) upcomingGroups.push({ key, title, lines: lines.map(l => key.replace(/^FIR /, '') + ' ' + l) }); };
            addUp(icao_dep, icao_dep + (isSingleAirport ? '' : ' (departure)'), notamDepResult.nearFutureLines);
            if (!isSingleAirport) addUp(icao_arr, icao_arr + ' (arrival)', notamArrResult.nearFutureLines);
            if (riskResult && riskResult.route !== undefined && !isSingleAirport) {
              try {
                const byFir = {};
                risk.upcomingEnroute(enrouteCollector, riskResult.route, new Date(), 24).forEach(u => {
                  const eff = u.from.toISOString().slice(2, 16).replace(/[-T:]/g, '');
                  const oneLine = u.text.length > 200 ? u.text.slice(0, 197).replace(/\s+\S*$/, '') + '…' : u.text;
                  (byFir[u.fir] = byFir[u.fir] || []).push(`${u.id} (from ${eff}Z): ${oneLine}`);
                });
                Object.keys(byFir).forEach(f => addUp('FIR ' + f, 'FIR ' + f + ' (en-route, route-relevant)', byFir[f].slice(0, 6)));
              } catch (e) { console.log('[UPCOMING FIR] error:', e.message); }
            }
            const allNearFuture = upcomingGroups.reduce((n, g) => n.concat(g.lines), []);
            const totalLaterFuture = (notamDepResult.laterFutureCount || 0) + (notamArrResult.laterFutureCount || 0);
            const totalExcludedAdmin = (notamDepResult.excludedAdminCount || 0) + (notamArrResult.excludedAdminCount || 0);
            const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            let notamNotesHtml = '';
            if (reqPlan === 'free' && !isSingleAirport && !isQuickAnalysis) {
              // v3.71: Free briefings skip the en-route FIR fetch, so the rating covers less than a Pro/Max rating of the same route.
              notamNotesHtml += `<div style="font-family:'Share Tech Mono',monospace;font-size:12px;color:#f2c641;padding:12px 14px;margin:12px 0;border:1px solid rgba(242,198,65,0.4);border-left:4px solid #f2c641;background:rgba(242,198,65,0.07);"><strong>ℹ Rating excludes en-route FIR NOTAMs.</strong> The risk rating covers the two aerodromes, weather and the conflict-zone check only. En-route FIR NOTAMs are part of the Pro and Max plans; for this route check them via official sources.</div>`;
            }
            if (notamDepResult.unavailable || notamArrResult.unavailable) {
              const which = [notamDepResult.unavailable ? icao_dep : null, notamArrResult.unavailable ? icao_arr : null].filter(Boolean).join(', ');
              notamNotesHtml += `<div style="font-family:'Share Tech Mono',monospace;font-size:12px;color:#ff6b6b;padding:12px 14px;margin:12px 0;border:1px solid rgba(255,107,107,0.5);border-left:4px solid #ff4d4d;background:rgba(255,77,77,0.08);"><strong>⚠ NOTAM DATA UNAVAILABLE for ${esc(which)}.</strong> The NOTAM data provider did not return data. This briefing is INCOMPLETE and must not be treated as "no NOTAMs". Check the official AIS/NOTAM office before flight.</div>`;
            }
            if (allNearFuture.length > 0) {
              const upcomingList = '<ul style="margin:6px 0 0;padding-left:18px;">' + allNearFuture.map(l => `<li style="margin-bottom:4px;">${esc(l)}</li>`).join('') + '</ul>';
              notamNotesHtml += `<div class="upcoming-notams" style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#f2c641;padding:8px 12px;margin-top:10px;border-top:1px solid #1a2a3a;"><strong>⏳ Upcoming NOTAMs (next 24h, not yet effective):</strong>${upcomingList}</div>`;
            }
            const otherParts = [];
            if (totalLaterFuture > 0) otherParts.push(`${totalLaterFuture} future NOTAM${totalLaterFuture > 1 ? 's' : ''} starting beyond 24h`);
            if (totalExcludedAdmin > 0) otherParts.push(`${totalExcludedAdmin} administrative/trigger NOTAM${totalExcludedAdmin > 1 ? 's' : ''} (incl. PERM)`);
            if (otherParts.length > 0) {
              notamNotesHtml += `<div style="font-family:'Share Tech Mono',monospace;font-size:10px;color:#4a5f72;padding:8px 12px;margin-top:6px;">ℹ ${otherParts.join(' and ')} not shown here — view all NOTAMs in the NOTAM panel.</div>`;
            }
            let riskExtra = {};
            if (riskActive && riskResult) { try { riskExtra = risk.finalizeForClient(riskResult, modelHeadText); } catch (e) { console.log('[RISK] finalize error:', e.message); } }
            // Owner map for the client: NOTAM id -> aerodrome / FIR keys, plus the group order, so the NOTAM list
            // can be grouped (departure, arrival, FIRs) and every NOTAM labelled deterministically.
            const notamOwners = {};
            const own = (id, key) => { if (!id) return; const a = (notamOwners[id] = notamOwners[id] || []); if (!a.includes(key)) a.push(key); };
            [[icao_dep, notamDepResult], [icao_arr, notamArrResult]].forEach(([ic, r]) => { if (ic && r) [...(r.activeItems || []), ...(r.nearFutureItems || [])].forEach(n => own(n.notam_id, ic)); });
            (enrouteCollector || []).forEach(x => (x.notams || []).forEach(n => own(n.notam_id, 'FIR ' + x.fir)));
            const notamGroups = [{ key: icao_dep, title: icao_dep + (isSingleAirport ? '' : ' — DEPARTURE') }]
              .concat(isSingleAirport ? [] : [{ key: icao_arr, title: icao_arr + ' — ARRIVAL' }])
              .concat((enrouteCollector || []).map(x => ({ key: 'FIR ' + x.fir, title: 'FIR ' + x.fir + ' — EN-ROUTE' })));
            const notamOutside = [];
            if (riskResult && riskResult.airportRows) Object.values(riskResult.airportRows).forEach(rows => (rows || []).forEach(x => { if (x && x.id && x.inWindow === false) notamOutside.push(x.id); }));
            // Tier 3 NOTAMs (rubric MEDIUM) are not written out individually; the page counts the ones that were not listed.
            const notamT3 = {};
            if (riskResult && riskResult.airportRows) Object.keys(riskResult.airportRows).forEach(ic => ((riskResult.airportRows[ic]) || []).forEach(x => { if (x && x.id && risk.isMinorRow(x)) (notamT3[ic] = notamT3[ic] || []).push(x.id); }));
            // Tier 1/2 NOTAMs in force per aerodrome (0 -> the page says so instead of showing nothing for that aerodrome)
            const notamInForce = {};
            if (riskResult && riskResult.airportRows) Object.keys(riskResult.airportRows).forEach(ic => { notamInForce[ic] = ((riskResult.airportRows[ic]) || []).filter(x => x && (x.sev === 'CRITICAL' || x.sev === 'HIGH') && x.inWindow !== false && !x.upcoming).length; });
            res.write(`data: ${JSON.stringify(Object.assign({ type: 'done', notamNotesHtml, notamOwners, notamGroups, notamOutside, notamT3, notamInForce }, riskExtra))}\n\n`);
            res.end();
          },
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

  res.writeHead(404);
  res.end('Not found');
  } catch (err) {
    console.error('Server error:', err);
    captureException(err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }
});

server.timeout = 120000;
server.listen(PORT, () => {
  console.log(`NOTAM Intelligence server running on port ${PORT}`);
  runwayData.init();
  setTimeout(resumeUnfinishedVideos, 20000);
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
      <img src="https://notamai.onrender.com/favicon.png" alt="" width="30" height="30" style="width:30px;height:30px;border-radius:7px;display:inline-block;vertical-align:middle;margin-right:8px;">
      <span style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:900;letter-spacing:4px;color:#ffffff;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
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

// ─── NOTAM ALERT CHECK (Cache Architecture) ───────────────────────────────
let alertCheckCycle = 0;

// ── NOTAM alerts v2 ─────────────────────────────────────────────────────────────────────────────────
// One shared state per airport/FIR (Firestore alertState/{ICAO}, mirrored in memory): known NOTAM ids + time of the last diff.
//  - interval per airport = shortest among its subscribers' plans (Max/Enterprise 30 min, Pro-only 60 min) — see alert-poll.js
//  - any fresh provider response for that airport (briefing, raw panel, earlier poll) counts as a poll and is diffed for free
//  - every NEW id is reported (digest e-mail), not just the newest one; user e-mail / preferences are looked up only when something is sent
const alertPoll = require('./alert-poll');
const ALERT_TICK_MS = 15 * 60 * 1000;
const ALERT_CAPS = { free: 0, pro: 3, max: 5, enterprise: 10 };
// soft budget for DISTINCT airports polled at once (each ≈720 provider calls/month at 60 min, ≈1,440 at 30 min); exceeding it only raises a warning
const ALERT_AIRPORT_BUDGET = parseInt(process.env.ALERT_AIRPORT_BUDGET, 10) || 150;
const alertStateMem = new Map();      // ICAO -> state | null (null = no state yet)
const alertPlanMem = new Map();       // userId -> { plan, t }
let alertTickRunning = false;

async function alertPlanFor(userId) {
  const hit = alertPlanMem.get(userId);
  if (hit && Date.now() - hit.t < 15 * 60 * 1000) return hit.plan;
  const plan = await getUserPlan(userId);
  alertPlanMem.set(userId, { plan, t: Date.now() });
  return plan;
}
async function loadAlertState(icao) {
  if (alertStateMem.has(icao)) return alertStateMem.get(icao);
  let st = null;
  try {
    const d = await adminDb.collection('alertState').doc(icao).get();
    if (d.exists) { const x = d.data(); st = { known: x.known || [], lastCheckedAt: x.lastCheckedAt || 0, lastSigmetId: x.lastSigmetId || '' }; }
  } catch (e) { console.log('[ALERT STATE] load failed', icao, e.message); }
  alertStateMem.set(icao, st);
  return st;
}
async function saveAlertState(icao, st) {
  alertStateMem.set(icao, st);
  try { await adminDb.collection('alertState').doc(icao).set({ known: st.known, lastCheckedAt: st.lastCheckedAt, lastSigmetId: st.lastSigmetId || '', updatedAt: admin.firestore.FieldValue.serverTimestamp() }); }
  catch (e) { console.log('[ALERT STATE] save failed', icao, e.message); }
}

async function checkNotamAlerts() {
  if (alertTickRunning) { console.log('[ALERT CHECK] previous run still active — skipped'); return; }
  alertTickRunning = true;
  const stats = { airports: 0, fetched: 0, reused: 0, skipped: 0, emails: 0, newNotams: 0 };
  try {
    const alertsSnap = await adminDb.collection('alerts').where('active', '==', true).get();
    if (alertsSnap.empty) { console.log('[ALERT CHECK] No active alerts'); return; }

    // plan caps (server side): resolve each owner's plan once (15 min memory), keep the oldest alerts up to the cap
    const byUser = {};
    for (const doc of alertsSnap.docs) {
      const d = doc.data();
      if (!d.icao || !d.userId) continue;
      (byUser[d.userId] = byUser[d.userId] || []).push(doc);
    }
    const icaoMap = {};
    let ignored = 0;
    for (const [userId, docs] of Object.entries(byUser)) {
      const plan = await alertPlanFor(userId);
      const cap = plan === 'admin' ? docs.length : (ALERT_CAPS[plan] ?? 0);
      docs.sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0));
      ignored += Math.max(0, docs.length - cap);
      for (const doc of docs.slice(0, cap)) {
        const icao = String(doc.data().icao).toUpperCase();
        (icaoMap[icao] = icaoMap[icao] || []).push({ doc, userId, plan });
      }
    }
    if (ignored) console.log('[ALERT CHECK] Ignored', ignored, 'alerts (free plan or over plan cap)');

    const uniqueIcaos = Object.keys(icaoMap);
    stats.airports = uniqueIcaos.length;
    stats.airportBudget = ALERT_AIRPORT_BUDGET;
    stats.overBudget = uniqueIcaos.length > ALERT_AIRPORT_BUDGET;
    if (stats.overBudget) console.warn('[ALERT CHECK] WARNING:', uniqueIcaos.length, 'distinct airports polled (budget', ALERT_AIRPORT_BUDGET + ') — check SkyLink quota');
    const userInfo = {};   // looked up lazily, only for users who actually receive something this run
    const infoFor = async (userId) => {
      if (userInfo[userId] !== undefined) return userInfo[userId];
      let info = null;
      try {
        const [rec, ud] = await Promise.all([admin.auth().getUser(userId), adminDb.collection('users').doc(userId).get()]);
        const n = ud.exists ? (ud.data().notifications || {}) : {};
        info = rec.email && n.emailAlerts !== false ? { email: rec.email } : null;
      } catch (e) { info = null; }
      return (userInfo[userId] = info);
    };

    for (const icao of uniqueIcaos) {
      const subs = icaoMap[icao];
      const st = await loadAlertState(icao);
      const stored = airportNotamStore.get(icao) || null;
      const action = alertPoll.planAction({ now: Date.now(), intervalMs: alertPoll.intervalMsFor(subs.map(x => x.plan)), state: st, stored: stored && { t: stored.t } });
      if (action === 'skip') { stats.skipped++; continue; }

      let data = stored && stored.data;
      let checkedAt = stored ? stored.t : Date.now();
      if (action === 'fetch') {
        try {
          data = await fetchURL('https://skylink-api.p.rapidapi.com/notams/' + icao + '?include_future=true', {
            method: 'GET',
            headers: { 'x-rapidapi-key': process.env.SKYLINK_KEY, 'x-rapidapi-host': 'skylink-api.p.rapidapi.com' }
          });
        } catch (e) { console.log('[ALERT CHECK ERROR] SkyLink fetch failed for', icao, e.message); continue; }
        if (!skylinkNotamsOk(data) && !Array.isArray(data?.data)) {
          console.log('[ALERT CHECK ERROR] SkyLink returned no NOTAM data for', icao, JSON.stringify(data).slice(0, 200));
          notifySkylinkFailure(icao);
          continue;   // state untouched: retried next tick
        }
        checkedAt = Date.now();
        stats.fetched++;
      } else {
        stats.reused++;
      }

      const notams = (data?.notams || data?.data || []).filter(n => !n.location || String(n.location).toUpperCase() === icao);
      const ids = alertPoll.extractIds(notams);
      const { baseline, fresh } = alertPoll.diffIds(st ? st.known : null, ids);
      const next = { known: alertPoll.mergeKnown(st ? st.known : [], ids), lastCheckedAt: checkedAt, lastSigmetId: st ? st.lastSigmetId : '' };
      console.log('[ALERT CHECK]', icao, action, notams.length, 'NOTAMs,', baseline ? 'baseline' : fresh.length + ' new', '—', subs.length, 'alert(s)');

      // SIGMET (free API, once per airport per poll)
      let sigmetNew = null;
      try {
        const sg = await fetchURL('https://aviationweather.gov/api/data/airsigmet?format=json&hazard=sigmet&icao=' + icao);
        const latest = Array.isArray(sg) && sg.length ? sg[0] : null;
        const sid = latest ? (latest.airsigmetId || '') : '';
        if (sid) {
          if (st && sid !== (st.lastSigmetId || '')) sigmetNew = { id: sid, text: latest.rawAirSigmet || sid };
          next.lastSigmetId = sid;
        }
      } catch (e) { console.log('[SIGMET ERROR]', icao, e.message); }

      if (fresh.length || sigmetNew) {
        const freshNotams = notams.filter(n => fresh.includes(alertPoll.idOfNotam(n))).sort((a, b) => notamRecencyKey(b) - notamRecencyKey(a));
        stats.newNotams += freshNotams.length;
        const latestFreshId = freshNotams.length ? alertPoll.idOfNotam(freshNotams[0]) : '';
        for (const { doc: alertDoc, userId } of subs) {
          const info = await infoFor(userId);
          if (!info) continue;
          const patch = {};
          if (freshNotams.length) {
            await sendNotamAlert(info.email, icao, alertPoll.digestText(freshNotams));
            stats.emails++;
            patch.lastSentNotamId = latestFreshId;
          }
          if (sigmetNew) {
            await sendNotamAlert(info.email, icao + ' SIGMET', sigmetNew.text);
            stats.emails++;
            patch.lastSentSigmetId = sigmetNew.id;
          }
          try { await alertDoc.ref.update({ ...patch, lastChecked: admin.firestore.FieldValue.serverTimestamp() }); } catch (e) { /* alert deleted meanwhile */ }
          await new Promise(r => setTimeout(r, 200));
        }
      }
      await saveAlertState(icao, next);
      if (action === 'fetch') await new Promise(r => setTimeout(r, 600));   // stay under the provider's per-second limit
    }
  } catch (e) {
    console.log('[ALERT CHECK MAIN ERROR]', e.message);
  } finally {
    alertTickRunning = false;
    console.log('[ALERT CHECK] done', JSON.stringify(stats));
    try { await adminDb.collection('system').doc('alert_stats').set({ ...stats, at: admin.firestore.FieldValue.serverTimestamp() }); } catch (e) { /* stats are informational */ }
  }
}

// tick every 15 min; each airport is only polled when due (Max 30 min, Pro-only 60 min) or when a fresh response already exists
setInterval(checkNotamAlerts, ALERT_TICK_MS);
setTimeout(checkNotamAlerts, 30 * 1000);

// Weekly Summary — runs every Monday at 08:00 UTC
function scheduleWeeklySummary() {
  function msUntilNextMonday8am() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(8, 0, 0, 0);
    const day = now.getUTCDay();
    const daysUntilMonday = day === 1 ? (now.getUTCHours() >= 8 ? 7 : 0) : (8 - day) % 7;
    next.setUTCDate(now.getUTCDate() + daysUntilMonday);
    return next.getTime() - now.getTime();
  }
  setTimeout(function runWeekly() {
    sendWeeklySummaries().catch(e => console.log('[WEEKLY] Error:', e.message));
    setTimeout(runWeekly, 7 * 24 * 60 * 60 * 1000);
  }, msUntilNextMonday8am());
}
scheduleWeeklySummary();

// ─── GROWTH AGENT ────────────────────────────────────────────────────────
const GA4_PROPERTY_ID = '546126543';

async function getGA4AccessToken() {
  const key = JSON.parse(process.env.GA_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(key.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('GA4 token request failed: ' + (data.error_description || data.error || res.status));
  return data.access_token;
}

async function fetchGA4Report(accessToken, metrics, dimensions, dateRange) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [dateRange],
      metrics: metrics.map(m => ({ name: m })),
      dimensions: dimensions.map(d => ({ name: d }))
    })
  });
  return res.json();
}

async function runGrowthReport() {
  console.log('[GROWTH AGENT] Running weekly growth report...');
  try {
    const accessToken = await getGA4AccessToken();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const dateRange = { startDate: '7daysAgo', endDate: 'today' };
    const prevDateRange = { startDate: '14daysAgo', endDate: '8daysAgo' };

    // This week metrics
    const [overviewRes, sourceRes, pageRes] = await Promise.all([
      fetchGA4Report(accessToken, ['sessions', 'totalUsers', 'newUsers', 'bounceRate', 'averageSessionDuration'], [], dateRange),
      fetchGA4Report(accessToken, ['sessions'], ['sessionSource'], dateRange),
      fetchGA4Report(accessToken, ['screenPageViews'], ['pagePath'], dateRange)
    ]);

    // Previous week for comparison
    const prevOverviewRes = await fetchGA4Report(accessToken, ['sessions', 'totalUsers', 'newUsers'], [], prevDateRange);

    // Parse overview
    const getVal = (res, idx) => parseFloat(res?.rows?.[0]?.metricValues?.[idx]?.value || 0);
    const sessions = getVal(overviewRes, 0);
    const users = getVal(overviewRes, 1);
    const newUsers = getVal(overviewRes, 2);
    const bounceRate = (getVal(overviewRes, 3) * 100).toFixed(1);
    const avgSession = Math.round(getVal(overviewRes, 4));
    const avgSessionMin = Math.floor(avgSession / 60) + 'm ' + (avgSession % 60) + 's';

    const prevSessions = getVal(prevOverviewRes, 0);
    const prevUsers = getVal(prevOverviewRes, 1);
    const prevNewUsers = getVal(prevOverviewRes, 2);

    const trend = (cur, prev) => {
      if (prev === 0) return cur > 0 ? '🟢 NEW' : '—';
      const pct = Math.round(((cur - prev) / prev) * 100);
      return pct > 0 ? `🟢 +${pct}%` : pct < 0 ? `🔴 ${pct}%` : '⚪ 0%';
    };

    // Top sources
    const sources = (sourceRes?.rows || []).slice(0, 5).map(r => ({
      source: r.dimensionValues[0].value,
      sessions: r.metricValues[0].value
    }));

    // Top pages
    const pages = (pageRes?.rows || []).slice(0, 5).map(r => ({
      path: r.dimensionValues[0].value,
      views: r.metricValues[0].value
    }));

    // Firebase stats
    let newSignups = 0, totalUsers = 0, pro = 0, max = 0, ent = 0, mrr = 0, briefings7d = 0;
    try {
      const usersSnap = await adminDb.collection('users').get();
      totalUsers = usersSnap.size;
      usersSnap.docs.forEach(d => {
        const u = d.data();
        if (u.plan === 'pro') pro++;
        if (u.plan === 'max') max++;
        if (u.plan === 'enterprise') ent++;
        if (u.createdAt && u.createdAt.toDate() >= weekAgo) newSignups++;
      });
      mrr = (pro * 49) + (max * 99) + (ent * 999);
      const bSnap = await adminDb.collection('briefings').where('createdAt', '>=', weekAgo).get();
      briefings7d = bSnap.size;
    } catch(e) {}

    // Claude analysis
    let aiInsight = '';
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: HAIKU_MODEL, ...HAIKU_EXTRA,
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `You are a growth analyst for NOTAM Intelligence, an AI-powered pre-flight briefing SaaS for pilots.

Weekly metrics:
- Sessions: ${sessions} (prev: ${prevSessions})
- Users: ${users} (prev: ${prevUsers})
- New users: ${newUsers} (prev: ${prevNewUsers})
- Bounce rate: ${bounceRate}%
- Avg session: ${avgSessionMin}
- New signups: ${newSignups}
- MRR: $${mrr}
- Briefings generated: ${briefings7d}
- Top traffic source: ${sources[0]?.source || 'direct'}

Write 2-3 sentences of actionable growth insight. Be specific and practical. Focus on what's working and what to improve.`
          }]
        })
      });
      const cd = await claudeRes.json();
      aiInsight = cd.content[0].text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^#\s+.+\n?/gm, '')
        .replace(/\n/g, '<br>');
    } catch(e) {}

    // Send report email
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: 'admin@notamai.com',
        subject: `📈 NOTAM Intelligence — Weekly Growth Report ${now.toISOString().split('T')[0]}`,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:monospace;">
<div style="max-width:600px;margin:0 auto;padding:28px 20px;">

  <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #e2e8f0;margin-bottom:20px;">
    <img src="https://notamai.onrender.com/favicon.png" alt="" width="32" height="32" style="width:32px;height:32px;border-radius:7px;display:inline-block;vertical-align:middle;margin-right:8px;">
    <span style="font-size:14px;font-weight:700;letter-spacing:3px;color:#0f172a;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-top:6px;">WEEKLY GROWTH REPORT · ${now.toISOString().split('T')[0]}</div>
  </div>

  ${aiInsight ? `<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 16px;margin-bottom:20px;border-left:4px solid #4a9eff;">
    <div style="font-size:10px;color:#3b82f6;letter-spacing:2px;margin-bottom:6px;">🤖 AI GROWTH INSIGHT</div>
    <div style="font-size:13px;color:#1e3a5f;line-height:1.6;">${aiInsight}</div>
  </div>` : ''}

  <div style="margin-bottom:20px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">TRAFFIC — LAST 7 DAYS</div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">SESSIONS</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${sessions} <span style="font-size:11px;color:#64748b;">${trend(sessions, prevSessions)}</span></div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">USERS</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${users} <span style="font-size:11px;color:#64748b;">${trend(users, prevUsers)}</span></div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">NEW USERS</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${newUsers} <span style="font-size:11px;color:#64748b;">${trend(newUsers, prevNewUsers)}</span></div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">BOUNCE RATE</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${bounceRate}%</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;">
      <div style="font-size:12px;color:#475569;">AVG SESSION</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${avgSessionMin}</div>
    </div>
  </div>

  <div style="margin-bottom:20px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">BUSINESS — LAST 7 DAYS</div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">NEW SIGNUPS</div>
      <div style="font-size:14px;color:#4a9eff;font-weight:700;">${newSignups}</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">BRIEFINGS GENERATED</div>
      <div style="font-size:14px;color:#4a9eff;font-weight:700;">${briefings7d}</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">TOTAL USERS</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${totalUsers}</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">PRO / MAX</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${pro} / ${max}</div>
    </div>
    <div style="display:flex;justify-content:space-between;padding:9px 0;">
      <div style="font-size:12px;color:#475569;">MRR</div>
      <div style="font-size:18px;color:#2ec4b6;font-weight:700;">$${mrr.toLocaleString()}</div>
    </div>
  </div>

  ${sources.length > 0 ? `<div style="margin-bottom:20px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">TOP TRAFFIC SOURCES</div>
    ${sources.map(s => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:12px;color:#475569;">${s.source}</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${s.sessions} sessions</div>
    </div>`).join('')}
  </div>` : ''}

  ${pages.length > 0 ? `<div style="margin-bottom:24px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">TOP PAGES</div>
    ${pages.map(p => `<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #e2e8f0;">
      <div style="font-size:11px;color:#475569;word-break:break-all;">${p.path}</div>
      <div style="font-size:12px;color:#1e293b;font-weight:700;">${p.views} views</div>
    </div>`).join('')}
  </div>` : ''}

  <div style="text-align:center;border-top:1px solid #e2e8f0;padding-top:16px;">
    <a href="https://notamai.onrender.com/admin" style="display:inline-block;padding:10px 24px;background:transparent;border:1px solid #4a9eff;color:#4a9eff;font-size:11px;letter-spacing:2px;text-decoration:none;border-radius:6px;">OPEN ADMIN PANEL →</a>
  </div>

</div></body></html>`
      })
    });

    console.log('[GROWTH AGENT] Weekly report sent successfully');
  } catch(e) {
    console.log('[GROWTH AGENT ERROR]', e.message);
    await sendAdminNotification('⚠️ Weekly Growth Report failed', `<div style="font-size:13px;color:#b91c1c;">The weekly growth report could not be produced: ${escHtml(e.message)}</div><div style="font-size:12px;color:#475569;margin-top:8px;">Check GA_SERVICE_ACCOUNT_KEY and that the service account has read access to the GA4 property.</div>`);
  }
}

// Schedule growth report every Monday at 09:00 UTC
function scheduleGrowthReport() {
  function msUntilNextMonday9am() {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(9, 0, 0, 0);
    const day = now.getUTCDay();
    const daysUntilMonday = day === 1 ? (now.getUTCHours() >= 9 ? 7 : 0) : (8 - day) % 7;
    next.setUTCDate(now.getUTCDate() + daysUntilMonday);
    return next.getTime() - now.getTime();
  }
  setTimeout(function runWeekly() {
    runGrowthReport().catch(e => console.log('[GROWTH AGENT ERROR]', e.message));
    setTimeout(runWeekly, 7 * 24 * 60 * 60 * 1000);
  }, msUntilNextMonday9am());
  console.log('[GROWTH AGENT] Scheduled — every Monday 09:00 UTC');
}
scheduleGrowthReport();


async function runHealthCheck() {
  console.log('[HEALTH CHECK] Running...');
  const results = {};
  const issues = [];

  // Anthropic + OpenAI fallback status
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST', headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_KEY,'anthropic-version':'2023-06-01'}, body:JSON.stringify({model:HAIKU_MODEL,...HAIKU_EXTRA,max_tokens:10,messages:[{role:'user',content:'ping'}]}) });
    results.anthropic = r.ok ? '✅ OK' : `❌ HTTP ${r.status}`;
    if (!r.ok) issues.push({ msg:'Anthropic API error: HTTP '+r.status, action:'Check console.anthropic.com — verify API key and billing. OpenAI fallback will activate automatically.' });
  } catch(e) { results.anthropic = '❌ '+e.message; issues.push({ msg:'Anthropic unreachable — OpenAI fallback will activate', action:'Check Render logs. Add OPENAI_KEY to Render env vars if not set.' }); }

  // OpenAI fallback status
  results.openai_fallback = process.env.OPENAI_KEY ? '✅ Configured' : '⚠️ Not configured (add OPENAI_KEY)';

  // SkyLink
  try {
    const sd = await adminDb.collection('system').doc('skylink_usage').get();
    if (sd.exists) {
      const s = sd.data(); const pct = s.pct||0;
      results.skylink = pct>=90?`🔴 ${pct}% CRITICAL`:pct>=70?`🟡 ${pct}% WARNING`:`✅ ${pct}%`;
      if (pct>=90) issues.push({ msg:`SkyLink at ${pct}% — upgrade NOW`, action:'Go to rapidapi.com → SkyLink → upgrade plan immediately.' });
      else if (pct>=70) issues.push({ msg:`SkyLink at ${pct}% — plan ahead`, action:'Go to rapidapi.com → SkyLink → consider upgrading plan.' });
    } else { results.skylink = '✅ Free tier'; }
  } catch(e) { results.skylink = '❌ '+e.message; }

  // Free daily cap: yesterday's use and the briefings turned away (unmet demand)
  try {
    const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const d = await adminDb.collection('system').doc('free_briefings_' + y).get();
    const used = d.exists ? (d.data().count || 0) : 0;
    const denied = d.exists ? (d.data().denied || 0) : 0;
    results.free_cap = (denied > 0 ? '🟡 ' : '✅ ') + used + '/' + FREE_DAILY_BRIEFING_CAP + ' used yesterday, ' + denied + ' turned away';
    if (denied > 0) issues.push({ msg: 'Free daily cap turned away ' + denied + ' briefing(s) yesterday', action: 'If this is organic demand and SkyLink usage allows it, raise FREE_DAILY_BRIEFING_CAP in Render; if signups look suspicious, check new accounts.' });
  } catch(e) { results.free_cap = '— ' + e.message; }

  // Firebase
  try {
    await adminDb.collection('system').doc('health').set({lastCheck:admin.firestore.FieldValue.serverTimestamp()});
    results.firebase = '✅ OK';
  } catch(e) { results.firebase = '❌ '+e.message; issues.push({ msg:'Firebase error: '+e.message, action:'Check console.firebase.google.com — verify billing account is active.' }); }

  // Resend
  try {
    const r = await fetch('https://api.resend.com/domains', { headers:{'Authorization':'Bearer '+process.env.RESEND_API_KEY} });
    results.resend = r.ok ? '✅ OK' : `❌ HTTP ${r.status}`;
    if (!r.ok) issues.push({ msg:'Resend error: HTTP '+r.status, action:'Check resend.com — verify API key in Render environment variables.' });
  } catch(e) { results.resend = '❌ '+e.message; issues.push({ msg:'Resend unreachable', action:'Check resend.com dashboard.' }); }

  // WaveSpeed — check credits endpoint
  try {
    const r = await fetch('https://api.wavespeed.ai/api/v3/predictions', { method:'GET', headers:{'Authorization':'Bearer '+process.env.WAVESPEED_KEY} });
    results.wavespeed = (r.ok||r.status===405||r.status===404) ? '✅ OK' : `❌ HTTP ${r.status}`;
    if (r.status===401||r.status===403) issues.push({ msg:'WaveSpeed auth error: HTTP '+r.status, action:'Check wavespeed.ai — verify API key in Render environment variables.' });
  } catch(e) { results.wavespeed = '❌ '+e.message; issues.push({ msg:'WaveSpeed unreachable', action:'Check wavespeed.ai status.' }); }

  await checkProviderCredits(results, issues);

  // Stats
  const now = new Date();
  const yesterday = new Date(now.getTime()-86400000);
  let b24=0,v24=0,u24=0,totalUsers=0,pro=0,max=0,mrr=0;
  try { b24 = (await adminDb.collection('briefings').where('createdAt','>=',yesterday).get()).size; } catch(e) {}
  try { v24 = (await adminDb.collection('videos').where('createdAt','>=',yesterday).where('status','==','completed').get()).size; } catch(e) {}
  try { u24 = (await adminDb.collection('users').where('createdAt','>=',yesterday).get()).size; } catch(e) {}
  try {
    const us = await adminDb.collection('users').get();
    totalUsers = us.size;
    let ent = 0;
    us.docs.forEach(d=>{ const pl = d.data().plan; if(pl==='pro') pro++; if(pl==='max') max++; if(pl==='enterprise') ent++; });
    mrr = (pro*49)+(max*99)+(ent*999);
  } catch(e) {}

  // Activation stats — first briefings and upgrade candidates
  let firstBriefingUsers = [], firstVideoUsers = [], upgradeCandidate = [];
  try {
    const briefSnap = await adminDb.collection('briefings').where('createdAt','>=',yesterday).get();
    const userBriefCounts = {};
    briefSnap.docs.forEach(d => {
      const uid = d.data().userId;
      if (uid) userBriefCounts[uid] = (userBriefCounts[uid] || 0) + 1;
    });
    for (const [uid, count] of Object.entries(userBriefCounts)) {
      const allBriefs = await adminDb.collection('briefings').where('userId','==',uid).get();
      if (allBriefs.size === count) {
        const uDoc = await adminDb.collection('users').doc(uid).get();
        if (uDoc.exists) firstBriefingUsers.push(uDoc.data().email || uid);
      }
    }
  } catch(e) {}
  try {
    const vidSnap = await adminDb.collection('videos').where('createdAt','>=',yesterday).where('status','==','completed').get();
    const userVidSet = new Set();
    for (const d of vidSnap.docs) {
      const uid = d.data().userId;
      if (!uid || userVidSet.has(uid)) continue;
      userVidSet.add(uid);
      const allVids = await adminDb.collection('videos').where('userId','==',uid).where('status','==','completed').get();
      if (allVids.size === 1) {
        const uDoc = await adminDb.collection('users').doc(uid).get();
        if (uDoc.exists) firstVideoUsers.push(uDoc.data().email || uid);
      }
    }
  } catch(e) {}
  try {
    const usageSnap = await adminDb.collection('usage').get();
    const monthKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');
    for (const d of usageSnap.docs) {
      if (!d.id.endsWith(monthKey)) continue;
      const ud = d.data();
      const uid = ud.userId;
      if (!uid) continue;
      const uDoc = await adminDb.collection('users').doc(uid).get();
      if (!uDoc.exists) continue;
      const plan = uDoc.data().plan || 'free';
      const limits = { free: 3, pro: 100, max: 150 };
      const limit = limits[plan];
      if (!limit) continue;
      const briefings = ud.briefings || 0;
      if (briefings >= Math.floor(limit * 0.8)) {
        upgradeCandidate.push({ email: uDoc.data().email || uid, plan, briefings, limit });
      }
    }
  } catch(e) {}

  const statusIcon = issues.length===0?'✅':issues.length<=2?'⚠️':'🚨';

  await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},
    body: JSON.stringify({
      from:'NOTAM Intelligence <alerts@notamai.com>',
      to:'admin@notamai.com',
      subject:`${statusIcon} NOTAM Intelligence — Daily Report ${now.toISOString().split('T')[0]}`,
      html:`<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0f18;font-family:monospace;color:#cdd9e5;">
<div style="max-width:580px;margin:0 auto;padding:32px 20px;">

<div style="text-align:center;padding-bottom:20px;border-bottom:1px solid #1a2a3a;margin-bottom:24px;">
  <div style="font-size:15px;font-weight:700;letter-spacing:4px;color:#fff;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></div>
  <div style="font-size:10px;color:#4a5f72;letter-spacing:3px;margin-top:4px;">DAILY SYSTEM REPORT · ${now.toUTCString()}</div>
</div>

${issues.length>0
  ? `<div style="background:rgba(230,57,70,0.12);border:1px solid rgba(230,57,70,0.4);border-radius:8px;padding:16px;margin-bottom:24px;">
      <div style="font-size:10px;color:#e63946;letter-spacing:2px;margin-bottom:12px;">🚨 ISSUES DETECTED — ACTION REQUIRED</div>
      ${issues.map(i=>`
      <div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid rgba(230,57,70,0.2);">
        <div style="font-size:13px;color:#fca5a5;">• ${i.msg}</div>
        <div style="font-size:11px;color:#f87171;margin-top:4px;padding-left:12px;">→ ${i.action}</div>
      </div>`).join('')}
    </div>`
  : `<div style="background:rgba(46,196,182,0.1);border:1px solid rgba(46,196,182,0.3);border-radius:8px;padding:14px;margin-bottom:24px;">
      <div style="font-size:13px;color:#2ec4b6;">✅ All systems operational — no action needed.</div>
    </div>`}

<div style="margin-bottom:24px;">
  <div style="font-size:10px;color:#4a5f72;letter-spacing:2px;margin-bottom:10px;">SYSTEM STATUS</div>
  ${Object.entries(results).map(([k,v])=>`
  <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #1a2a3a;">
    <div style="font-size:12px;color:#8a9bb0;letter-spacing:1px;">${k.toUpperCase()}</div>
    <div style="font-size:12px;color:#cdd9e5;">${v}</div>
  </div>`).join('')}
</div>

<div style="margin-bottom:24px;">
  <div style="font-size:10px;color:#4a5f72;letter-spacing:2px;margin-bottom:10px;">LAST 24 HOURS</div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1a2a3a;"><div style="font-size:12px;color:#8a9bb0;">BRIEFINGS</div><div style="font-size:14px;color:#4a9eff;font-weight:700;">${b24}</div></div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1a2a3a;"><div style="font-size:12px;color:#8a9bb0;">VIDEO BRIEFINGS</div><div style="font-size:14px;color:#f4841a;font-weight:700;">${v24}</div></div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;"><div style="font-size:12px;color:#8a9bb0;">NEW USERS</div><div style="font-size:14px;color:#2ec4b6;font-weight:700;">${u24}</div></div>
</div>

<div style="margin-bottom:28px;">
  <div style="font-size:10px;color:#4a5f72;letter-spacing:2px;margin-bottom:10px;">BUSINESS METRICS</div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1a2a3a;"><div style="font-size:12px;color:#8a9bb0;">TOTAL USERS</div><div style="font-size:14px;color:#cdd9e5;font-weight:700;">${totalUsers}</div></div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #1a2a3a;"><div style="font-size:12px;color:#8a9bb0;">PRO / MAX</div><div style="font-size:14px;color:#cdd9e5;font-weight:700;">${pro} / ${max}</div></div>
  <div style="display:flex;justify-content:space-between;padding:9px 0;"><div style="font-size:12px;color:#8a9bb0;">MRR</div><div style="font-size:18px;color:#2ec4b6;font-weight:700;">$${mrr.toLocaleString()}</div></div>
</div>

${firstBriefingUsers.length > 0 ? `
<div style="margin-bottom:20px;">
  <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">✈️ FIRST BRIEFING TODAY</div>
  ${firstBriefingUsers.map(e => `<div style="font-size:12px;color:#1e293b;padding:5px 0;border-bottom:1px solid #e2e8f0;">${e}</div>`).join('')}
</div>` : ''}

${firstVideoUsers.length > 0 ? `
<div style="margin-bottom:20px;">
  <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">🎬 FIRST VIDEO TODAY</div>
  ${firstVideoUsers.map(e => `<div style="font-size:12px;color:#1e293b;padding:5px 0;border-bottom:1px solid #e2e8f0;">${e}</div>`).join('')}
</div>` : ''}

${upgradeCandidate.length > 0 ? `
<div style="margin-bottom:20px;">
  <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">⚠️ UPGRADE CANDIDATES</div>
  ${upgradeCandidate.map(u => `<div style="font-size:12px;color:#1e293b;padding:5px 0;border-bottom:1px solid #e2e8f0;">${u.email} — ${u.plan.toUpperCase()} ${u.briefings}/${u.limit}</div>`).join('')}
</div>` : ''}

<div style="text-align:center;border-top:1px solid #1a2a3a;padding-top:20px;">
  <a href="https://notamai.onrender.com/admin" style="display:inline-block;padding:11px 28px;background:transparent;border:1px solid rgba(74,158,255,0.4);color:#4a9eff;font-size:11px;letter-spacing:2px;text-decoration:none;border-radius:6px;">OPEN ADMIN PANEL →</a>
</div>

</div></body></html>`
    })
  });
  console.log('[HEALTH CHECK] Done. Issues:',issues.length,'MRR: $'+mrr);
}

function scheduleDailyHealthCheck() {
  function msUntil8am() {
    const now=new Date(), next=new Date(now);
    next.setUTCHours(8,0,0,0);
    if(next<=now) next.setUTCDate(next.getUTCDate()+1);
    return next.getTime()-now.getTime();
  }
  setTimeout(function run() {
    runHealthCheck().catch(e=>console.log('[HEALTH CHECK ERROR]',e.message));
    setTimeout(run, 86400000);
  }, msUntil8am());
}
scheduleDailyHealthCheck();

// ─── AGENT HELPERS ───────────────────────────────────────────────────────
// Customer e-mails and model output are untrusted: escape before putting into the admin HTML.
function escHtml(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// First text block of an Anthropic response, or '' when the call failed / returned no text.
function aiText(data) {
  const b = data && Array.isArray(data.content) ? data.content.find(x => x && x.type === 'text') : null;
  return b && typeof b.text === 'string' ? b.text : '';
}
function replyAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).replace(/[<>\s"]/g, '');
}

// ─── REAL-TIME NOTIFICATION AGENT ────────────────────────────────────────
async function sendAdminNotification(subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: 'admin@notamai.com',
        subject,
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:monospace;">
<div style="max-width:520px;margin:0 auto;padding:24px 20px;">
  <div style="text-align:center;padding-bottom:12px;border-bottom:1px solid #e2e8f0;margin-bottom:16px;">
    <img src="https://notamai.onrender.com/favicon.png" alt="" width="30" height="30" style="width:30px;height:30px;border-radius:7px;display:inline-block;vertical-align:middle;margin-right:8px;">
    <span style="font-size:13px;font-weight:700;letter-spacing:3px;color:#0f172a;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
  </div>
  ${html}
  <div style="text-align:center;border-top:1px solid #e2e8f0;padding-top:14px;margin-top:16px;">
    <a href="https://notamai.onrender.com/admin" style="display:inline-block;padding:9px 22px;background:transparent;border:1px solid #4a9eff;color:#4a9eff;font-size:11px;letter-spacing:2px;text-decoration:none;border-radius:6px;">OPEN ADMIN →</a>
  </div>
</div></body></html>`
      })
    });
  } catch(e) {
    console.log('[NOTIFICATION] Send error:', e.message);
  }
}

// Watch Firestore for real-time events
// ─── REAL-TIME NOTIFICATIONS (Critical events only) ───────────────────────
function startRealtimeNotifications() {
  console.log('[NOTIFICATIONS] Starting real-time watchers...');

  // One listener for both events. The plan seen on the first snapshot is the baseline, so only a real
  // plan change notifies (profile saves and usage writes touch the doc but never change `plan`).
  const knownPlan = new Map();
  let firstSnapshot = true;
  const MRR_BY_PLAN = { pro: 49, max: 99, enterprise: 999 };
  const planColors = { pro: '#4a9eff', max: '#f4841a', enterprise: '#b57bff' };

  adminDb.collection('users').onSnapshot(snapshot => {
    const initial = firstSnapshot;
    firstSnapshot = false;
    snapshot.docChanges().forEach(async change => {
      try {
        const data = change.doc.data();
        const uid = change.doc.id;
        const email = data.email || uid;
        const name = data.displayName || email;
        const plan = ['free','pro','max','enterprise'].includes(data.plan) ? data.plan : 'free';   // legacy 'premium' etc. = free
        const prev = knownPlan.get(uid);
        knownPlan.set(uid, plan);
        if (change.type === 'removed') { knownPlan.delete(uid); return; }
        if (initial) return;   // baseline only — never announce existing users on a restart

        if (change.type === 'added') {
          // Registration time: user doc createdAt, else the Auth account's creation time (Google sign-ups have no createdAt).
          let created = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate().getTime() : null;
          if (!created) { try { created = new Date((await admin.auth().getUser(uid)).metadata.creationTime).getTime(); } catch (e) {} }
          if (!created || Date.now() - created > 10 * 60 * 1000) return;
          console.log('[NOTIFICATIONS] New user:', email);
          await sendAdminNotification(
            `🆕 New User — ${email}`,
            `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;border-left:4px solid #22c55e;">
              <div style="font-size:11px;color:#16a34a;letter-spacing:2px;margin-bottom:8px;">🆕 NEW USER REGISTERED</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Name:</strong> ${escHtml(name)}</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Email:</strong> ${escHtml(email)}</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Plan:</strong> ${escHtml(plan.toUpperCase())}</div>
              <div style="font-size:13px;color:#1e293b;"><strong>Time:</strong> ${new Date().toUTCString()}</div>
            </div>`
          );
          return;
        }

        // modified: only a genuine plan change
        if (prev === undefined || prev === plan) return;
        const wasPaid = !!MRR_BY_PLAN[prev], isPaid = !!MRR_BY_PLAN[plan];
        if (isPaid && MRR_BY_PLAN[plan] > (MRR_BY_PLAN[prev] || 0)) {
          console.log('[NOTIFICATIONS] Plan upgrade:', email, prev, '->', plan);
          await sendAdminNotification(
            `⬆️ Plan Upgrade — ${email} → ${plan.toUpperCase()}`,
            `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px;border-left:4px solid #22c55e;">
              <div style="font-size:11px;color:#16a34a;letter-spacing:2px;margin-bottom:8px;">⬆️ PLAN UPGRADED</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>User:</strong> ${escHtml(name)}</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Email:</strong> ${escHtml(email)}</div>
              <div style="font-size:16px;color:${planColors[plan] || '#64748b'};font-weight:700;margin-bottom:4px;">${escHtml(prev.toUpperCase())} → ${escHtml(plan.toUpperCase())}</div>
              <div style="font-size:13px;color:#16a34a;margin-bottom:4px;">💰 MRR change: +$${MRR_BY_PLAN[plan] - (MRR_BY_PLAN[prev] || 0)}/month</div>
              <div style="font-size:13px;color:#1e293b;"><strong>Time:</strong> ${new Date().toUTCString()}</div>
            </div>`
          );
        } else if (wasPaid && (MRR_BY_PLAN[plan] || 0) < MRR_BY_PLAN[prev]) {
          // downgrade or cancellation — the most important churn signal
          console.log('[NOTIFICATIONS] Plan downgrade:', email, prev, '->', plan);
          await sendAdminNotification(
            `⬇️ Plan Downgrade — ${email} → ${plan.toUpperCase()}`,
            `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:14px;border-left:4px solid #ef4444;">
              <div style="font-size:11px;color:#b91c1c;letter-spacing:2px;margin-bottom:8px;">⬇️ PLAN DOWNGRADED / CANCELLED</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>User:</strong> ${escHtml(name)}</div>
              <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Email:</strong> ${escHtml(email)}</div>
              <div style="font-size:16px;color:#b91c1c;font-weight:700;margin-bottom:4px;">${escHtml(prev.toUpperCase())} → ${escHtml(plan.toUpperCase())}</div>
              <div style="font-size:13px;color:#b91c1c;margin-bottom:4px;">MRR change: -$${(MRR_BY_PLAN[prev] || 0) - (MRR_BY_PLAN[plan] || 0)}/month</div>
              <div style="font-size:13px;color:#1e293b;"><strong>Time:</strong> ${new Date().toUTCString()}</div>
            </div>`
          );
        }
      } catch (e) { console.log('[NOTIFICATIONS] Users watcher handler error:', e.message); }
    });
  }, err => console.log('[NOTIFICATIONS] Users watcher error:', err.message));

  console.log('[NOTIFICATIONS] Real-time watcher active (new user + upgrade + downgrade).');
}

setTimeout(() => startRealtimeNotifications(), 20 * 1000);

// ─── SALES AGENT ────────────────────────────────────────────────────────
async function processSalesLead(email, supportAnalysis) {
  console.log('[SALES AGENT] Processing Enterprise lead from:', email.from);
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: HAIKU_MODEL, ...HAIKU_EXTRA,
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `You are a B2B sales specialist for NOTAM Intelligence, an AI-powered pre-flight briefing SaaS for aviation professionals.

PRICING:
- Pro: $49/month per user
- Max: $99/month per user
- Enterprise: $999/month (up to 10 users) — Everything in Max + API Access, Priority Support & SLA, Dedicated Account Manager, Custom Onboarding
- 11-25 users: $1,999/month
- 26-50 users: $3,499/month
- 50+ users: Custom pricing, annual contract required
- Annual discount: 15% off

Customer email:
From: ${email.from}
Subject: ${email.subject}
Message: ${email.text}

Support analysis: ${supportAnalysis}

Respond ONLY with a valid JSON object, no other text before or after:
{
  "company_profile": "one sentence about the company type",
  "estimated_users": "estimated number and type of users",
  "recommended_plan": "which plan and why (one sentence)",
  "estimated_value": "monthly and annual value (one line)",
  "key_questions": ["question 1", "question 2", "question 3"],
  "proposal": "Dear [Name],\\n\\n[paragraph 1 - warm intro and understanding their need]\\n\\n[paragraph 2 - key benefits for their use case]\\n\\n[paragraph 3 - call to action]\\n\\nBest regards,\\nNOTAM Intelligence Sales Team\\nsupport@notamai.com\\nnotamai.com",
  "followup": ["Day 1: action", "Day 3: action", "Day 7: action"]
}`
        }]
      })
    });

    const data = await claudeRes.json();
    const analysis = aiText(data);
    if (!analysis) throw new Error('empty AI response (' + claudeRes.status + ')');
    let parsed = {};
    try {
      const jsonMatch = analysis.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : analysis);
    } catch(e) {
      console.log('[SALES AGENT] JSON parse error:', e.message, 'Raw:', analysis.slice(0, 200));
    }

    const companyProfile = parsed.company_profile || '';
    const estimatedUsers = parsed.estimated_users || '';
    const recommendedPlan = parsed.recommended_plan || '';
    const estimatedValue = parsed.estimated_value || '';
    const keyQuestions = Array.isArray(parsed.key_questions) ? parsed.key_questions.join('\n') : (parsed.key_questions || '');
    const keyQuestionsClean = keyQuestions;
    const proposalDraft = (parsed.proposal || '').replace(/\\n/g, '\n');
    const followupPlan = Array.isArray(parsed.followup) ? parsed.followup.join('\n') : (parsed.followup || '');
    const estimatedValueClean = estimatedValue;


    // Send sales report to admin
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: 'admin@notamai.com',
        subject: `🎯 Enterprise Lead — ${email.from} — ${estimatedValueClean || estimatedValue || 'Unknown Value'}`.replace(/[\r\n]+/g, ' ').slice(0, 200),
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:monospace;">
<div style="max-width:640px;margin:0 auto;padding:28px 20px;">

  <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #e2e8f0;margin-bottom:20px;">
    <img src="https://notamai.onrender.com/favicon.png" alt="" width="32" height="32" style="width:32px;height:32px;border-radius:7px;display:inline-block;vertical-align:middle;margin-right:8px;">
    <span style="font-size:14px;font-weight:700;letter-spacing:3px;color:#0f172a;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-top:3px;">🎯 SALES AGENT — ENTERPRISE LEAD</div>
  </div>

  <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;margin-bottom:20px;border-left:4px solid #22c55e;">
    <div style="font-size:10px;color:#16a34a;letter-spacing:2px;margin-bottom:6px;">💰 NEW ENTERPRISE OPPORTUNITY</div>
    <div style="font-size:13px;color:#14532d;"><strong>From:</strong> ${escHtml(email.from)}</div>
    <div style="font-size:13px;color:#14532d;"><strong>Estimated Value:</strong> ${escHtml(estimatedValue)}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">ORIGINAL EMAIL</div>
    <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Subject:</strong> ${escHtml(email.subject)}</div>
    <div style="margin-top:8px;padding:10px;background:#f8fafc;border-radius:4px;font-size:12px;color:#475569;white-space:pre-wrap;">${escHtml(email.text.slice(0, 400))}${email.text.length > 400 ? '...' : ''}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">LEAD ANALYSIS</div>
    <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">COMPANY PROFILE</div>
      <div style="font-size:13px;color:#1e293b;">${escHtml(companyProfile)}</div>
    </div>
    <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">ESTIMATED USERS</div>
      <div style="font-size:13px;color:#1e293b;">${escHtml(estimatedUsers)}</div>
    </div>
    <div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">RECOMMENDED PLAN</div>
      <div style="font-size:13px;color:#1e293b;">${escHtml(recommendedPlan)}</div>
    </div>
    <div>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:3px;">ESTIMATED VALUE</div>
      <div style="font-size:16px;color:#16a34a;font-weight:700;">${escHtml(estimatedValue)}</div>
    </div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">KEY QUALIFYING QUESTIONS</div>
    <div style="font-size:13px;color:#1e293b;white-space:pre-wrap;">${escHtml(keyQuestions)}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">FOLLOW-UP PLAN</div>
    <div style="font-size:13px;color:#1e293b;white-space:pre-wrap;">${escHtml(followupPlan)}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">PROPOSAL DRAFT</div>
    <div style="font-size:12px;color:#475569;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:4px;border-left:3px solid #22c55e;">${escHtml(proposalDraft.slice(0, 2000))}</div>
  </div>

  <div style="text-align:center;">
    <a href="mailto:${escHtml(replyAddress(email.from))}?subject=Re%3A%20${encodeURIComponent(email.subject)}&body=${encodeURIComponent(proposalDraft.slice(0, 1800))}"
       style="display:inline-block;padding:11px 28px;background:#22c55e;color:#fff;font-size:12px;letter-spacing:2px;text-decoration:none;border-radius:6px;font-weight:700;">
      SEND PROPOSAL →
    </a>
  </div>

</div></body></html>`
      })
    });

    console.log('[SALES AGENT] Enterprise lead processed for:', email.from, '| Value:', estimatedValueClean || estimatedValue);
  } catch(e) {
    console.log('[SALES AGENT ERROR]', e.message);
    // The support path skips its own notification for enterprise mails, so a failure here must not lose the lead.
    await sendAdminNotification(
      `⚠️ Enterprise inquiry (AI analysis failed) — ${String(email.subject).replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
      `<div style="font-size:12px;color:#b91c1c;margin-bottom:8px;">Sales analysis failed: ${escHtml(e.message)}. Original message below.</div>
       <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>From:</strong> ${escHtml(email.from)}</div>
       <div style="font-size:13px;color:#1e293b;margin-bottom:8px;"><strong>Subject:</strong> ${escHtml(email.subject)}</div>
       <div style="padding:10px;background:#f8fafc;border-radius:4px;font-size:12px;color:#475569;white-space:pre-wrap;">${escHtml(email.text.slice(0, 1500))}</div>`
    );
  }
}

// ─── SUPPORT AGENT ────────────────────────────────────────────────────────
const processedEmails = new Set();

async function checkSupportEmails() {
  if (!process.env.SUPPORT_EMAIL || !process.env.SUPPORT_EMAIL_PASSWORD) return;

  return new Promise((resolve) => {
    const imap = new Imap({
      user: process.env.SUPPORT_EMAIL,
      password: process.env.SUPPORT_EMAIL_PASSWORD,
      host: 'imap.hostinger.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false }
    });

    imap.once('error', (e) => {
      console.log('[SUPPORT AGENT] IMAP error:', e.message);
      resolve();
    });

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); resolve(); return; }

        // Fetch unseen emails from last 24 hours
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);

        imap.search(['UNSEEN'], (err, results) => {
          if (err || !results || results.length === 0) {
            imap.end(); resolve(); return;
          }

          console.log('[SUPPORT AGENT] Found', results.length, 'unread emails');

          const fetch = imap.fetch(results, { bodies: '' });
          const parsePromises = [];

          fetch.on('message', (msg) => {
            const parsePromise = new Promise((resolveMsg) => {
              msg.on('body', (stream) => {
                simpleParser(stream).then((parsed) => {
                  const msgId = parsed.messageId || parsed.subject + parsed.date;
                  if (!processedEmails.has(msgId)) {
                    processedEmails.add(msgId);
                    resolveMsg({
                      from: parsed.from?.text || 'Unknown',
                      subject: parsed.subject || '(no subject)',
                      text: (parsed.text || String(parsed.html || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).slice(0, 2000),
                      date: parsed.date || new Date()
                    });
                  } else {
                    resolveMsg(null);
                  }
                }).catch(() => resolveMsg(null));
              });
            });
            parsePromises.push(parsePromise);
          });

          fetch.once('end', async () => {
            imap.end();
            try {
              const emails = (await Promise.all(parsePromises)).filter(Boolean);
              console.log('[SUPPORT AGENT] Parsed', emails.length, 'emails');
              for (const email of emails) {
                await processSupportEmail(email);
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch(e) {
              console.log('[SUPPORT AGENT] Parse error:', e.message);
            }
            resolve();
          });
        });
      });
    });

    imap.connect();
  });
}

async function processSupportEmail(email) {
  try {
    console.log('[SUPPORT AGENT] Processing email from:', email.from);

    // Analyze with Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: HAIKU_MODEL, ...HAIKU_EXTRA,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a support agent for NOTAM Intelligence, an AI-powered pre-flight briefing system for pilots and flight dispatchers.

PLANS & PRICING:
- Free: 3 AI Briefings/month, NOTAMs & MET live data, SIGMET/AIRMET, Aviation Tools Panel
- Pro ($49/month): 100 AI Briefings/month, NOTAM Intelligence Chat, En-route FIR Analysis, AI Assistant, NOTAM/METAR/TAF Analysis, Briefing Archive, Saved Routes (3), NOTAM Alerts (3 airports, checked about every 60 min), Share & PDF Export
- Max ($99/month): Everything in Pro + 150 AI Briefings/month, AI Video Briefing (5/month), higher chat limits, unlimited archive, saved routes (up to 20), NOTAM alerts (5 airports, checked about every 30 min), Priority Support, extra video pack $10=3 videos
- Enterprise ($999/month): Everything in Max + up to 10 users, API Access, Priority Support & SLA, Dedicated Account Manager, Custom Onboarding
- All paid plans have 7-day free trial, cancel anytime
- Annual billing available with 15% discount

COMPANY INFO:
- Website: notamai.com
- Support email: support@notamai.com
- Built for aviation professionals worldwide

Analyze this customer email and provide:
1. CATEGORY: (Technical Issue / Billing / Feature Request / General Question / Enterprise Inquiry / Other)
2. PRIORITY: (High / Medium / Low)
3. SUMMARY: One sentence summary
4. SUGGESTED_REPLY: A professional, helpful reply email based on ACTUAL plan features above (in English, signed "NOTAM Intelligence Support Team"). Be accurate - only mention features that actually exist.

Customer email:
From: ${email.from}
Subject: ${email.subject}
Message: ${email.text}

Respond in this exact format:
CATEGORY: ...
PRIORITY: ...
SUMMARY: ...
SUGGESTED_REPLY:
[reply text here]`
        }]
      })
    });

    const data = await claudeRes.json();
    const analysis = aiText(data);
    if (!analysis) throw new Error('empty AI response (' + claudeRes.status + ')');

    // Parse Claude's response
    const categoryMatch = analysis.match(/CATEGORY:\s*(.+)/);
    const priorityMatch = analysis.match(/PRIORITY:\s*(.+)/);
    const summaryMatch = analysis.match(/SUMMARY:\s*(.+)/);
    const replyMatch = analysis.match(/SUGGESTED_REPLY:\n([\s\S]+)/);

    const category = categoryMatch ? categoryMatch[1].trim() : 'Unknown';
    const priority = priorityMatch ? priorityMatch[1].trim() : 'Medium';
    const summary = summaryMatch ? summaryMatch[1].trim() : email.subject;
    const suggestedReply = replyMatch ? replyMatch[1].trim() : '';

    const priorityEmoji = priority === 'High' ? '🔴' : priority === 'Medium' ? '🟡' : '🟢';

    // For Enterprise — only send Sales Agent report, skip regular support notification
    if (category.toLowerCase().includes('enterprise')) {
      console.log('[SALES AGENT] Enterprise inquiry detected — triggering Sales Agent');
      processSalesLead(email, `Category: ${category} | Priority: ${priority} | Summary: ${summary}`).catch(e => console.log('[SALES AGENT ERROR]', e.message));
      return;
    }

    // Send notification to admin
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'NOTAM Intelligence <alerts@notamai.com>',
        to: 'admin@notamai.com',
        subject: `${priorityEmoji} New Support Email — ${category} — ${summary}`.replace(/[\r\n]+/g, ' ').slice(0, 200),
        html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:monospace;">
<div style="max-width:600px;margin:0 auto;padding:28px 20px;">

  <div style="text-align:center;padding-bottom:16px;border-bottom:1px solid #e2e8f0;margin-bottom:20px;">
    <img src="https://notamai.onrender.com/favicon.png" alt="" width="32" height="32" style="width:32px;height:32px;border-radius:7px;display:inline-block;vertical-align:middle;margin-right:8px;">
    <span style="font-size:14px;font-weight:700;letter-spacing:3px;color:#0f172a;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-top:3px;">SUPPORT AGENT</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">INCOMING EMAIL</div>
    <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>From:</strong> ${escHtml(email.from)}</div>
    <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Subject:</strong> ${escHtml(email.subject)}</div>
    <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>Date:</strong> ${escHtml(email.date)}</div>
    <div style="margin-top:10px;padding:10px;background:#f8fafc;border-radius:4px;font-size:12px;color:#475569;white-space:pre-wrap;">${escHtml(email.text.slice(0, 500))}${email.text.length > 500 ? '...' : ''}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">AI ANALYSIS</div>
    <div style="display:flex;gap:12px;margin-bottom:8px;">
      <div style="background:#f1f5f9;padding:6px 12px;border-radius:20px;font-size:12px;color:#475569;"><strong>Category:</strong> ${escHtml(category)}</div>
      <div style="background:${priority==='High'?'#fef2f2':priority==='Medium'?'#fffbeb':'#f0fdf4'};padding:6px 12px;border-radius:20px;font-size:12px;color:${priority==='High'?'#dc2626':priority==='Medium'?'#d97706':'#16a34a'};">${priorityEmoji} ${priority} Priority</div>
    </div>
    <div style="font-size:13px;color:#1e293b;"><strong>Summary:</strong> ${escHtml(summary)}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:20px;">
    <div style="font-size:10px;color:#64748b;letter-spacing:2px;margin-bottom:10px;">SUGGESTED REPLY</div>
    <div style="font-size:12px;color:#475569;white-space:pre-wrap;background:#f8fafc;padding:12px;border-radius:4px;border-left:3px solid #4a9eff;">${escHtml(suggestedReply)}</div>
  </div>

  <div style="text-align:center;">
    <a href="mailto:${escHtml(replyAddress(email.from))}?subject=Re%3A%20${encodeURIComponent(email.subject)}&body=${encodeURIComponent(suggestedReply)}"
       style="display:inline-block;padding:11px 24px;background:#4a9eff;color:#fff;font-size:12px;letter-spacing:2px;text-decoration:none;border-radius:6px;font-weight:700;">
      REPLY TO CUSTOMER →
    </a>
  </div>

</div></body></html>`
      })
    });

    console.log('[SUPPORT AGENT] Notification sent for email from:', email.from, '| Category:', category, '| Priority:', priority);

  } catch(e) {
    console.log('[SUPPORT AGENT] Error processing email:', e.message);
    // The mail is already marked as read on the server — never lose it: forward the raw text to the admin.
    await sendAdminNotification(
      `⚠️ Support e-mail (AI analysis failed) — ${String(email.subject).replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
      `<div style="font-size:12px;color:#b91c1c;margin-bottom:8px;">AI analysis failed: ${escHtml(e.message)}. Original message below.</div>
       <div style="font-size:13px;color:#1e293b;margin-bottom:4px;"><strong>From:</strong> ${escHtml(email.from)}</div>
       <div style="font-size:13px;color:#1e293b;margin-bottom:8px;"><strong>Subject:</strong> ${escHtml(email.subject)}</div>
       <div style="padding:10px;background:#f8fafc;border-radius:4px;font-size:12px;color:#475569;white-space:pre-wrap;">${escHtml(email.text.slice(0, 1500))}</div>`
    );
  }
}

// Check support emails every 5 minutes
setInterval(() => {
  console.log('[SUPPORT AGENT] Interval check running...');
  checkSupportEmails().catch(e => console.log('[SUPPORT AGENT ERROR]', e.message));
}, 5 * 60 * 1000);

// Run once on startup after 30 seconds
setTimeout(() => {
  console.log('[SUPPORT AGENT] Starting startup check...');
  checkSupportEmails().then(() => {
    console.log('[SUPPORT AGENT] Startup check complete');
  }).catch(e => console.log('[SUPPORT AGENT ERROR]', e.message));
}, 30 * 1000);

async function sendWeeklySummaries() {
  console.log('[WEEKLY] Sending weekly summaries...');
  try {
    const usersSnap = await adminDb.collection('users').get();
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let weeklySent = 0, weeklyFailed = 0;

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const userId = userDoc.id;
      const notifications = userData.notifications || {};
      if (notifications.weeklySummary === false) continue;
      const plan = await getUserPlan(userId);
      if (plan === 'free') continue;

      let userEmail = null;
      try {
        const userRecord = await admin.auth().getUser(userId);
        userEmail = userRecord.email;
      } catch(e) { continue; }
      if (!userEmail) continue;

      const briefSnap = await adminDb.collection('briefings')
        .where('userId', '==', userId)
        .where('createdAt', '>=', weekAgo)
        .get();
      const weeklyBriefings = briefSnap.size;
      if (weeklyBriefings === 0) continue;

      const routeCount = {};
      briefSnap.docs.forEach(d => {
        const r = d.data().route || '';
        if (r) routeCount[r] = (routeCount[r] || 0) + 1;
      });
      const topRoute = Object.entries(routeCount).sort((a,b) => b[1]-a[1])[0];

      const videoSnap = await adminDb.collection('videos')
        .where('userId', '==', userId)
        .where('createdAt', '>=', weekAgo)
        .where('status', '==', 'completed')
        .get();
      const weeklyVideos = videoSnap.size;

      let totalBriefings = weeklyBriefings;
      try {
        const agg = await adminDb.collection('briefings').where('userId', '==', userId).count().get();
        totalBriefings = agg.data().count;
      } catch(e) {
        totalBriefings = (await adminDb.collection('briefings').where('userId', '==', userId).get()).size;
      }

      const displayName = userData.displayName || userEmail.split('@')[0];

      const wkRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'NOTAM Intelligence <alerts@notamai.com>',
          to: userEmail,
          subject: '📊 Your Weekly NOTAM Intelligence Summary',
          html: `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#060a0f;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:'Rajdhani',Helvetica,Arial,sans-serif;">
    <div style="text-align:center;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid #1a2a3a;">
      <img src="https://notamai.onrender.com/favicon.png" alt="" width="37" height="37" style="width:37px;height:37px;border-radius:8px;display:inline-block;vertical-align:middle;margin-right:8px;">
      <span style="font-family:Georgia,serif;font-size:16px;font-weight:700;letter-spacing:4px;color:#ffffff;vertical-align:middle;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></span>
      <div style="font-family:monospace;font-size:10px;color:#4a5f72;letter-spacing:2px;margin-top:6px;">WEEKLY ACTIVITY SUMMARY</div>
    </div>
    <div style="margin-bottom:24px;">
      <p style="font-size:15px;color:#8a9bb0;margin:0 0 4px;">Good morning,</p>
      <p style="font-size:18px;font-weight:700;color:#cdd9e5;margin:0;">Here's your week in review.</p>
    </div>
    <div style="display:grid;gap:12px;margin-bottom:28px;">
      <div style="background:#0a0f18;border:1px solid #1a2a3a;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:monospace;font-size:11px;color:#4a5f72;letter-spacing:1px;">BRIEFINGS THIS WEEK</div>
        <div style="font-family:monospace;font-size:22px;font-weight:700;color:#4a9eff;">${weeklyBriefings}</div>
      </div>
      ${topRoute ? `<div style="background:#0a0f18;border:1px solid #1a2a3a;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:monospace;font-size:11px;color:#4a5f72;letter-spacing:1px;">TOP ROUTE</div>
        <div style="font-family:monospace;font-size:14px;font-weight:700;color:#cdd9e5;">${topRoute[0]} <span style="color:#4a5f72;">(×${topRoute[1]})</span></div>
      </div>` : ''}
      ${weeklyVideos > 0 ? `<div style="background:#0a0f18;border:1px solid #1a2a3a;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:monospace;font-size:11px;color:#4a5f72;letter-spacing:1px;">VIDEO BRIEFINGS</div>
        <div style="font-family:monospace;font-size:22px;font-weight:700;color:#f4841a;">${weeklyVideos}</div>
      </div>` : ''}
      <div style="background:#0a0f18;border:1px solid #1a2a3a;border-radius:8px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
        <div style="font-family:monospace;font-size:11px;color:#4a5f72;letter-spacing:1px;">TOTAL BRIEFINGS ALL TIME</div>
        <div style="font-family:monospace;font-size:22px;font-weight:700;color:#cdd9e5;">${totalBriefings}</div>
      </div>
    </div>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="https://notamai.onrender.com" style="display:inline-block;padding:12px 28px;background:transparent;border:1px solid rgba(74,158,255,0.4);color:#8a9bb0;font-family:monospace;font-size:12px;letter-spacing:2px;text-decoration:none;border-radius:6px;">START A NEW BRIEFING</a>
    </div>
    <div style="border-top:1px solid #1a2a3a;padding-top:16px;text-align:center;">
      <p style="font-family:monospace;font-size:10px;color:#4a5f72;margin:0;">You're receiving this because weekly summaries are enabled.</p>
      <p style="font-family:monospace;font-size:10px;color:#4a5f72;margin:4px 0 0;">Manage preferences in Settings → Notifications.</p>
    </div>
  </div>
</body>
</html>`
        })
      });
      if (wkRes.ok) { weeklySent++; console.log('[WEEKLY] Sent summary to:', userEmail); }
      else { weeklyFailed++; console.log('[WEEKLY] Send failed for', userEmail, 'HTTP', wkRes.status); }
      await new Promise(r => setTimeout(r, 600));   // stay under the e-mail provider's per-second limit
    }
    console.log('[WEEKLY] Done. Sent:', weeklySent, 'Failed:', weeklyFailed);
    if (weeklyFailed > 0) await sendAdminNotification('⚠️ Weekly summaries: ' + weeklyFailed + ' failed', `<div style="font-size:13px;color:#1e293b;">Sent ${weeklySent}, failed ${weeklyFailed}. See Render logs for [WEEKLY].</div>`);
  } catch(e) {
    console.log('[WEEKLY] Error:', e.message);
  }
}

// ─── LIFECYCLE / WATCH AGENTS (v3.66) ───────────────────────────────────────
// User-facing e-mails (onboarding nudge, win-back, upgrade nudge) are OFF by default:
// set Render env LIFECYCLE_EMAILS=on to enable. While off, the admin only gets a digest of who WOULD be mailed.
const LIFECYCLE_EMAILS_ON = () => String(process.env.LIFECYCLE_EMAILS || '').toLowerCase() === 'on';
const VALID_PLANS = ['free', 'pro', 'max', 'enterprise', 'admin'];

function runDaily(hourUTC, minuteUTC, fn, label) {
  function schedule() {
    const now = new Date(), next = new Date(now);
    next.setUTCHours(hourUTC, minuteUTC, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    setTimeout(() => {
      Promise.resolve().then(fn).catch(e => console.log('[' + label + ' ERROR]', e.message));
      schedule();   // recompute from the clock every time — no drift
    }, next - now);
  }
  schedule();
}
function runWeekly(dayUTC, hourUTC, minuteUTC, fn, label) {
  runDaily(hourUTC, minuteUTC, () => { if (new Date().getUTCDay() === dayUTC) return fn(); }, label);
}

async function sendUserMail(to, subject, bodyHtml) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'NOTAM Intelligence <alerts@notamai.com>', to, subject,
      html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0f4f8;font-family:Helvetica,Arial,sans-serif;">
<div style="max-width:520px;margin:0 auto;padding:28px 20px;color:#1e293b;font-size:14px;line-height:1.55;">
  <div style="font-size:14px;font-weight:700;letter-spacing:3px;margin-bottom:18px;">NOTAM <span style="color:#4a9eff;">INTELLIGENCE</span></div>
  ${bodyHtml}
  <p style="margin-top:24px;"><a href="https://notamai.onrender.com" style="display:inline-block;padding:10px 22px;background:#4a9eff;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;font-size:12px;letter-spacing:1px;">OPEN NOTAM INTELLIGENCE</a></p>
  <p style="font-size:11px;color:#64748b;margin-top:22px;">You get this because you have an account. Reply to this e-mail if you would rather not receive such messages.</p>
</div></body></html>`
    })
  });
  return r.ok;
}

// ── 1. Provider sentinel: balances / failures, every 30 min, alert at most once per 12 h per issue ──
const sentinelLast = new Map();
async function checkProviderCredits(results, issues) {
  try {
    const r = await fetch('https://api.wavespeed.ai/api/v3/balance', { headers:{'Authorization':'Bearer '+process.env.WAVESPEED_KEY} });
    const j = r.ok ? await r.json().catch(()=>null) : null;
    const bal = j && j.data && typeof j.data.balance === 'number' ? j.data.balance : null;
    if (bal === null) { results.wavespeed_credit = '— balance not readable'; }
    else {
      const min = parseFloat(process.env.WAVESPEED_MIN_BALANCE || '5');
      results.wavespeed_credit = bal < min ? `🔴 $${bal.toFixed(2)} LOW` : `✅ $${bal.toFixed(2)}`;
      if (bal < min) issues.push({ key:'wavespeed_credit', msg:`WaveSpeed credit low: $${bal.toFixed(2)}`, action:'Top up at wavespeed.ai — video briefings stop working when the balance reaches zero.' });
    }
  } catch(e) { results.wavespeed_credit = '— ' + e.message; }
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers:{'xi-api-key':process.env.ELEVENLABS_KEY||''} });
    const j = r.ok ? await r.json().catch(()=>null) : null;
    if (!j || !j.character_limit) { results.elevenlabs_quota = '— quota not readable'; }
    else {
      const left = j.character_limit - j.character_count;
      const low = left < j.character_limit * 0.1;
      results.elevenlabs_quota = `${low ? '🔴' : '✅'} ${left.toLocaleString()} chars left (${Math.round(left / j.character_limit * 100)}%)`;
      if (low) issues.push({ key:'elevenlabs_quota', msg:`ElevenLabs quota low: ${left.toLocaleString()} characters left`, action:'Upgrade the ElevenLabs plan or wait for the monthly reset — video narration fails at zero.' });
    }
  } catch(e) { results.elevenlabs_quota = '— ' + e.message; }
}

async function runSentinel() {
  const results = {}, issues = [];
  await checkProviderCredits(results, issues);
  try {
    const sd = await adminDb.collection('system').doc('skylink_usage').get();
    const pct = sd.exists ? (sd.data().pct || 0) : 0;
    if (pct >= 90) issues.push({ key:'skylink_pct', msg:`SkyLink usage at ${pct}%`, action:'Upgrade the RapidAPI SkyLink plan now.' });
  } catch (e) {}
  try {
    const since = new Date(Date.now() - 2 * 3600 * 1000);
    const f = await adminDb.collection('videos').where('status', '==', 'failed').where('failedAt', '>=', since).get();
    if (f.size >= 3) issues.push({ key:'video_failures', msg:`${f.size} video briefings failed in the last 2 hours`, action:'Check Render logs for [VIDEO] errors and the WaveSpeed / ElevenLabs dashboards.' });
  } catch (e) { /* index missing → skip silently */ }
  for (const i of issues) {
    const last = sentinelLast.get(i.key) || 0;
    if (Date.now() - last < 12 * 3600 * 1000) continue;
    sentinelLast.set(i.key, Date.now());
    await sendAdminNotification('🚨 ' + i.msg, `<div style="font-size:13px;color:#b91c1c;margin-bottom:6px;">${escHtml(i.msg)}</div><div style="font-size:12px;color:#475569;">→ ${escHtml(i.action)}</div>`);
  }
  console.log('[SENTINEL] Checked. Issues:', issues.length);
}
setInterval(() => runSentinel().catch(e => console.log('[SENTINEL ERROR]', e.message)), 30 * 60 * 1000);
setTimeout(() => runSentinel().catch(e => console.log('[SENTINEL ERROR]', e.message)), 90 * 1000);

// ── 2–4. Lifecycle agent (onboarding nudge, win-back, upgrade nudge) — daily 10:00 UTC ──
async function runLifecycleAgent() {
  console.log('[LIFECYCLE] Running...');
  const usersSnap = await adminDb.collection('users').get();
  const now = Date.now(), DAY = 86400000;
  const monthKey = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const live = LIFECYCLE_EMAILS_ON();
  const report = { onboarding: [], winback: [], upsell: [] };

  async function once(key) {            // returns true the first time, false if this mail was already handled
    const ref = adminDb.collection('agentLog').doc(key);
    if ((await ref.get()).exists) return false;
    await ref.set({ at: admin.firestore.FieldValue.serverTimestamp(), sent: live });
    return true;
  }

  for (const doc of usersSnap.docs.slice(0, 1000)) {
    const uid = doc.id, u = doc.data();
    const plan = VALID_PLANS.includes(u.plan) ? u.plan : 'free';
    if (plan === 'admin') continue;
    if ((u.notifications || {}).lifecycle === false) continue;
    let rec;
    try { rec = await admin.auth().getUser(uid); } catch (e) { continue; }
    if (!rec.email || (rec.providerData.some(p => p.providerId === 'password') && !rec.emailVerified)) continue;
    if (ADMIN_MAIL_SET.has(rec.email)) continue;
    const createdMs = new Date(rec.metadata.creationTime).getTime();
    const name = escHtml((u.displayName || rec.email.split('@')[0]));

    // 2. Onboarding: registered 2–10 days ago, never produced a briefing
    if (now - createdMs > 2 * DAY && now - createdMs < 10 * DAY) {
      const any = await adminDb.collection('briefings').where('userId', '==', uid).limit(1).get();
      if (any.empty && await once('onboarding_' + uid)) {
        report.onboarding.push(rec.email);
        if (live) await sendUserMail(rec.email, 'Your first briefing takes about a minute',
          `<p>Hi ${name},</p><p>You created your NOTAM Intelligence account but have not run a briefing yet. Enter a departure and arrival airport and you get an AI briefing with a plain-language risk rating, based on live NOTAMs and weather.</p><p>Try a route you fly regularly — it is the quickest way to see what it does for you.</p>`);
      }
    }

    // 3. Win-back: paid plan, no briefing for 14+ days
    if (plan === 'pro' || plan === 'max' || plan === 'enterprise') {
      const last = await adminDb.collection('briefings').where('userId', '==', uid).orderBy('createdAt', 'desc').limit(1).get().catch(() => null);
      const lastMs = last && !last.empty && last.docs[0].data().createdAt && last.docs[0].data().createdAt.toDate ? last.docs[0].data().createdAt.toDate().getTime() : null;
      if (lastMs && now - lastMs > 14 * DAY && now - lastMs < 60 * DAY && await once('winback_' + uid + '_' + monthKey)) {
        report.winback.push(rec.email + ' (' + plan + ', last briefing ' + Math.round((now - lastMs) / DAY) + ' d ago)');
        if (live) await sendUserMail(rec.email, 'Anything we can do better?',
          `<p>Hi ${name},</p><p>We noticed you have not run a briefing for a couple of weeks. If something did not work the way you expected, just reply to this e-mail — it goes straight to us.</p>`);
      }
    }

    // 4. Upsell: Free at the monthly limit, Pro at 80 %
    if (plan === 'free' || plan === 'pro') {
      const us = await adminDb.collection('usage').doc(uid + '_' + monthKey).get();
      const used = us.exists ? (us.data().briefings || 0) : 0;
      const limit = PLAN_LIMITS[plan].briefings;
      const hit = plan === 'free' ? used >= limit : used >= Math.floor(limit * 0.8);
      if (hit && await once('upsell_' + uid + '_' + monthKey)) {
        report.upsell.push(`${rec.email} (${plan} ${used}/${limit})`);
        if (live) await sendUserMail(rec.email, plan === 'free' ? 'You have used your free briefings' : 'You are close to your monthly briefing limit',
          plan === 'free'
            ? `<p>Hi ${name},</p><p>You have used your ${limit} free briefings this month. Pro gives you 100 briefings a month, en-route FIR analysis, Ask NOTAM AI, archive and NOTAM alerts, with a 7-day free trial.</p>`
            : `<p>Hi ${name},</p><p>You have used ${used} of your ${limit} monthly briefings. Max raises this to 150 and adds AI video briefings and faster NOTAM alerts, with a 7-day free trial.</p>`);
      }
    }
  }

  const total = report.onboarding.length + report.winback.length + report.upsell.length;
  console.log('[LIFECYCLE] Done. Candidates:', total, '| live mails:', live);
  if (total > 0) {
    const sec = (t, a) => a.length ? `<div style="margin-bottom:12px;"><div style="font-size:11px;color:#64748b;letter-spacing:2px;margin-bottom:4px;">${t}</div>${a.map(x => `<div style="font-size:12px;color:#1e293b;">${escHtml(x)}</div>`).join('')}</div>` : '';
    await sendAdminNotification(`${live ? '📨' : '👀'} Lifecycle agent — ${total} user(s)`,
      `<div style="font-size:12px;color:#475569;margin-bottom:10px;">${live ? 'These users were e-mailed.' : 'E-mails are OFF (set LIFECYCLE_EMAILS=on on Render). These users WOULD be e-mailed.'}</div>`
      + sec('ONBOARDING NUDGE', report.onboarding) + sec('WIN-BACK', report.winback) + sec('UPGRADE NUDGE', report.upsell));
  }
}
const ADMIN_MAIL_SET = new Set(['arslanni@gmail.com', 'admin@notamai.com']);
runDaily(10, 0, runLifecycleAgent, 'LIFECYCLE');

// ── 5. Feedback digest — Mondays 09:30 UTC ──
async function runFeedbackDigest() {
  const since = new Date(Date.now() - 7 * 86400000);
  const rf = await adminDb.collection('ratingFeedback').where('createdAt', '>=', since).get();
  const votes = {}; const lowRoutes = [];
  rf.docs.forEach(d => { const x = d.data(); votes[x.vote] = (votes[x.vote] || 0) + 1; if (x.vote !== 'about_right' && x.route) lowRoutes.push(`${x.route} (${x.vote}, ${x.level || '?'} ${x.score ?? ''})`); });
  const bs = await adminDb.collection('briefings').where('createdAt', '>=', since).get();
  let up = 0, down = 0; const downRoutes = [];
  bs.docs.forEach(d => { const x = d.data(); if (x.liked === true) up++; else if (x.liked === false) { down++; if (x.route) downRoutes.push(x.route); } });
  if (rf.size + up + down === 0) { console.log('[FEEDBACK] Nothing this week'); return; }
  await sendAdminNotification('📝 Weekly feedback digest',
    `<div style="font-size:13px;color:#1e293b;margin-bottom:8px;"><strong>Briefings:</strong> ${bs.size} · 👍 ${up} · 👎 ${down}</div>
     <div style="font-size:13px;color:#1e293b;margin-bottom:8px;"><strong>Risk-rating votes:</strong> ${escHtml(JSON.stringify(votes))}</div>
     ${downRoutes.length ? `<div style="font-size:12px;color:#475569;margin-bottom:6px;"><strong>👎 routes:</strong> ${escHtml(downRoutes.slice(0, 15).join(', '))}</div>` : ''}
     ${lowRoutes.length ? `<div style="font-size:12px;color:#475569;"><strong>Rating disputed:</strong> ${escHtml(lowRoutes.slice(0, 15).join('; '))}</div>` : ''}`);
}
runWeekly(1, 9, 30, runFeedbackDigest, 'FEEDBACK');

// ── 6. Conflict-zone source watcher — Mondays 07:00 UTC; tells you when the EASA CZIB page changed ──
async function runConflictWatch() {
  const url = 'https://www.easa.europa.eu/en/domains/air-operations/czibs';
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NOTAM Intelligence conflict watch)' } });
  if (!r.ok) throw new Error('EASA page HTTP ' + r.status);
  const html = await r.text();
  const ids = [...new Set((html.match(/CZIB-\d{4}-\d{2}(?:-R\d+)?/g) || []))].sort();
  if (!ids.length) throw new Error('no CZIB identifiers found — page layout may have changed');
  const sig = require('crypto').createHash('sha1').update(ids.join('|')).digest('hex');
  const ref = adminDb.collection('system').doc('conflict_watch');
  const prev = await ref.get();
  await ref.set({ sig, ids, checkedAt: admin.firestore.FieldValue.serverTimestamp() });
  if (!prev.exists) { console.log('[CONFLICT WATCH] Baseline stored:', ids.length, 'CZIBs'); return; }
  const old = new Set(prev.data().ids || []);
  const added = ids.filter(x => !old.has(x));
  if (prev.data().sig !== sig && added.length) {
    await sendAdminNotification('🌍 EASA CZIB list changed',
      `<div style="font-size:13px;color:#1e293b;margin-bottom:6px;">New or revised bulletins: <strong>${escHtml(added.join(', '))}</strong></div>
       <div style="font-size:12px;color:#475569;">Review them against the conflict-zone list in risk.js (conflictZonesAsOf), then update the list.<br><a href="${url}">${url}</a></div>`);
  }
  console.log('[CONFLICT WATCH] Checked. New:', added.length);
}
runWeekly(1, 7, 0, () => runConflictWatch().catch(async e => { console.log('[CONFLICT WATCH ERROR]', e.message); await sendAdminNotification('⚠️ Conflict watch failed', `<div style="font-size:13px;color:#b91c1c;">${escHtml(e.message)}</div>`); }), 'CONFLICT WATCH');
