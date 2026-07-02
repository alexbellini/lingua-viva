# Lingua Viva — Remediation Implementation Plan

> **For the executing agent.** This plan fixes security, revenue, and correctness issues found in a full code review (2026-07). You have NOT seen that review; everything you need is here. Read `CLAUDE.md`, `index.html`, `worker/index.js`, and `worker/supabase-schema.sql` in full before starting. Line numbers cited are as of commit `5ab60b3` — re-locate code by the quoted identifiers, not raw line numbers.

## Ground rules
- Follow `CLAUDE.md` conventions strictly: single `index.html` (no split files, no build step, no npm for the frontend); dark theme `#0e0e10` / accent `#6b7df5`; Claude-call failures degrade silently; persistence calls are fire-and-forget.
- Frontend work happens on the repo branch you were assigned; Worker deploys (`wrangler deploy`) and Supabase/Stripe dashboard changes are **operator actions** — you cannot perform them. Every phase below ends with an explicit **Operator checklist** for those. Write the code and the SQL; flag the operator steps in your final summary.
- Commit per phase with a descriptive message. Do not merge to `main`.
- The Anthropic model in use is `claude-sonnet-4-6` — keep it; do not "upgrade" it.

## Phase ordering
Phases 1–4 are independent of each other and can be done in any order, but do Phase 3 before Phase 5 (Phase 5 touches the same frontend functions). Within a phase, follow the listed order.

---

## Phase 1 — Supabase security (fixes C1: RLS self-upgrade to Pro; H3: unverified RLS on vocab/sessions)

**Problem:** `worker/supabase-schema.sql` has `create policy "users_own_row" on public.users for all using (auth.uid() = id);`. RLS is row-level, not column-level, so any signed-in user can PATCH their own row via PostgREST (the anon key ships in `index.html`) and set `subscription_status='active'` — the exact field `checkProStatus()` in `worker/index.js` trusts for Pro. Additionally, the `vocab` and `sessions` tables and the `upsert_vocab_word` RPC used by the Worker are missing from the schema file entirely (created ad hoc in the dashboard); their RLS status is unknown — if RLS is off, any client with the anon key can read/write every user's data.

**Code changes:**
1. Create `worker/migrations/2026-07-security-fix.sql` containing:
   ```sql
   -- C1: users must not be client-writable (subscription_status is trusted by the Worker)
   drop policy if exists "users_own_row" on public.users;
   create policy "users_select_own" on public.users
     for select using (auth.uid() = id);
   -- (no insert/update/delete policies — the Worker uses the service role key, which bypasses RLS)

   -- H3: bring vocab/sessions under RLS with no client policies (service-role only)
   create table if not exists public.vocab (
     user_id         uuid not null references auth.users(id) on delete cascade,
     word_normalized text not null,
     word_original   text not null,
     language        text not null,
     times_seen      integer not null default 1,
     last_seen_at    timestamptz not null default now(),
     primary key (user_id, word_normalized, language)
   );
   create table if not exists public.sessions (
     id              bigint generated always as identity primary key,
     user_id         uuid not null references auth.users(id) on delete cascade,
     language        text,
     started_at      timestamptz,
     ended_at        timestamptz,
     narration_count integer,
     score_start     real,
     score_end       real
   );
   alter table public.vocab    enable row level security;
   alter table public.sessions enable row level security;

   -- Canonical definition of the vocab upsert RPC (Worker calls this)
   create or replace function public.upsert_vocab_word(
     p_user_id uuid, p_word_normalized text, p_word_original text, p_language text
   ) returns void as $$
   begin
     insert into public.vocab (user_id, word_normalized, word_original, language)
     values (p_user_id, p_word_normalized, p_word_original, p_language)
     on conflict (user_id, word_normalized, language)
     do update set times_seen = public.vocab.times_seen + 1, last_seen_at = now();
   end;
   $$ language plpgsql security definer;
   ```
   ⚠️ The prod tables/RPC already exist with unknown exact definitions. The `create table if not exists` statements are no-ops there; the operator must diff them against prod (columns above are inferred from Worker usage: `worker/index.js` handleProfile/handleSaveCycle/handleSaveSession/handleProgress) and adjust the migration if prod differs, especially the `on conflict` target of the RPC.
2. Fold the same definitions into `worker/supabase-schema.sql` so it becomes the complete source of truth (replace the `users_own_row` policy, append vocab/sessions/RPC, drop the "Phase 1" framing).

**Operator checklist (Supabase dashboard, prod project `cccfkstknewwpqfxzaxs` and dev project):**
- Run the migration in the SQL editor.
- Verify RLS: `select relname, relrowsecurity from pg_class where relname in ('users','usage','vocab','sessions');` — all must be `true`.
- Verify the exploit is closed: with a real user JWT + anon key, `PATCH {SUPABASE_URL}/rest/v1/users?id=eq.<own-id>` body `{"subscription_status":"active"}` must affect 0 rows.
- Verify client reads of others' data fail: `GET /rest/v1/vocab?select=*` with only the anon key must return `[]`/401, not data.

---

## Phase 2 — Stripe activation + webhook hardening (fixes C2: payments never activate Pro; M1: weak signature verification)

**Problem (C2):** The upgrade button (`index.html`, `wall-upgrade-btn` handler) opens a bare Stripe Payment Link. The webhook (`handleStripeWebhook`, `worker/index.js`) only handles `customer.subscription.*` and matches users by `stripe_customer_id` — but nothing ever writes `stripe_customer_id`, so every update matches 0 rows and paying customers never become Pro.

**Problem (M1):** `verifyStripeSignature` (`worker/index.js`) has no timestamp tolerance (replay attacks — e.g. re-sending a captured `status:"active"` event after cancellation), uses non-constant-time `===`, and keeps only the last `v1=` value (Stripe sends multiple during secret rolls).

**Frontend changes (`index.html`):**
1. In the `wall-upgrade-btn` click handler: if the user is not signed in (`!userIsSignedIn` or no JWT via `getJWT()`), close the limit modal and open the sign-in modal instead (reuse `showSignInModal()`), with the modal message text explaining they need an account to upgrade. If signed in, get the session (`(await initSupabase()).auth.getSession()`) and open:
   `STRIPE_PAYMENT_LINK + '?client_reference_id=' + session.user.id + '&prefilled_email=' + encodeURIComponent(session.user.email)`
   (Payment Links natively support both query params.)

**Worker changes (`worker/index.js`):**
2. In `handleStripeWebhook`, add a `checkout.session.completed` branch:
   ```js
   if (event.type === "checkout.session.completed") {
     const s = event.data.object;
     if (s.client_reference_id && s.customer) {
       await sb.from("users")
         .update({ stripe_customer_id: s.customer, subscription_status: "active" })
         .eq("id", s.client_reference_id);
     }
   }
   ```
   Keep the existing `customer.subscription.*` branch for lifecycle transitions (cancel / past_due); it works once `stripe_customer_id` is populated.
3. Rewrite `verifyStripeSignature`:
   - Parse the header into `t` and **all** `v1` values (array — `parts.filter(p => p.startsWith('v1=')`)).
   - Reject if `Math.abs(Date.now()/1000 - Number(t)) > 300`.
   - Compare the computed HMAC hex against each `v1` using a constant-time compare:
     ```js
     function timingSafeEqualHex(a, b) {
       if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
       let diff = 0;
       for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
       return diff === 0;
     }
     ```

**Operator checklist:**
- Stripe dashboard: ensure the webhook endpoint subscribes to `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted` (and `created`).
- `cd worker && wrangler deploy`.
- Test: `stripe trigger checkout.session.completed --add checkout_session:client_reference_id=<test-user-uuid>` against the deployed Worker; confirm the user row flips to `active` and `stripe_customer_id` is set. Then trigger `customer.subscription.deleted` for that customer and confirm status flips off `active`.

---

## Phase 3 — Close the open Anthropic proxy + quota hardening (fixes C3: open proxy; H1: UUID-rotation bypass; M8: quota race; part of M6)

**Problem (C3):** Both `/api/narrate` and `/api/coach` forward the client-supplied request body verbatim to Anthropic (`await request.json()` → `callAnthropic(body, env)`), so model, `max_tokens`, and message content are attacker-controlled. `/api/coach` has **no usage limit at all**. Identity is a self-minted UUID; CORS is `*`. Net effect: anyone can use the API key freely.

### 3a. New API contracts (Worker owns the prompts)
Move ALL prompt text, model choice, and response parsing from `index.html` into the Worker. Hard-code in the Worker: `const MODEL = "claude-sonnet-4-6";`, narrate `max_tokens: 200`, coach `max_tokens: 80`.

**`POST /api/narrate`** — client sends:
```json
{ "image": "<base64 jpeg, no data: prefix>",
  "language": "italian" | "spanish" | "french",
  "performanceScore": 0.15,
  "avoidWords": ["gatto", "..."],
  "reviewWord": "tavolo" | null }
```
Worker validates hard (reject 400 on failure): `image` is a string ≤ 2,000,000 chars matching `^[A-Za-z0-9+/=]+$`; `language` in the whitelist; `performanceScore` coerced to a number and clamped to [0,1] (default 0.15); `avoidWords` ≤ 20 strings, each sanitized to ≤ 40 chars of letters/spaces/apostrophes/hyphens (drop anything else — these get interpolated into the prompt); `reviewWord` same sanitization or null. Then port `buildPrompt()`'s **difficulty-tier ladder and prompt template** from `index.html` into the Worker verbatim (the five `performanceScore` thresholds: <0.20, <0.38, <0.55, <0.73, else — keep identical so behavior doesn't change). Worker also takes over JSON extraction from the Claude reply (port the code-fence-strip + `match(/\{[\s\S]*\}/)` logic from `getNarration` in `index.html`) and responds:
```json
{ "narration": "...", "english": "...", "focusWord": "...", "level": "A1",
  "usage": { "used": 3, "limit": 15, "isPro": false } }
```
(`usage` is the authoritative server count — the client will use it; see Phase 5/M6. For Pro, send `used: null, limit: null, isPro: true`.)

**`POST /api/coach`** — client sends `{ "target": "...", "heard": "...", "language": "italian" }`; both strings required, ≤ 300 chars, control characters stripped. Worker builds the existing coaching prompt (port from `getCoachingTip` in `index.html`), parses/validates the reply server-side (score must be `exact|close|off`), responds `{ "score": "close", "tip": "..." }` or `{ "score": null }` on parse failure.

### 3b. Metering (H1 + M8 + coach limit)
1. Change `increment_usage` to return the new count — add to the Phase 1 migration file (and schema.sql):
   ```sql
   create or replace function public.increment_usage(p_identity_key text, p_date date)
   returns integer as $$
   declare new_count integer;
   begin
     insert into public.usage (identity_key, date, narration_count)
     values (p_identity_key, p_date, 1)
     on conflict (identity_key, date)
     do update set narration_count = public.usage.narration_count + 1
     returning narration_count into new_count;
     return new_count;
   end;
   $$ language plpgsql security definer;
   ```
2. In `handleNarrate`, replace check-then-increment with **increment-then-check** (kills the M8 race; tradeoff: a failed Anthropic call still consumes one credit — acceptable, note it in a comment). For non-Pro: `used = await incrementUsage(identity)`; if `used > DAILY_FREE_LIMIT` → 402 (keep the existing 402 body shape: `{error:"daily_limit_reached", used, limit}` — the frontend keys off status 402).
3. **IP backstop (H1):** for non-Pro requests, also increment key `'ip:' + await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown')` (hash → no raw IPs stored) with `const IP_DAILY_LIMIT = 60;` if exceeded → same 402. Pro users bypass both.
4. **Coach metering:** in `handleCoach`, increment key `'coach:' + identity` with `const COACH_DAILY_LIMIT = 40;` plus the same IP counter; over-limit → 402. (CLAUDE.md says coach "doesn't count against the limit" — it still doesn't count against the *narration* limit; update CLAUDE.md wording in Phase 6.)

### 3c. CORS allowlist
Replace `Access-Control-Allow-Origin: *` in `corsResponse` with an echo-if-allowed scheme. Pass `request` into `corsResponse` (update all call sites) and allow when: origin is exactly `https://alexbellini.github.io`, OR ends with `.lingua-viva.pages.dev` or equals `https://lingua-viva.pages.dev`, OR starts with `http://localhost:`/`http://127.0.0.1:`. Also add `Vary: Origin`. `/api/stripe-webhook` needs no CORS.

### 3d. Frontend counterpart (`index.html`)
- `getNarration()`: compute `avoidWords` and `reviewWord`/`isReview` client-side (keep that half of `buildPrompt` — it needs `vocabSeen`; delete the difficulty/template half, now server-owned), send the new body, and consume the new response shape (no more code-fence stripping client-side). Keep the review-badge toggle behavior.
- `getCoachingTip()`: send `{target, heard, language}`, consume `{score, tip}`.
- Remove the now-dead client-side JSON-extraction and prompt-template code.

**Verification:**
- `cd worker && wrangler dev` + serve `index.html` locally (`python3 -m http.server`) with `WORKER_URL` temporarily pointed at `http://localhost:8787` — run a full narrate→speak-back cycle in Chrome.
- Abuse checks against the dev Worker: POST `/api/narrate` with `{"model":"claude-opus-4-8","max_tokens":8000,"messages":[...]}` → must 400 (old contract rejected). POST `/api/coach` 41 times with the same UUID → 41st must 402. POST from an origin not in the allowlist → response must lack `Access-Control-Allow-Origin`.

**Operator checklist:** run the updated `increment_usage` in both Supabase projects **before** deploying the Worker (the Worker starts reading the return value); then `wrangler deploy`; then merge/deploy the frontend to the `dev` branch and test at dev.lingua-viva.pages.dev before `main`.
⚠️ **Deploy coupling:** the new Worker rejects the old frontend's request body and vice-versa. Sequence: migrate SQL → deploy Worker with a small back-compat shim (if body has `messages`, return 400 with `{error:"client_outdated"}`) → deploy frontend to dev → verify → promote both to prod together.

---

## Phase 4 — claim-session merge bug (fixes H2)

**Problem:** In `handleClaimSession` (`worker/index.js`), the comment says "take the higher count" but the code upserts the anon row's count over the user's row unconditionally. Exploit: a signed-in user at 15/15 mints a fresh UUID, makes 1 anon narration, calls claim-session → back to 1/15. Repeatable forever.

**Fix:** fetch the user's existing usage row for today as well; upsert `narration_count: Math.max(anonCount, userCount)`. Keep deleting the anon row. Guard both reads against the `.single()` no-row case (after Phase 6's builder fix, `data` is `null` on no-row — treat as 0).

**Verification:** seed `usage` rows (user=15, anon=1) in dev Supabase, call `/api/claim-session` with the user's JWT and that anonId → user row must remain 15 and the anon row be deleted.

---

## Phase 5 — Frontend correctness (fixes M2, M3, M5, M6)

All in `index.html`.

1. **M2 — Supabase-paused hang beyond startup.** `getJWT()` → `getSession()` can hang forever when the Supabase project is paused and a stored token is expired (documented in CLAUDE.md as a startup issue; the 5s `Promise.race` only guards the Start button). Add `getJWTSafe()` that races `getJWT()` against a 5s timeout resolving `null`, and use it in `callWorker`, `saveCycle`, `saveSession`, and `openProgressModal`. Keep raw `getJWT()` only where a hang is already guarded.
2. **M3 — Pro progress lost on Stop→Start.** The Stop branch of the `toggleBtn` handler wipes `vocabSeen`/`vocabOriginals` and resets `performanceScore` to 0.15, but `loadProfile()` only runs from the initial Start-button handler. Change the Stop-branch reset: when `userIsPro`, preserve `vocabSeen`, `vocabOriginals`, and `performanceScore` (they mirror server state); always reset `cycleCount`, `currentFocusWord`, `currentNarration`, nudge flags. Also set `sessionStartedAt = new Date().toISOString()` in the **Start branch of the toggle handler** (currently only set once at the welcome-screen Start button, so second sessions reuse a stale timestamp — and this matches what CLAUDE.md already claims the code does).
3. **M5 — magic-link `?code=` path.** The callback IIFE detects `code=` in the URL but only calls `getSession()`, which never exchanges a PKCE code (client isn't configured for PKCE). In the `search.includes('code=')` branch, explicitly call `await sb.auth.exchangeCodeForSession(new URLSearchParams(search).get('code'))` before `getSession()`, wrapped in try/catch (it will fail if the email is opened in a different browser — degrade silently per convention). Leave the `#access_token` hash path untouched. **Test on dev which URL format Supabase actually sends** and note the result in the commit message.
4. **M6 — usage counter desync.** Replace the localStorage-derived count as the display source: `getNarration` now receives `usage` from the Worker (Phase 3) — feed `usage.used` into `updateUsageUI`. Keep localStorage as the pre-first-narration fallback only. In `updateUsageUI`, hide the counter and the soft nudge entirely when `userIsPro`. Fix the cosmetic bug where `updateUsageUI(getTodayUsage())` at Start hides the counter because `isRunning` is still false (show it whenever the main screen is visible and the user is not Pro).

**Verification:** manual run on dev.lingua-viva.pages.dev — full cycle as anon (counter increments from server numbers), sign-in round trip via magic link, Pro Stop→Start retains score/vocab (check the avoid-list keeps working: same focus word shouldn't repeat), counter absent for Pro.

---

## Phase 6 — Worker data-layer correctness (fixes M4, M7) + doc sync

1. **M7 — query-builder silent failures** (`SupabaseQueryBuilder` / `supabaseClient` in `worker/index.js`):
   - `_execute()`: on `!res.ok`, return `{ data: null, error: parsedBodyOrText, status }` — never put an error body in `data` (today `.single()` with zero rows returns the PostgREST 406 error object AS `data`; callers survive only by accident).
   - `upsert(..., { ignoreDuplicates: true })`: currently silently ignored — send `Prefer: resolution=ignore-duplicates` when set.
   - `rpc()`: return `{ data, error }` consistently (`error` non-null when `!r.ok`); `incrementUsage` then reads `data` as the new count (Phase 3b depends on this).
   - Add `console.error` logging for non-ok Supabase responses in the fire-and-forget paths (`incrementUsage`, `upsert_vocab_word`) so failures stop being invisible in Worker logs.
   - Re-check every `.single()` caller (`getUsageCount`, `checkProStatus`, `handleProfile`, `handleClaimSession`) still handles `data === null` correctly after this change.
2. **M4 — "My Progress" caps at 50 sessions.** `handleProgress` computes "all time" totals from the last 50 sessions and `vocabCount` from a 50-row query. Add to the migration (and schema.sql):
   ```sql
   create or replace function public.progress_totals(p_user_id uuid)
   returns table(total_narrations bigint, session_count bigint, vocab_count bigint) as $$
     select coalesce(sum(s.narration_count), 0),
            count(s.*),
            (select count(*) from public.vocab v where v.user_id = p_user_id)
     from public.sessions s where s.user_id = p_user_id;
   $$ language sql security definer;
   ```
   Use it for the three totals; keep the existing limited queries only for `scoreTrend` (last 10) and `recentVocab` (last 30).
3. **Doc sync (required by the above, not general drift-fixing):** update `CLAUDE.md` — new narrate/coach request/response contracts, coach daily cap, IP backstop, claim-session max-merge, `checkout.session.completed` flow, and add `GET /api/progress` to the endpoint list. Update the stale "JWKS endpoint" comment above `verifySupabaseJWT` (it calls `/auth/v1/user`).

**Operator checklist:** run `progress_totals` migration in both Supabase projects; `wrangler deploy`.

---

## Optional stretch (Low tier — only if time remains, one commit each)
- Stop the camera tracks in the toggle-Stop handler (privacy: camera light stays on after "Stop").
- Make the Stop handler's `saveSession()` fire-and-forget (currently awaited, violating the project's own convention).
- Scale `speak()`'s 10s safety timeout with text length (B1 narrations get cut off).
- Word-boundary the focus-word highlight regex (`\b` doesn't work for accented chars — use lookaround on `[^\p{L}]` with the `u` flag).
- Stop leaking raw Anthropic error bodies to the client (`detail: err` in narrate/coach error paths).
- Delete dead code: `base64UrlDecode`, `primeMicPermission`, unused `userId` param of `incrementUsage`, the unreachable `isLimitError` rethrow in `getCoachingTip`.
- Handle `flipCamera` double-failure (show `mainError` instead of an unhandled rejection).

## Final acceptance checklist (run before declaring done)
1. RLS: PATCH own `users` row with a user JWT → 0 rows affected.
2. Stripe test-mode purchase via the Payment Link (signed in) → `subscription_status='active'` without manual DB edits; cancellation webhook flips it back.
3. Old-contract `/api/narrate` body with `model`/`messages` → 400. `/api/coach` beyond 40/day → 402. Disallowed origin → no CORS header.
4. claim-session with user=15/anon=1 → stays 15.
5. Full learning loop works end-to-end on dev.lingua-viva.pages.dev in Chrome (narrate → TTS → speak-back → coach tip → vocab saved for Pro).
6. Pro Stop→Start retains score and vocab; usage counter shows server numbers and is hidden for Pro.
7. `git push -u origin <assigned branch>`; do NOT merge to `main` — the operator promotes after the checklist passes on dev.
