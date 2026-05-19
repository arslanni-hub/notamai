# NOTAM Intelligence — Claude Code Project Context

## Project Overview
NOTAM Intelligence (notamai.com) is a global AI-powered pre-flight briefing platform for pilots and flight dispatchers. It aggregates live NOTAM, METAR, and TAF data and uses Claude AI to generate professional operational briefings.

## Tech Stack
- **Frontend:** Single-page HTML/CSS/JS (index.html) — NO framework, pure vanilla JS
- **Backend:** Node.js (server.js) on Render.com
- **Database:** Firebase Firestore (europe-west1) — briefing archive, user data, alerts
- **Auth:** Firebase Authentication (Google + Email/Password)
- **AI:** Anthropic Claude API (Sonnet for briefings, Haiku for chat/analysis/extract)
- **NOTAM Data:** SkyLink API (RapidAPI) — env var: SKYLINK_KEY
- **Weather Data:** aviationweather.gov (free, no key needed)
- **Video:** WaveSpeed AI API (planned) — env var: WAVESPEED_KEY
- **Deploy:** Render.com — auto-deploys from GitHub main branch

## Repository
- GitHub: arslanni-hub/notamai
- Local: /Users/arslan/Documents/notamai
- Files: index.html, server.js, package.json, about.html, how-it-works.html, pricing.html, pricing-upgrade.html, privacy.html, terms.html

## Environment Variables (Render)
- ANTHROPIC_KEY — Claude API key
- SKYLINK_KEY — SkyLink RapidAPI key
- WAVESPEED_KEY — WaveSpeed AI key (to be added)

## Claude Models in Use
- Main briefing: claude-sonnet-4-20250514 (⚠️ DEPRECATED June 15 2026 — update to claude-sonnet-4-6-20250514)
- Chat/analyze/extract: claude-haiku-4-5-20251001
- Prompt caching: enabled on all endpoints (anthropic-beta: prompt-caching-2024-07-31)

## Architecture
```
User → index.html (SPA)
→ POST /briefing → SkyLink (NOTAMs) + aviationweather.gov (METAR/TAF) + getEnrouteNotams() → Claude Sonnet (streaming SSE) → Firestore save
→ POST /api/chat → Claude Haiku (conversation with briefing context)
→ POST /api/analyze-notam → Claude Haiku (single NOTAM/METAR/TAF analysis)
→ POST /api/extract-route → Claude Haiku (natural language → ICAO codes)
→ GET /api/raw/notam/:icao → SkyLink proxy
→ GET /api/raw/metar/:icao → aviationweather.gov proxy
→ GET /api/raw/taf/:icao → aviationweather.gov proxy
→ GET /b/:id → Shared briefing page (Firestore fetch)
→ GET /pricing-upgrade → Upgrade page
```

## Key Functions (index.html)
- `handleSend()` — main briefing trigger
- `loadBriefingHistory()` — loads Firestore archive on login
- `saveBriefingToFirestore()` — saves completed briefing
- `openRawDataPanel()` / `fetchRawData()` — NOTAMs & MET panel
- `openAIChat()` / `sendAIChat()` — Ask NOTAM AI chatbot
- `openArchivePanel()` — briefing archive
- `getEnrouteNotams()` — fetches FIR NOTAMs for route (server.js)
- `isShortDomesticRoute()` — skips FIR fetch for domestic/short routes
- `isFirBetweenRoute()` — geographic corridor filter for FIRs

## Design System
- Dark aviation/cockpit theme — background: #060a0f
- Fonts: Orbitron (headings), Rajdhani (body), Share Tech Mono (data/mono)
- Primary blue: #4a9eff
- Colors: red #e63946, orange #f4841a, yellow #f2c641, green #2ec4b6, purple #b57bff
- All styling: inline CSS only — NO external CSS frameworks
- Sidebar: 260px open / 52px collapsed
- All panels: slide-in from right, 320-380px wide

## Sidebar Panels (all slide-in from right)
- NOTAMs & MET — raw NOTAM/METAR/TAF with ✦ AI analyze
- Saved Routes — localStorage
- Archive — Firestore briefing history with search/filter
- NOTAM Alerts — Firestore watched airports
- Settings — comprehensive settings panel
- Ask NOTAM AI — chatbot panel (opens from result screen)

## Pricing Plans (not yet implemented in code)
- Free: 10 normal credits/mo, 1 briefing
- Pro $49: 200 normal credits/mo
- Premium $99: 400 normal + 100 video credits/mo (5 videos, hard limit)
- Credit costs: briefing=10cr, chat=2cr, analysis=1cr, video=20 video credits
- Video: WaveSpeed InfiniteTalk, 60sec, ~$1.80/video

## Firebase Collections
- briefings: {userId, route, riskLevel, html, createdAt}
- users: {email, plan, displayName, role, organization, referredBy, createdAt}
- alerts: {userId, icao, active, createdAt}

## Coding Rules
- ALWAYS push to GitHub after changes
- NEVER use position:fixed inside panels (breaks layout)
- NEVER use external CSS frameworks
- All new features must work with sidebar open/closed states
- Test with both logged-in and logged-out states
- Briefing result overlay: sidebar-aware positioning via body.sidebar-open class
- Console logs: keep CACHE and FILTER logs, remove debug logs before production

## Known Issues / TODO
- ⚠️ Claude Sonnet model needs update before June 15 2026
- Free/Pro/Premium content restrictions not yet implemented
- Stripe payment system not yet implemented
- AI Video Briefing (WaveSpeed) not yet implemented
- NOTAM Alerts email notifications not yet implemented (UI ready, needs Resend.com)

## Completed Features ✅
- Cockpit canvas animation (main page)
- Glassmorphism navbar with scroll effect
- Login/Signup modals (Google + email)
- Live NOTAM briefing with streaming (SkyLink + Claude Sonnet)
- En-route FIR NOTAMs (180+ FIR mappings, geographic corridor filter)
- Attach file analysis (photo/PDF via Claude Vision)
- Voice input (Web Speech API, multilingual)
- Natural language route extraction
- Post-login sidebar with all panels
- Firestore briefing archive
- Share modal (link + WhatsApp + email)
- PDF export (html2pdf.js)
- Pricing upgrade page
- Profile modal
- Invite a Colleague modal
- Settings panel (comprehensive)
- Archive panel (search + filter + date groups)
- Privacy Policy + Terms of Service pages
- Ask NOTAM AI chatbot (Haiku, multilingual, file attach, voice)
- NOTAMs & MET panel with ✦ AI analyze (NOTAM/METAR/TAF)
- Prompt caching (90% input cost reduction)
- Per-briefing chat history (chatHistoryMap)
