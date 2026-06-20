# NOTAM Intelligence — Claude Code Project Context

## Project Overview
NOTAM Intelligence (notamai.com) is a global AI-powered pre-flight briefing platform for pilots and flight dispatchers. It aggregates live NOTAM, METAR, and TAF data and uses Claude AI to generate professional operational briefings.

## Tech Stack
- **Frontend:** Single-page HTML/CSS/JS (index.html) — NO framework, pure vanilla JS
- **Backend:** Node.js (server.js) on Render.com
- **Database:** Firebase Firestore (europe-west1) — briefing archive, user data, alerts, videos
- **Auth:** Firebase Authentication (Google + Email/Password)
- **AI:** Anthropic Claude API — Sonnet for main briefings, Haiku for chat/analysis/extract/video scripts
- **NOTAM Data:** SkyLink API (RapidAPI) — env var: SKYLINK_KEY
- **Weather Data:** aviationweather.gov (free, no key needed)
- **Video:** WaveSpeed AI (infinitetalk-fast model) + ElevenLabs TTS — LIVE, implemented
- **Payments:** LemonSqueezy (NOT Stripe) — live, tested, working
- **Deploy:** Render.com — auto-deploys from GitHub main branch

## Repository
- GitHub: arslanni-hub/notamai
- Files: index.html, server.js, package.json, about.html, how-it-works.html, pricing.html, pricing-upgrade.html, privacy.html, terms.html

## Environment Variables (Render)
- ANTHROPIC_KEY — Claude API key
- SKYLINK_KEY — SkyLink RapidAPI key
- WAVESPEED_KEY — WaveSpeed AI key
- ELEVENLABS_KEY — ElevenLabs TTS key
- LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_PRO_VARIANT_ID, LEMONSQUEEZY_PREMIUM_VARIANT_ID, LEMONSQUEEZY_WEBHOOK_SECRET
- FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY

## Claude Models in Use (current, verified in code)
- Main briefing generation: `claude-sonnet-4-6`
- Ask NOTAM AI chat (briefing-specific): `claude-haiku-4-5-20251001`
- ✨ Single NOTAM/METAR/TAF analysis: `claude-haiku-4-5-20251001`
- Route extraction (natural language → ICAO): `claude-haiku-4-5-20251001`
- Video briefing script generation: `claude-haiku-4-5-20251001`
- Prompt caching: enabled on all chat/analysis endpoints (anthropic-beta: prompt-caching-2024-07-31)
- ⚠️ Do not assume a chat-type feature should default to Haiku — model choice per plan/feature is a deliberate decision, confirm before changing.

## Architecture
```
User → index.html (SPA)
→ POST /briefing → SkyLink (NOTAMs) + aviationweather.gov (METAR/TAF) + getEnrouteNotams() → Claude Sonnet (streaming SSE) → Firestore save
→ POST /api/chat → Claude Haiku (Ask NOTAM AI — briefing-specific conversation)
→ POST /api/analyze-notam → Claude Haiku (single NOTAM/METAR/TAF analysis)
→ POST /api/extract-route → Claude Haiku (natural language → ICAO codes)
→ POST /api/generate-video-briefing → Claude Haiku (script) → ElevenLabs (TTS) → WaveSpeed infinitetalk-fast (video) → Firestore videos collection
→ GET /api/check-video-briefing/:id → polls WaveSpeed prediction status
→ GET /api/raw/notam/:icao → SkyLink proxy
→ GET /api/raw/metar/:icao → aviationweather.gov proxy
→ GET /api/raw/taf/:icao → aviationweather.gov proxy
→ POST /api/create-checkout → LemonSqueezy checkout URL creation
→ POST /api/lemonsqueezy-webhook → HMAC-verified plan updates (subscription_created/cancelled → Firestore users.plan)
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

| Feature | Free | Pro $49 | Premium $99 |
|---|---|---|---|
| AI Briefing | 3/month | Unlimited* | Unlimited* |
| En-route FIR | ❌ | ✅ | ✅ |
| Ask NOTAM AI (briefing-specific chat) | ❌ | ✅ | ✅ |
| ✨ Single NOTAM/METAR/TAF AI analysis | ❌ | ✅ | ✅ |
| AI Video Briefing | ❌ | ❌ | 5/month hard limit, +$10 = 3 more |
| NOTAMs & MET raw data | ✅ | ✅ | ✅ |
| Archive | ❌ | 90 days | Unlimited |
| Saved Routes | ❌ | 5 | Unlimited |
| NOTAM Alerts | ❌ | 5 | Unlimited |
| Share + PDF export | ❌ | ✅ | ✅ |
| Priority support | ❌ | ❌ | ✅ |

*Unlimited briefings protected by a soft daily cap of 20/day (bot-abuse protection only)

In code: `PLAN_LIMITS` in server.js currently uses `{briefings, chat, analysis}` numeric caps (free: 3/0/0, pro: 100/200/300, premium: 150/999/999) as the enforcement mechanism for the table above — these numbers implement the table, they are not a separate source of truth. Don't change PLAN_LIMITS values without first confirming against this table.

## General Aviation Expert Chat — IN PROGRESS, not yet implemented
Separate from "Ask NOTAM AI" (which stays briefing-specific, never touch it for this feature). Design in progress as of June 2026:
- Reached via the same main input box — hybrid detection: 1-2 ICAO-shaped tokens → briefing flow (unchanged); natural language → general chat
- Panel replaces the input-card in place (NOT a slide-in-from-right panel) — cockpit/HUD background stays fully visible behind it
- Accent color: blue (#4a9eff), matching existing design — no new colors
- 3-hour rolling window limits, modeled on Claude's own usage UX: Free (Haiku only, low limit, hard stop), Pro (Sonnet, 30 msgs/window, soft-downgrades to Haiku past limit), Premium (Sonnet, 100 msgs/window, soft-downgrades past limit)
- User-facing usage indicator shows percentage only (e.g. "90% of your limit used"), never raw message counts — appears only when approaching/at the limit, otherwise invisible
- System prompt must gracefully redirect (not fabricate data) when a question needs a paid platform feature (live NOTAM data, briefing generation, video briefing)
- Confirm current implementation status with the user before continuing — this section reflects the design plan as of June 20 2026, not necessarily what's in code yet

## Coding Rules
- ALWAYS push to GitHub after changes
- NEVER use position:fixed inside panels (breaks layout)
- NEVER use external CSS frameworks
- NEVER introduce new accent colors, layout patterns (e.g. slide-in vs in-place), or architectural decisions not explicitly requested — ask if unsure rather than defaulting to a "reasonable" choice
- All new features must work with sidebar open/closed states
- Test with both logged-in and logged-out states
- Console logs: keep CACHE and FILTER logs, remove debug logs before production

## Known Issues / TODO
- Free/Pro/Premium content restrictions: implemented for briefings/chat/analysis caps; video hard limit (5/mo) enforcement should be double-checked
- AI Video Briefing: working end-to-end (Haiku script → ElevenLabs TTS → WaveSpeed infinitetalk-fast), still being quality-tuned (NOTAM relevance/recency, captain greeting consistency)
- General Aviation Expert Chat: designed, not yet implemented (see section above)
- Admin panel: Free-tier conversion tracking/funnel metrics planned, not yet built
- NOTAM Alerts email notifications: UI ready, needs Resend.com integration
- SkyLink plan usage should be monitored — was previously flagged near/over free-tier limits

## Maintenance Note
**This file must be kept up to date.** Update it whenever a change has real architectural or decision-level impact: new feature shipped, payment/model/integration swapped, pricing or plan limits changed. Don't bother updating for small fixes or cosmetic tweaks. If this file conflicts with what the user describes in conversation, the user's current instruction wins — but flag the discrepancy so the file can be corrected.
