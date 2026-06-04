# Lingua Viva — Project Context

## What this is
A single-page web app that creates an ambient language learning experience by narrating what the user's webcam sees, in the target language, in real time. Italian, Spanish, French supported.

Live URL: https://alexbellini.github.io/lingua-viva
Cloudflare Pages (prod): https://lingua-viva.pages.dev
Cloudflare Pages (dev): https://dev.lingua-viva.pages.dev — use this for all dev testing
GitHub repo: https://github.com/alexbellini/lingua-viva

## Tech stack
- Single HTML file (`index.html`) — no build system, no dependencies to install
- Supabase JS SDK loaded via CDN (lazy-loaded on sign-in): `https://esm.sh/@supabase/supabase-js@2`
- Browser Web Speech API for TTS (`speechSynthesis`) and STT (`SpeechRecognition`)
- Claude model in use: `claude-sonnet-4-6`
- All Claude API calls proxied through Cloudflare Worker (`worker/index.js`)
- Deployed via GitHub Pages (`main`) and Cloudflare Pages (`main` + `dev` branch)

## Architecture
```
Browser → Cloudflare Worker → Anthropic API
                ↓
           Supabase (usage tracking, auth, vocab/session persistence)
                ↓
           Stripe (subscription payments)
```

**Worker endpoints:**
- `POST /api/narrate` — vision call (proxied to Anthropic), enforces 15/day free limit
- `POST /api/coach` — coaching tip call (no image, doesn't count against limit)
- `POST /api/claim-session` — merge anon UUID usage into signed-in user on magic link return; also upserts `public.users` row
- `POST /api/stripe-webhook` — Stripe subscription events → Supabase
- `GET /api/profile` — returns isPro, performanceScore, vocab list for signed-in users
- `POST /api/save-cycle` — upserts one vocab word (Pro users only)
- `POST /api/save-session` — records completed session (Pro users only)

**Supabase (prod project `cccfkstknewwpqfxzaxs`):**
- Tables: `users`, `usage`, `vocab`, `sessions`
- RPCs: `increment_usage`, `upsert_vocab_word`
- JWT verification in Worker: calls `/auth/v1/user` endpoint (NOT manual crypto)

## How it works — core loop
1. User lands on welcome screen, selects language, clicks Start
2. Camera starts; anonymous UUID generated (stored in `localStorage['lv_session_id']`)
3. If signed in: `loadProfile()` fetches vocab + score from Worker → restores state for Pro users
4. Every ~20s: capture frame → Worker → Anthropic vision → Italian narration + translation + focus word + CEFR level
5. Narration spoken aloud via TTS
6. Speak-back phase: user repeats phrase; SR captures it; Claude scores and gives coaching tip
7. Focus word saved to `vocabSeen` Map; Pro users: fire-and-forget save to Supabase
8. Loop continues until Stop; Pro users: session record saved on Stop

## Features
- **Monetization gate**: 15 narrations/day free (enforced in Worker via Supabase); unlimited for Pro ($9.99/mo via Stripe)
- **Usage counter**: shows X/15 narrations; soft nudge at 12, hard wall at 15
- **Auth**: Supabase magic-link email; anon session claimed and merged on sign-in
- **Vocab persistence** (Pro): `vocabSeen` saved to Supabase after each cycle; loaded on next session start
- **Session persistence** (Pro): `performanceScore` restored from last session's `score_end`
- **"Progress loaded" toast**: shown on main screen after Start if Pro user has saved vocab
- **Vocab memory**: `vocabSeen` Map avoids repeating focus words; review every 5 cycles (🔁 badge)
- **Difficulty adaptation**: `performanceScore` (0–1, starts 0.15) drives 5 tiers (A1 strict → B1)
- **Focus word highlighting**: key word wrapped in `<mark>` (muted purple)
- **Pronunciation coaching**: Claude scores speak-back and gives short tip
- **Translation toggle**, **CEFR level pill**, **Hear Again button** (narration box only)
- **PostHog analytics**: session_started, narration_completed, speakback_scored, session_ended, upgrade_prompt_shown, upgrade_clicked, limit_hit
- **Firefox/no-SR fallback**: speak-back shows "→ Continue" button with 5s auto-skip

## Auth state variables
- `userIsSignedIn` — set true in `loadProfile()` if JWT present, or in magic link callback
- `userIsPro` — set from `/api/profile` response; gates all persistence calls
- `sessionStartedAt` — ISO timestamp set when toggle Start is clicked (not Start button)

## Code conventions
- Single HTML file only — do not split into separate CSS/JS files
- No frameworks, no build step, no npm
- Minimal UI — no gamification, no onboarding, nothing beyond the core experience
- All new UI elements must match dark theme (`#0e0e10` background, `#6b7df5` accent)
- Claude API calls must degrade gracefully — if any call fails, fall back silently
- Persistence calls (saveCycle, saveSession) are fire-and-forget; never block the learning loop

## Deployment workflow
```
# Frontend only:
git checkout dev
git add index.html
git commit -m "..."
git push origin dev
# → Cloudflare Pages auto-builds preview at dev.lingua-viva.pages.dev

# Worker changes:
cd worker
wrangler deploy

# Merge to prod:
git checkout main
git merge dev --ff-only
git push origin main
```

## Worker secrets (set via `wrangler secret put` from worker/ dir)
- `ANTHROPIC_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (prod service role key)
- `SUPABASE_JWT_SECRET` (prod legacy JWT secret — set but not currently used)
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`

## Known constraints
- `SpeechRecognition`: Chrome/Edge/macOS Safari only; Firefox and iOS Safari degrade gracefully
  - Safari: `continuous = false` required; 12s SR timeout (A2 phrases ~7s + processing time)
  - Firefox: no SR support → shows "→ Continue" button with 5s auto-skip
- Italian TTS quality varies by OS (macOS: Alice, Windows: Elsa)
- Camera mirrored in UI; un-mirrored before sending to Claude
- Magic link rate limit: ~4/hour on Supabase free tier
- Local usage counter uses UTC dates — can appear stale for UTC-offset users
- `getNarration` uses regex to extract JSON from Claude response (handles stray preamble)
