# NOTAM Intelligence
> AI-powered pre-flight briefing platform for pilots and flight dispatchers

🌐 **Live:** https://notamai.onrender.com

## What it does
NOTAM Intelligence aggregates live NOTAM, METAR, and TAF data from global sources and uses Claude AI to generate professional operational pre-flight briefings with Go/No-Go recommendations, risk scoring, and en-route FIR analysis.

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS (single file SPA)
- **Backend:** Node.js on Render.com
- **Database:** Firebase Firestore
- **Auth:** Firebase Authentication
- **AI:** Anthropic Claude API (Sonnet + Haiku)
- **NOTAM:** SkyLink API (RapidAPI)
- **Weather:** aviationweather.gov

## Local Development
```bash
npm install
node server.js
# Open http://localhost:10000
```

## Environment Variables
Copy `.env.example` to `.env` and fill in values.

## Deploy
Auto-deploys to Render.com on push to `main` branch.

## Project Structure
```
index.html            # Entire frontend SPA
server.js             # Node.js backend + API routes
package.json          # Dependencies
CLAUDE.md             # AI assistant context file
about.html            # About page
how-it-works.html     # How it works page
pricing.html          # Public pricing page
pricing-upgrade.html  # Upgrade page (logged-in users)
privacy.html          # Privacy policy
terms.html            # Terms of service
```

## Key Features
- ✅ Live NOTAM briefing with AI analysis (Claude Sonnet, streaming)
- ✅ En-route FIR NOTAMs (180+ FIR mappings worldwide)
- ✅ METAR/TAF weather analysis
- ✅ Go/No-Go recommendation with risk scoring
- ✅ Ask NOTAM AI chatbot (multilingual, voice input, file attach)
- ✅ NOTAMs & MET panel with AI analyze per NOTAM/METAR/TAF
- ✅ Briefing archive (Firestore)
- ✅ Share briefings (public link)
- ✅ PDF export
- ✅ Voice input + natural language route extraction
- 🔄 AI Video Briefing (WaveSpeed — in progress)
- 🔄 Stripe payments (in progress)
- 🔄 Free/Pro/Premium restrictions (in progress)

---
Built with [Claude Code](https://claude.ai/claude-code) + [Anthropic Claude API](https://anthropic.com)
