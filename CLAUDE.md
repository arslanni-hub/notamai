# NOTAM Intelligence — Claude Code Project Context

## Project Overview
NOTAM Intelligence (notamai.com) is a global AI-powered pre-flight briefing platform for pilots and flight dispatchers. It aggregates live NOTAM, METAR, and TAF data and uses Claude AI to generate professional operational briefings.

## Tech Stack
- **Frontend:** Single-page HTML/CSS/JS (index.html) — NO framework, pure vanilla JS
- **Backend:** Node.js (server.js) on Render.com
- **Database:** Firebase Firestore (europe-west1) — briefing archive, user data, alerts, videos
- **Auth:** Firebase Authentication (Google + Email/Password)
- **AI:** Anthropic Claude API — Sonnet for main briefings and video scripts, Haiku for chat/analysis/extract
- **NOTAM Data:** SkyLink API (RapidAPI) — env var: SKYLINK_KEY
- **Weather Data:** aviationweather.gov (free, no key needed)
- **Video:** WaveSpeed AI (infinitetalk-fast model) + ElevenLabs TTS — LIVE, implemented
- **Payments:** Stripe (test mode until the company is set up; live payments pending) — LemonSqueezy was replaced
- **Deploy:** Render.com — auto-deploys from GitHub main branch

## Repository
- GitHub: arslanni-hub/notamai
- Files: index.html, server.js, package.json, about.html, how-it-works.html, pricing.html, pricing-upgrade.html, privacy.html, terms.html

## Environment Variables (Render)
- ANTHROPIC_KEY — Claude API key
- SKYLINK_KEY — SkyLink RapidAPI key
- WAVESPEED_KEY — WaveSpeed AI key
- ELEVENLABS_KEY — ElevenLabs TTS key
- STRIPE_SECRET_KEY, STRIPE_PRICE_PRO_MONTHLY/YEARLY, STRIPE_PRICE_MAX_MONTHLY/YEARLY (+ webhook secret); SKYLINK_MONTHLY_LIMIT, ALERT_AIRPORT_BUDGET
- FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

## Claude Models in Use (current, verified in code)
- Main briefing generation: admin always `claude-sonnet-5-5`; other plans use Render env `BRIEFING_MODEL` (code default `claude-sonnet-4-6`) — check the env value
- Ask NOTAM AI chat (briefing-specific): `claude-haiku-4-5-20251001`
- ✨ Single NOTAM/METAR/TAF analysis: `claude-haiku-4-5-20251001`
- Route extraction (natural language → ICAO): `claude-haiku-4-5-20251001`
- Video briefing script generation: `claude-sonnet-5-5` (Render env `VIDEO_SCRIPT_MODEL` overrides; automatic fallback to `claude-haiku-4-5` if the call fails) — fed with the written briefing's risk summary (video-script.js)
- Prompt caching: enabled on all chat/analysis endpoints (anthropic-beta: prompt-caching-2024-07-31)
- ⚠️ Do not assume a chat-type feature should default to Haiku — model choice per plan/feature is a deliberate decision, confirm before changing.

## Architecture
```
User → index.html (SPA)
→ POST /briefing → SkyLink (NOTAMs) + aviationweather.gov (METAR/TAF) + getEnrouteNotams() → Claude Sonnet (streaming SSE) → Firestore save
→ POST /api/chat → Claude Haiku (Ask NOTAM AI — briefing-specific conversation)
→ POST /api/analyze-notam → Claude Haiku (single NOTAM/METAR/TAF analysis)
→ POST /api/extract-route → Claude Haiku (natural language → ICAO codes)
→ POST /api/generate-video-briefing → Claude Sonnet 5.5 (script, with the briefing's risk summary) → ElevenLabs (TTS) → WaveSpeed infinitetalk-fast (video) → Firestore videos collection
→ GET /api/check-video-briefing/:id → polls WaveSpeed prediction status
→ GET /api/raw/notam/:icao → SkyLink proxy
→ GET /api/raw/metar/:icao → aviationweather.gov proxy
→ GET /api/raw/taf/:icao → aviationweather.gov proxy
→ POST /api/create-checkout → Stripe Checkout session creation
→ POST /api/stripe-webhook → signature-verified plan updates (→ Firestore users.plan)
→ GET /b/:id → Shared briefing page (Firestore fetch)
→ GET /pricing-upgrade → Upgrade page
```

## Key Functions (index.html)
- `handleSend()` — main briefing trigger
- `loadBriefingHistory()` — loads Firestore archive on login
- `saveBriefingToFirestore()` — saves completed briefing
- `openRawDataPanel()` / `fetchRawData()` — NOTAMs & MET panel
- `openAIChat()` / `sendAIChat()` — Ask NOTAM AI chatbot (briefing-specific, stable, do not modify without explicit instruction)
- `openArchivePanel()` — briefing archive
- `openVideoBriefing()` / `generateVideoBriefing()` / `pollVideoStatus()` — AI Video Briefing flow
- `initiateCheckout(plan)` — LemonSqueezy checkout redirect
- `getEnrouteNotams()` — fetches FIR NOTAMs for route (server.js)
- `isShortDomesticRoute()` / `isFirBetweenRoute()` — geographic corridor filters for FIRs

## Design System
- Dark aviation/cockpit theme — background: #060a0f
- Fonts: Orbitron (headings), Rajdhani (body), Share Tech Mono (data/mono)
- Primary blue: #4a9eff — this is the project's accent color for new UI; do not introduce new accent colors (e.g. purple) without explicit instruction
- Status colors only: red #e63946 (critical/error), orange #f4841a (warning), yellow #f2c641 (caution), green #2ec4b6 (success/safe), purple #b57bff (reserved for specific existing UI elements — NOT a general-purpose accent)
- All styling: inline CSS only — NO external CSS frameworks
- Sidebar: 260px open / 52px collapsed
- Sidebar panels: slide-in from right, 320-380px wide — this applies to sidebar-launched panels (NOTAMs & MET, Saved Routes, Archive, Alerts, Settings, Ask NOTAM AI). It does NOT mean every new chat/panel feature must slide in from the right — confirm placement per feature, some are designed to occupy the main input area in place instead.
- Briefing result overlay: full-screen, sidebar-aware positioning via body.sidebar-open class

## Pricing Plans — FINAL, do not alter without explicit instruction
Credit-based system was discussed and explicitly abandoned (June 2026). Current model is simple per-feature limits:

| Feature | Free | Pro $49 | Max $99 |
|---|---|---|---|
| AI Briefing | 3/month | Unlimited* | Unlimited* |
| En-route FIR | ❌ | ✅ | ✅ |
| Ask NOTAM AI (briefing-specific chat) | ❌ | ✅ | ✅ |
| ✨ Single NOTAM/METAR/TAF AI analysis | ❌ | ✅ | ✅ |
| AI Video Briefing | ❌ | ❌ | 5/month hard limit, +$10 = 3 more |
| NOTAMs & MET raw data | ✅ | ✅ | ✅ |
| Archive | ❌ | ✅ (no limit enforced in code) | Unlimited* |
| Saved Routes | ❌ | 3 (enforced client-side) | up to 20 (localStorage cap) |
| NOTAM Alerts | ❌ | 3 airports, checked ~every 60 min | 5 airports, ~every 30 min (Enterprise: 10) |
| Share + PDF export | ❌ | ✅ | ✅ |
| Priority support | ❌ | ❌ | ✅ |

*"Unlimited" items are marketing labels backed by soft caps: briefings 100/150 per month (PLAN_LIMITS, warning at 80%, limit modal at 100%), Free-plan global cap 20/day; fair use clause in terms.html §8 (incl. Capacity Limits paragraph). Alerts are the one cost-bearing feature shown with explicit numbers (Pro 3 airports/60 min, Max 5/30 min) — keep ALERT_CAPS, index.html alert banners, pricing pages and support text in sync.

In code: `PLAN_LIMITS` in server.js currently uses `{briefings, chat, analysis}` numeric caps (free: 3/0/0, pro: 100/150/200, max: 150/400/300) as the enforcement mechanism for the table above — these numbers implement the table, they are not a separate source of truth. Don't change PLAN_LIMITS values without first confirming against this table.

## General Aviation Expert Chat — LIVE
Separate from "Ask NOTAM AI" (which stays briefing-specific, never touched by this feature). Built and shipped June 2026.
- Reached via 3 mode-selector pills below the main input (Briefing/Video/Chat) — explicit user selection, no auto-detection.
- Accent color: blue (#4a9eff), matching existing design. No new colors.
- Token-budget rate limiting over a 5-hour rolling window (GENERAL_CHAT_LIMITS in server.js): Free (Haiku, 470 tokens, hard stop), Pro (Sonnet, 12000 tokens, soft-downgrades to Haiku at 70%), Max (Sonnet, 24000 tokens, soft-downgrades at 70%). Hard stop at 100% for all plans.
- Web search (web_search_20250305, max_uses: 3) enabled for Pro/Max only — see GENERAL_CHAT_WEB_SEARCH_PLANS/GENERAL_CHAT_WEB_SEARCH_TOOL. Steered via system prompt to search only for genuinely current info, never as a substitute for the live NOTAM/MET scope boundary. Search-request counts are logged and stored (general_chat_rate_limit.searchCount) for cost visibility but not yet used for gating.
- System prompt redirects (not fabricates) when a question needs a paid platform feature — see the SCOPE BOUNDARY block in server.js for the exact panel markers.
- Persistence: general_chats Firestore collection (Pro/Max only), sidebar/Archive integration, sharing via /c/:id — all live.

## Coding Rules
- ALWAYS push to GitHub after changes
- NEVER use position:fixed inside panels (breaks layout)
- NEVER use external CSS frameworks
- NEVER introduce new accent colors, layout patterns (e.g. slide-in vs in-place), or architectural decisions not explicitly requested — ask if unsure rather than defaulting to a "reasonable" choice
- All new features must work with sidebar open/closed states
- Test with both logged-in and logged-out states
- Console logs: keep CACHE and FILTER logs, remove debug logs before production

## Known Issues / TODO
- Free/Pro/Max content restrictions: implemented for briefings/chat/analysis caps; video hard limit (5/mo) enforcement should be double-checked
- AI Video Briefing: working end-to-end (Sonnet 5.5 script → ElevenLabs TTS → WaveSpeed infinitetalk-fast). v3.48: script follows the briefing's risk rating (elevated ratings are stated plainly, closing line replaced), greeting uses the browser's local hour, script is spoken at ElevenLabs speed 1.1 (env VIDEO_TTS_SPEED, 0.9-1.2, 1 = old pace); hard-capped at 82 words (prompt target 66-74) in code (fitScript; target ~34 s ≈ 3 min of WaveSpeed time; opening line has the full airport names, later sentences use the city; both airports and a one-line weather statement are always included; the country of a prohibited zone is always named, taken from the risk data). WaveSpeed render time is the bottleneck and varies a lot (measured 3.8x-7.6x video length, inference only; logged as [VIDEO TIMING]); spoken length drives both time and cost (about $0.015 per video second, ~2.1 words/s); client waits up to 15 min; [VIDEO TIMING] logs stage times and WaveSpeed render time; the server finishes every video itself (finalizeVideo / watchVideo / resumeUnfinishedVideos: completes or refunds exactly once, archives to Firebase Storage in the background) so a video reaches the archive even if the page was closed while it rendered; the page's own polling just calls the same finalizeVideo; the finished video shows a "NOTAM INTELLIGENCE" label as a page layer (#vbBrand, same look as the welcome video modal) — NOT burned into the file (a burned-in strip was tried in v3.60: cropped by the player and blurry at 480p, removed); airport names in the script come from the same SkyLink lookup as the briefing (fetchAndCacheAirportName, cached) and are passed as VERIFIED AIRPORT NAMES, the model must never guess a place from an ICAO code; `videos` document ids are `0-<inverted ms>_<YYYYMMDDHHMM>_<DEP-ARR>` so the Firestore console lists the newest first (all code queries by field, never by id), video NOTAMs go through the same in-force/admin filter as the written briefing (fetchNotams) and AIRAC/AIP text is dropped, video mode has no written briefing, so when the page sends no rating the server rates the route itself (computeBriefingRisk: aerodromes + conflict-zone check, no en-route fetch; marked partial; the spoken NOTAMs are then only those the rubric rates Tier 1/2 per aerodrome), WaveSpeed/ElevenLabs start failures e-mail the admin (notifyVideoProviderFailure, max once per 6 h per provider), a failed video (at start or while rendering) restores the Max credit once, and the unused /api/test-video-script endpoint was removed
- General Aviation Expert Chat: live. Citation links and a dedicated "searching the web..." UI indicator are not yet built (deferred, not forgotten).
- Admin panel: Free-tier conversion tracking/funnel metrics planned, not yet built
- NOTAM Alerts email notifications: UI ready, needs Resend.com integration
- SkyLink plan usage should be monitored — was previously flagged near/over free-tier limits

## Maintenance Note
**This file must be kept up to date.** Update it whenever a change has real architectural or decision-level impact: new feature shipped, payment/model/integration swapped, pricing or plan limits changed. Don't bother updating for small fixes or cosmetic tweaks. If this file conflicts with what the user describes in conversation, the user's current instruction wins — but flag the discrepancy so the file can be corrected.

## Agents (audited v3.65)
- Support/Sales/Growth/Health/Notification/Weekly agents live in server.js (~5300–6420). Customer mail and model output are untrusted: always pass through `escHtml()`; use `aiText(data)` instead of `data.content[0].text`.
- Support/Sales failures forward the raw mail to the admin (`sendAdminNotification`) – the mail is already marked read on IMAP, never drop it.
- Real-time watcher: single `users` snapshot listener; first snapshot is a baseline; upgrade/downgrade only when `plan` really changes; new-user time from `createdAt` or Auth creation time.
- Support prompt plan text must follow PLAN_LIMITS (Pro 100, Max 150 briefings/month).
- Health report: MRR includes Enterprise ($999); WaveSpeed balance (`WAVESPEED_MIN_BALANCE`, default 5) and ElevenLabs quota are best-effort checks.
