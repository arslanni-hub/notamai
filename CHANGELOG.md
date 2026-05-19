# Changelog

## [Unreleased]
### In Progress
- Stripe payment system
- Free/Pro/Premium content restrictions
- AI Video Briefing (WaveSpeed InfiniteTalk)
- NOTAM Alerts email notifications (Resend.com)

## [0.9.0] - 2026-05-16
### Added
- CLAUDE.md and .cursorrules for AI assistant context
- Natural language route extraction (voice: "Istanbul to London" → LTFM EGLL)
- Voice input on main briefing input
- Geographic corridor filter for en-route FIRs
- Same-country/short-route detection (no unnecessary FIR fetches)

## [0.8.0] - 2026-05-15
### Added
- Prompt caching (90% input token cost reduction)
- NOTAMs & MET panel: ✦ AI analyze per NOTAM/METAR/TAF with streaming text effect
- WaveSpeed AI account setup for video briefing

## [0.7.0] - 2026-05-14
### Added
- Ask NOTAM AI chatbot (Haiku model, multilingual, voice, file attach)
- Live NOTAM/METAR/TAF fetching in chat
- Per-briefing chat history
- Clickable ICAO codes in chat responses
- En-route FIR NOTAMs (180+ FIR mappings, 32-country coverage)

## [0.6.0] - 2026-05-13
### Added
- Archive panel (Firestore, search, filter, date groups)
- Settings panel (account, billing, notifications, referral, privacy)
- NOTAM Alerts panel (Firestore)
- Saved Routes panel (localStorage)
- NOTAMs & MET panel (raw data, proxy routes)
- Pricing upgrade page (/pricing-upgrade)
- Privacy Policy + Terms of Service pages

## [0.5.0] - 2026-05-12
### Added
- Firebase Firestore briefing archive
- Share modal (link + WhatsApp + email)
- Shared briefing public page (/b/:id)
- PDF export (html2pdf.js)
- Profile modal
- Invite a Colleague modal

## [0.4.0] - 2026-05-11
### Added
- Post-login sidebar (260px/52px, Claude-style)
- Starred + Recents briefing history
- Three-dot context menu on sidebar items
- Sidebar panels (slide-in from right)
- User popup with plan info

## [0.3.0] - 2026-05-10
### Added
- Live NOTAM briefing with Claude Sonnet streaming
- SkyLink API integration
- aviationweather.gov METAR/TAF integration
- Go/No-Go recommendation
- Risk scoring (CRITICAL/HIGH/MEDIUM/LOW)
- File attach (photo/PDF analysis via Claude Vision)

## [0.2.0] - 2026-05-09
### Added
- Firebase Authentication (Google + email)
- Login/Signup modals
- Cockpit canvas animation
- Glassmorphism navbar

## [0.1.0] - 2026-05-08
### Added
- Initial project setup
- Node.js server on Render.com
- Basic HTML structure
