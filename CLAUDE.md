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
| NOTAM Alerts | ❌ | 3 airports, checked ~every 60 min | 5 airports, ~every 30 min (Enterprise: 5 until the pooled team plan, v3.89) |
| Share + PDF export | ❌ | ✅ | ✅ |
| Priority support | ❌ | ❌ | ✅ |

*"Unlimited" items are marketing labels backed by soft caps: briefings 100/150 per month (PLAN_LIMITS, warning at 80%, limit modal at 100%), Free-plan global cap 20/day; fair use clause in terms.html §8 (incl. Capacity Limits paragraph). Alerts are the one cost-bearing feature shown with explicit numbers (Pro 3 airports/60 min, Max 5/30 min) — keep ALERT_CAPS, index.html alert banners, pricing pages and support text in sync.

In code: `PLAN_LIMITS` in server.js currently uses `{briefings, chat, analysis}` numeric caps (free: 3/0/0, pro: 100/150/200, max: 150/400/300) as the enforcement mechanism for the table above — these numbers implement the table, they are not a separate source of truth. Don't change PLAN_LIMITS values without first confirming against this table.

## General Aviation Expert Chat — LIVE
Separate from "Ask NOTAM AI" (which stays briefing-specific, never touched by this feature). Built and shipped June 2026.
- Reached via 3 mode-selector pills below the main input (Briefing/Video/Chat) — explicit user selection, no auto-detection.
- Accent color: blue (#4a9eff), matching existing design. No new colors.
- Token-budget rate limiting over a 5-hour rolling window (GENERAL_CHAT_LIMITS in server.js): Free (Haiku 5.5, 1000 tokens per 5 h window since v3.74, about 3-4 short questions, hard stop; no web search), Pro (Sonnet 5.5, 24000 tokens, soft-downgrades to Haiku at 70%), Max (Sonnet 5.5, 48000 tokens, soft-downgrades at 70%) — values as in code (this line said 12000/24000 until v3.82). Hard stop at 100% for all plans. Since v3.82 also a rolling 7-day cap (GENERAL_CHAT_WEEKLY: Pro 150k tokens / 20 searches, Max 300k / 40).
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
- v3.66: Sentinel (30 min: WaveSpeed/ElevenLabs credit, SkyLink %, failed videos), Lifecycle agent (daily 10:00 UTC: onboarding nudge, win-back, upgrade nudge; user mails only when Render env `LIFECYCLE_EMAILS=on`, dedupe in Firestore `agentLog`), weekly feedback digest (Mon 09:30), EASA CZIB watcher (Mon 07:00, state in `system/conflict_watch`). Legacy plan values (e.g. `premium`) are treated as `free`.
- v3.67: `limitPlanOf(plan)` maps enterprise → max for every plan-limit lookup (briefings, analysis, chat, general chat, video, web search) — Enterprise previously fell through to Free defaults. Legacy unauthenticated test endpoints (HeyGen/Veed/FlashHead/SkyReels/Kling/join-videos/upload-audio/test-alert) were removed; do not re-add unauthenticated endpoints that spend provider credit.
- v3.68: briefing model per plan via Render env `BRIEFING_MODEL_FREE/_PRO/_MAX/_ADMIN` (enterprise uses _MAX; `BRIEFING_MODEL` stays the non-admin fallback; code defaults unchanged). `HAIKU_MODEL` env (default `claude-haiku-4-5`) switches every small-model call (chat, analysis, route extraction, agents, general-chat fallback) at once. Every briefing logs `[BRIEFING COST]` and writes a `briefingCosts` Firestore record (model, tokens, USD from MODEL_PRICES). Sonnet 5.5 and Haiku 5.5 share BRIEFING_DEPTH_RULES_55 and the 24k output ceiling; Haiku 5.5 verified (v3.70): accepts `thinking:{type:'disabled'}` (env BRIEFING_HAIKU_THINKING=disabled, required or thinking eats the 24k output budget) and `output_config.effort`, REJECTS `between_tools`; Sonnet 5.5 is the opposite (`between_tools` only).
- v3.71 (decided 21 Oct 2026): briefing model per plan = Free and Pro `claude-haiku-5-5` (Render env BRIEFING_MODEL_FREE/_PRO, ~$0.0075 AI per briefing vs ~$0.16 on Sonnet 5.5); Max = Sonnet 5.5 for the first `MAX_SONNET_BRIEFINGS` (default 40, derived from the <=10% worst-case cost target at 150 briefings) briefings per month, then `MAX_FALLBACK_MODEL` (default Haiku 5.5); Enterprise and admin never downgrade. Free no longer fetches en-route FIR NOTAMs (pricing table: Free = no En-route FIR; the briefing says FIR NOTAMs were not retrieved). Free global daily cap default 60/day (`FREE_DAILY_BRIEFING_CAP`), admin mail at 80% and at 100%, turned-away count (`denied` in `system/free_briefings_<day>`) shown in the daily health report. SkyLink calls (~$0.003 each, ~5 per full briefing) now cost more than the AI call on Haiku; watch SKYLINK_MONTHLY_LIMIT.
- v3.72 (21 Oct 2026): decided to move every small-model call (chat, analysis, route extraction, agents, general-chat fallback) to Haiku 5.5 via Render env `HAIKU_MODEL=claude-haiku-5-5`; all Haiku 5.x requests carry `thinking:{type:'disabled'}` (HAIKU_EXTRA / callAI) because up-front thinking would eat small max_tokens budgets. Free briefings show a fixed yellow note that the rating excludes en-route FIR NOTAMs.
- v3.74 (21 Oct 2026): Free expert chat budget 470 -> 1000 tokens per 5 h window (input+output tokens only, cache tokens are not counted; the check runs before each request, so the last question may overshoot). Chat prompt: web-search/ICAO instructions only when web search is enabled for the plan; general facts and statistics (e.g. number of airports in a country) are answered from knowledge with a caveat and never redirected to a panel.
- v3.75 (21 Oct 2026): `/api/raw/notam/:icao` (NOTAMs & MET panel) now requires a signed-in, e-mail-verified user and has a per-user daily cap (Render env `RAW_NOTAM_DAILY_FREE` default 10, `RAW_NOTAM_DAILY_PAID` default 100, admin unlimited; counter in Firestore `rawNotamDaily/<uid>_<day>`, fails open on Firestore errors). METAR/TAF/SIGMET raw endpoints stay open (free aviationweather.gov). index.html sends the Firebase ID token on both raw NOTAM fetches. The other SkyLink-backed tool endpoints (airport-search, navaids, charts, delays, distance, flight-time, flight-status, carbon, aircraft, routes, airsigmet) are still unauthenticated.
- v3.76 (21 Oct 2026): SkyLink-backed Aviation Tools endpoints (airport-info, airport-search, raw/delays, raw/charts, distance, navaids, ml-flighttime, flight-status, carbon, aircraft, aircraft-performance, routes, airsigmet; list = SKYLINK_TOOL_PREFIXES) require a signed-in, e-mail-verified user and pass `skylinkToolGate`: per-user daily cap (Render env `TOOLS_DAILY_FREE` 60, `TOOLS_DAILY_PAID` 400, admin exempt; Firestore `toolUsageDaily`) plus one global daily request cap `TOOLS_DAILY_GLOBAL` (3000; Firestore `system/tools_<day>` with `denied` count, shown in the daily health report). index.html wraps `window.fetch` so every same-origin /api/ call carries the Firebase ID token and tool 401/429/503 replies show the login modal or a toast. The SkyLink gateway (fetchURL) already caches NOTAM responses 5 min and static reference data 12 h, shared across users. Free upstream endpoints (METAR/TAF/SIGMET/PIREP/airmet/winds/airport) stay open.
- v3.77 (21 Oct 2026): `alternates.js` (OurAirports airports+runways, refreshed daily) computes CANDIDATE ALTERNATES (4 destination + 2 take-off, runway >= 6562 ft, <= 350 NM, LTBA excluded) that are injected into the route prompt; briefing rule 4 must take alternates from that list (code, name, distance) and never invent "a nearby alternate"; weather/NOTAMs of candidates are not checked by the server. New `GET /api/admin/briefing-costs` (admin token) sums this month's `briefingCosts`; admin.html uses measured USD plus $0.09 only for briefings without a cost record. Archive and saved routes are client-side (negligible cost, Free block is UI-only; hard enforcement would need Firestore rules); alerts are server-capped by ALERT_CAPS.
- v3.78 (23 Oct 2026): `/api/airport-search/` (Aviation Tools search box) is served from an in-memory OurAirports index (alternates.js `searchAirports`; ~72k open aerodromes incl. heliports, accent/Turkish-i insensitive; ranking: exact ICAO/IATA > ICAO prefix > IATA prefix > name/city word start > substring, large > medium > small > heliport, scheduled first). No SkyLink call and not counted against TOOLS_DAILY_* (every keystroke is a request); sign-in still required. SkyLink's own text search returns the same OurAirports records, only the ranking differs. Falls back to SkyLink only until the index has loaded after a deploy. Render env `AIRPORT_SEARCH_COMPARE=1` logs local vs SkyLink results side by side (costs SkyLink calls, testing only).
- v3.79 (23 Oct 2026): alternate candidates skip every aerodrome whose ICAO prefix belongs to a NOGO/HIGH endpoint conflict zone in risk.js (Iran, Iraq, Syria, Sudan, Ukraine, western Russia, Yemen, Libya, Afghanistan, Somalia, Mali; `alternates.setBlockedPrefixes`, follows the list automatically); CAUTION/INFO zones (Gulf, Jordan, Israel, Lebanon, Pakistan...) stay. Sentinel alert mails: state in Firestore `system/sentinel_state` (survives deploys/restarts), an issue is mailed when it first appears and then at most once per `SENTINEL_REPEAT_HOURS` (default 24) while open; when it clears it is marked resolved and mailed again only if it returns.
- v3.80 (23 Oct 2026): Free-plan raw NOTAM lookups also have one shared daily ceiling for all Free accounts together (`RAW_NOTAM_DAILY_GLOBAL_FREE`, default 1000; Firestore `system/raw_notam_free_<day>` with `denied`, shown in the daily health report as raw_notam_free). Paid plans are not affected. Free cost estimate at 1000 users: ~$35-45/month realistic, worst case (every cap full) ~$440/month, dominated by Aviation Tools (shared 3000/day cap, no Free-only ceiling yet).
- v3.81 (23 Oct 2026): Aviation Tools also have a shared daily ceiling for all Free accounts together (`TOOLS_DAILY_GLOBAL_FREE`, default 1000, inside the all-plan TOOLS_DAILY_GLOBAL 3000; Firestore `system/tools_free_<day>` with `denied`, health report line tools_free; reply 503 tools_free_capacity shown as a toast). Free worst case at 1000 users drops to ~$260/month (every cap full every day); realistic stays ~$35-45/month.
- v3.82 (23 Oct 2026, decision: every plan gets a hard worst-case cost ceiling): expert chat rolling 7-day cap on top of the 5 h window (`GENERAL_CHAT_WEEKLY`, Render env GENERAL_CHAT_WEEKLY_TOKENS_PRO/_MAX default 150000/300000, GENERAL_CHAT_WEEKLY_SEARCHES_PRO/_MAX default 20/40; token cap -> 403 limit_reached scope weekly, search cap -> web search off). Paid daily caps lowered: Aviation Tools `TOOLS_DAILY_PAID` 400 -> 150, raw NOTAM `RAW_NOTAM_DAILY_PAID` 100 -> 50 (Render env values, if set, still win). Alert polling was already shared per airport (one poll serves every subscriber; any briefing/panel fetch of the airport since the last check is reused, airportNotamStore). SkyLink RapidAPI: highest public plan is Pro $59 / 20,000 calls per month — quota, not dollars, is the binding limit.
- v3.83 (23 Oct 2026): SkyLink Pro = $59 / 20,000 calls, then $0.003 per call (overage, no hard stop) + 10 GB bandwidth then $0.001/MB. Free plan may use at most `FREE_SKYLINK_SHARE` (default 0.25) of `SKYLINK_MONTHLY_LIMIT` per month (`reserveFreeSkylink`, Firestore `system/skylink_free_<YYYY-MM>`, units: briefing 2, raw NOTAM 1, tool 1; admin mail at 80%; health report line skylink_free_share) — paid plans are never blocked by quota. SKYLINK_MONTHLY_LIMIT must be set to the plan quota (20000) in Render (code default 1000). Usage mails now also at 100/150/200/300% with the overage $ so far. `/api/distance/` computed locally (alternates.js `localDistance`, great-circle + initial true bearing, ICAO or IATA), before the tool gate; SkyLink only for unknown codes. Short shared caches: /weather/airsigmet 10 min, /delays/ 5 min. Navaids stay on SkyLink (OurAirports navaids are stale, e.g. nothing for LTFM; SkyLink /navaids is already cached 12 h). FAA NMS-API access (7-AWA-NAIMES@faa.gov) is the planned long-term NOTAM source (own NOTAM DB, event-driven alerts); SkyLink itself is built on the FAA SWIM feed.
- v3.84 (23 Oct 2026): (1) same-route briefing cache: plain ICAO briefings (no pasted text/files) with the same aerodromes, model and plan scope (Free = no FIR) within `BRIEFING_CACHE_MIN` (default 10, 0 = off) are replayed from memory (no AI, no SkyLink), with a note showing when they were generated; only complete briefings (stop_reason end_turn, NOTAM data present) are stored; still count toward the user's monthly briefings; admin never cached; logged as [BRIEFING CACHE] and written to briefingCosts with costUsd 0, cached:true. (2) expert chat weekly usage now from daily buckets `general_chat_daily/<uid>_<YYYY-MM-DD>` (tokens, searches, sonnetTokens; week = today + 6 previous UTC days, 7 reads per message). (3) hybrid chat: weekly Sonnet allowance `GENERAL_CHAT_WEEKLY_SONNET_PRO/_MAX` (default 40000/80000 tokens), past it the rest of the week runs on Haiku 5.5 (web search unaffected). (4) NOTAM alert mails batched: one mail per user per alert run with all of that user's airports; alert mail text is HTML-escaped.
- v3.85 (23 Oct 2026): Aviation Tools monthly per-user ceiling for paid plans on top of the daily cap (`TOOLS_MONTHLY_PRO` 1500, `TOOLS_MONTHLY_MAX` 3000, enterprise = max; Firestore `toolUsageMonthly/<uid>_<YYYY-MM>`; 429 tool_limit with a monthly message). Note: the same-route briefing cache never serves admin accounts — test it with a Free/Pro account; a deploy/restart empties it.
- v3.86 (23 Oct 2026): extra video pack implemented (pricing table: Max +$10 = 3 more). One-time Stripe Checkout (`POST /api/buy-video-pack`, Max/Enterprise only, Render env `STRIPE_PRICE_VIDEO_PACK` = one-time $10 price id, `VIDEO_PACK_SIZE` default 3); webhook `checkout.session.completed` / `async_payment_succeeded` with metadata.kind=video_pack credits `users/{uid}.videoCredits` exactly once per session (Firestore `videoPacks/<sessionId>` created first); pack videos never expire and are used only after the 5 monthly videos; each video records `chargedFrom` ('monthly' | 'pack') and a failed video refunds exactly that (`refundVideoCharge`). When the monthly 5 are used the video overlay offers the pack; /api/usage returns video.packCredits / packAvailable; ?videopack=success shows a toast.
- v3.87 (24 Oct 2026): COST LEDGER — measured cost per user/plan/category instead of estimates. `recordCost(userId, plan, category, usd)` buffers in memory and flushes every 60 s as increments to `costLedger/<uid>_<YYYY-MM>` (total, cats.<cat>.{usd,n}) and `system/costs_<YYYY-MM>` (byPlan.<plan>.<cat>). Categories: ai_briefing (measured tokens), ai_chat (expert chat tokens + $0.01/search), ai_ask, ai_analysis, ai_small (callAI), skylink (each real SkyLink call at SKYLINK_OVERAGE_USD, attributed via AsyncLocalStorage `costCtx` entered in the briefing, raw NOTAM, tool gate, video, chat and analysis handlers once user+plan are known; no context -> `_system` *_unattributed), alerts (each poll split across that airport's subscribers), video (booked on completion: script words/2.1/VIDEO_TTS_SPEED x VIDEO_USD_PER_SEC 0.015 + chars x ELEVENLABS_USD_PER_CHAR 0.0002 + $0.02 script; stored as videos.costEst). Admin: `GET /api/admin/costs?month=` + admin.html "MEASURED COST PER PLAN" (subscribers, cost per subscriber, % of price, categories, top 10 users). Stripe fees not included. costCtx.enterWith is only ever called after an await (never leaks across keep-alive requests; verified).
- v3.88 (27 Oct 2026): revenue maths in one place — `PLAN_PRICE` (per month; yearly = yearly price / 12: Pro 49/42, Max 99/84, Enterprise 999/849; Render env PRICE_<PLAN>_MONTHLY / PRICE_<PLAN>_YEARLY_PER_MONTH), `userRevenueState`, `revenueSummary`. MRR counts only paying subscribers (Stripe status active / past_due; enterprise also when not on Stripe), trials and complimentary/manual plans count 0 and are listed separately (health report line revenue_mix). Used by the daily health report, weekly report, /api/health and the cost ledger's "% of price" (now the actual average revenue per paying subscriber); admin.html uses the same rule (adminMrr, keep in sync). `/api/health` now returns only status/timestamp to the public (it exposed user counts/MRR and read the whole users collection on every call); full numbers need the admin token. Yearly plans already existed (pricing toggle, STRIPE_PRICE_*_YEARLY set in Render); usage limits reset monthly for yearly subscribers too.
- v3.89 (27 Oct 2026): Enterprise loss risk closed until the redesigned pooled team plan exists: Enterprise follows Max rules (briefing hybrid MAX_SONNET_BRIEFINGS then Haiku 5.5; ALERT_CAPS enterprise 10 -> 5). Old Enterprise offer ($999 / 10 users, API, SLA, tiered seat prices) was never built and ran at a loss in the worst case (~$96 per seat); decision 27 Oct: Enterprise = shared team pool, content to be redesigned. Sales/Support agent prompts no longer quote Enterprise prices/seat counts or promise API/SLA (custom quote, API on request, no uptime SLA). Public pricing cards (index.html x3 + FAQ, pricing.html, pricing-upgrade.html) still show the old Enterprise text — to be replaced with the approved new design.
