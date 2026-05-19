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
- **Difficulty adaptation**: `performanceScore` (0–1, starts at 0.5) adjusts Claude's difficulty tier (A1 / A1-A2 / A2-B1) based on speak-back results
- **Focus word highlighting**: Claude picks one prominent object per scene; that word is wrapped in `<mark>` (muted purple) in the UI
- **Pronunciation coaching**: after each speak-back attempt, a second lightweight Claude call (no image, max_tokens 80) scores the attempt and returns a short tip
- **Translation toggle**: show/hide English translation under the Italian narration
- **CEFR level pill**: small badge top-right of narration box showing current level (A1/A2/B1)
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

## Known constraints
- `SpeechRecognition` is Chrome/Edge only — degrades gracefully on other browsers (speak-back phase auto-skips)
- Italian TTS quality varies by OS (macOS has Alice, Windows has Elsa)
- Camera is mirrored in the UI for selfie feel; frame is un-mirrored before sending to Claude
- API key is entered by the user on every load — intentionally not persisted anywhere
