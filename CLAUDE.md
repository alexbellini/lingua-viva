# Lingua Viva — Project Context

## What this is
A single-page web app that creates an ambient Italian language learning experience by narrating what the user's webcam sees, in Italian, in real time. Built for personal use by Alex Bellini.

Live URL: https://alexbellini.github.io/lingua-viva
GitHub repo: https://github.com/alexbellini/lingua-viva

## Tech stack
- Single HTML file (`index.html`) — no build system, no dependencies to install
- Anthropic JS SDK loaded via CDN: `https://esm.sh/@anthropic-ai/sdk@0.52.0`
- Browser Web Speech API for TTS (`speechSynthesis`) and STT (`SpeechRecognition`)
- Claude model in use: `claude-sonnet-4-6`
- Deployed via GitHub Pages

## How it works — core loop
1. User enters their Anthropic API key on load (not stored, in-memory only)
2. Webcam feed starts; user clicks Start
3. Every ~20s: capture a frame → send to Claude vision API → receive Italian narration + English translation + focus word + CEFR level
4. Narration spoken aloud via Italian TTS voice
5. Speak-back phase: user repeats the phrase, speech recognition captures it, Claude scores pronunciation and gives a tip
6. Loop continues

## Features implemented
- **Vocab memory**: `vocabSeen` Map tracks words seen this session; Claude avoids repeating them
- **Spaced repetition**: every 5 cycles, oldest vocab word is surfaced as a review moment (🔁 badge shown)
- **Difficulty adaptation**: `performanceScore` (0–1, starts at 0.15) drives 5 gradual tiers:
  - `< 0.20` A1 strict — 1 sentence, present tense, max 7 words
  - `< 0.38` A1 — 1 sentence, present tense, max 10 words
  - `< 0.55` A1-A2 — 1–2 sentences, present tense, max 13 words
  - `< 0.73` A2 — 2 sentences, present/near-future, max 17 words
  - `≥ 0.73` B1 — compound sentences, past tense, max 23 words
  - Score: exact +0.10, close +0.03, off −0.10
- **Focus word highlighting**: Claude picks one prominent object per scene; that word is wrapped in `<mark>` (muted purple) in the UI
- **Pronunciation coaching**: after each speak-back attempt, a second lightweight Claude call (no image, max_tokens 80) scores the attempt and returns a short tip
- **Translation toggle**: show/hide English translation under the Italian narration
- **CEFR level pill**: small badge top-right of narration box showing current level (A1/A2/B1) — Claude-determined, not tied directly to performanceScore tier
- **Hear Again button**: replays the narration TTS; lives in the narration box (not the speak-back box); disables the mic button during replay to prevent SR/TTS overlap
- **Speak-back phrase**: trailing punctuation (`.?!`) stripped before display and before passing to coaching/comparison — users speak words, not punctuation
- All session state resets on Stop

## Code conventions
- Single HTML file only — do not split into separate CSS/JS files
- No frameworks, no build step, no npm
- Minimal UI — no gamification, no onboarding, nothing beyond the core experience
- All new UI elements should match the existing dark theme (`#0e0e10` background, `#6b7df5` accent)
- Claude API calls must degrade gracefully — if any call fails, fall back to existing behaviour silently
- The Anthropic SDK requires `dangerouslyAllowBrowser: true` since it runs client-side

## Deployment workflow
```
git add index.html
git commit -m "describe change"
git push
```
GitHub Pages rebuilds automatically (~1 min). No CI, no build step needed.

## Working with Claude Code (Desktop app)
CLAUDE.md does not auto-load in the Desktop app Code tab. Start each new session with:
> "read CLAUDE.md — then [your request]"

## Known constraints
- `SpeechRecognition` works on Chrome, Edge, and macOS Safari; degrades gracefully elsewhere (speak-back auto-skips)
  - Safari requires `continuous = false` — with `continuous = true`, Safari collects speech but never auto-fires `onresult`, causing SR to hang until timeout
  - SR timeout is 12s (not 8s) — A2 phrases take ~7s to say; Safari needs ~0.5–1s processing time after speech ends before firing `onresult`; the old 8s timeout raced and won
  - `speechSynthesis.cancel()` is called before SR starts to clear any lingering audio session
- Italian TTS quality varies by OS (macOS has Alice, Windows has Elsa)
- Camera is mirrored in the UI for selfie feel; frame is un-mirrored before sending to Claude
- API key is stored in localStorage after first entry — intentionally simple for personal/beta use
- `getNarration` uses regex (`/\{[\s\S]*\}/`) to extract JSON from Claude's response rather than bare `JSON.parse`, so stray preamble doesn't crash the loop
