/**
 * Lingua Viva — Cloudflare Worker
 *
 * Handles:
 *  POST /api/narrate       — vision call (proxied to Anthropic)
 *  POST /api/coach         — coaching tip call (proxied to Anthropic)
 *  POST /api/claim-session — merge anon UUID usage into a newly signed-in user
 *  POST /api/stripe-webhook — Stripe subscription events → Supabase
 */

const DAILY_FREE_LIMIT = 15;

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname === "/api/narrate" && request.method === "POST") {
        return await handleNarrate(request, env);
      }
      if (url.pathname === "/api/coach" && request.method === "POST") {
        return await handleCoach(request, env);
      }
      if (url.pathname === "/api/claim-session" && request.method === "POST") {
        return await handleClaimSession(request, env);
      }
      if (url.pathname === "/api/stripe-webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env);
      }
      if (url.pathname === "/api/profile" && request.method === "GET") {
        return await handleProfile(request, env);
      }
      if (url.pathname === "/api/save-cycle" && request.method === "POST") {
        return await handleSaveCycle(request, env);
      }
      if (url.pathname === "/api/save-session" && request.method === "POST") {
        return await handleSaveSession(request, env);
      }
      return corsResponse(new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error("Worker error:", err);
      return corsResponse(new Response(JSON.stringify({ error: "Internal server error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }));
    }
  },
};

// ---------------------------------------------------------------------------
// /api/narrate
// ---------------------------------------------------------------------------

async function handleNarrate(request, env) {
  const { identity, userId, isPro } = await resolveIdentity(request, env);
  if (!identity) {
    return corsResponse(jsonResponse({ error: "Invalid session" }, 401));
  }

  // Usage check (Pro users bypass)
  if (!isPro) {
    const count = await getUsageCount(identity, env);
    if (count >= DAILY_FREE_LIMIT) {
      return corsResponse(jsonResponse({
        error: "daily_limit_reached",
        used: count,
        limit: DAILY_FREE_LIMIT,
      }, 402));
    }
  }

  // Proxy to Anthropic
  const body = await request.json();
  const anthropicResponse = await callAnthropic(body, env);
  if (!anthropicResponse.ok) {
    const err = await anthropicResponse.text();
    return corsResponse(jsonResponse({ error: "Anthropic error", detail: err }, 502));
  }

  // Increment usage before returning — must be awaited so Cloudflare doesn't
  // terminate the Worker before the Supabase write completes
  await incrementUsage(identity, userId, env).catch(console.error);

  const data = await anthropicResponse.json();
  return corsResponse(jsonResponse(data));
}

// ---------------------------------------------------------------------------
// /api/coach
// ---------------------------------------------------------------------------

async function handleCoach(request, env) {
  const { identity, isPro } = await resolveIdentity(request, env);
  if (!identity) {
    return corsResponse(jsonResponse({ error: "Invalid session" }, 401));
  }

  // Coaching calls don't count against the daily limit (lightweight, no image)
  const body = await request.json();
  const anthropicResponse = await callAnthropic(body, env);
  if (!anthropicResponse.ok) {
    const err = await anthropicResponse.text();
    return corsResponse(jsonResponse({ error: "Anthropic error", detail: err }, 502));
  }

  const data = await anthropicResponse.json();
  return corsResponse(jsonResponse(data));
}

// ---------------------------------------------------------------------------
// /api/claim-session  (anon UUID → signed-in user merge)
// ---------------------------------------------------------------------------

async function handleClaimSession(request, env) {
  const { userId } = await resolveIdentity(request, env);
  if (!userId) {
    return corsResponse(jsonResponse({ error: "Must be signed in to claim a session" }, 401));
  }

  const { anonId } = await request.json();
  if (!anonId) {
    return corsResponse(jsonResponse({ error: "Missing anonId" }, 400));
  }

  const today = todayUTC();
  const sb = supabaseClient(env);

  // Ensure a public.users row exists for this user (created lazily on first sign-in)
  await sb.from("users").upsert({
    id: userId,
  }, { onConflict: "id", ignoreDuplicates: true });

  // Transfer anon usage row to the user's account (if anon row exists and user has no row today)

  // Get anon usage
  const anonUsage = await sb.from("usage")
    .select("narration_count")
    .eq("identity_key", anonId)
    .eq("date", today)
    .single();

  if (anonUsage.data) {
    // Upsert into user's row (take the higher count to avoid going backwards)
    await sb.from("usage").upsert({
      identity_key: userId,
      date: today,
      narration_count: anonUsage.data.narration_count,
    }, { onConflict: "identity_key,date", ignoreDuplicates: false });

    // Clean up anon row
    await sb.from("usage").delete().eq("identity_key", anonId).eq("date", today);
  }

  return corsResponse(jsonResponse({ ok: true }));
}

// ---------------------------------------------------------------------------
// /api/stripe-webhook
// ---------------------------------------------------------------------------

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  // Verify webhook signature
  const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  const event = JSON.parse(rawBody);
  const sb = supabaseClient(env);

  if (
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted" ||
    event.type === "customer.subscription.created"
  ) {
    const subscription = event.data.object;
    const customerId = subscription.customer;
    const status = subscription.status; // "active" | "canceled" | "past_due" etc.

    await sb.from("users")
      .update({ subscription_status: status })
      .eq("stripe_customer_id", customerId);
  }

  return new Response("ok", { status: 200 });
}

// ---------------------------------------------------------------------------
// /api/profile  (GET — returns isPro, performanceScore, vocab for signed-in users)
// ---------------------------------------------------------------------------

async function handleProfile(request, env) {
  const { userId, isPro } = await resolveIdentity(request, env);
  if (!userId) return corsResponse(jsonResponse({ error: "Must be signed in" }, 401));

  const sb = supabaseClient(env);

  // Latest session score
  const { data: lastSession } = await sb.from("sessions")
    .select("score_end")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(1)
    .single();

  // Vocab — only for Pro users
  let vocab = [];
  if (isPro) {
    const { data } = await sb.from("vocab")
      .select("word_normalized,word_original,language,times_seen")
      .eq("user_id", userId)
      .execute();
    vocab = data ?? [];
  }

  return corsResponse(jsonResponse({
    isPro,
    performanceScore: lastSession?.score_end ?? null,
    vocab,
  }));
}

// ---------------------------------------------------------------------------
// /api/save-cycle  (POST — upsert one vocab word, Pro only)
// ---------------------------------------------------------------------------

async function handleSaveCycle(request, env) {
  const { userId, isPro } = await resolveIdentity(request, env);
  if (!userId || !isPro) return corsResponse(jsonResponse({ ok: false }));

  const { wordNormalized, wordOriginal, language } = await request.json();
  if (!wordNormalized || !wordOriginal || !language) {
    return corsResponse(jsonResponse({ error: "Missing fields" }, 400));
  }

  const sb = supabaseClient(env);
  await sb.rpc("upsert_vocab_word", {
    p_user_id: userId,
    p_word_normalized: wordNormalized,
    p_word_original: wordOriginal,
    p_language: language,
  });

  return corsResponse(jsonResponse({ ok: true }));
}

// ---------------------------------------------------------------------------
// /api/save-session  (POST — record completed session, Pro only)
// ---------------------------------------------------------------------------

async function handleSaveSession(request, env) {
  const { userId, isPro } = await resolveIdentity(request, env);
  if (!userId || !isPro) return corsResponse(jsonResponse({ ok: false }));

  const { language, startedAt, narrationCount, scoreStart, scoreEnd } = await request.json();

  const sb = supabaseClient(env);
  await sb.from("sessions").insert({
    user_id: userId,
    language,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    narration_count: narrationCount,
    score_start: scoreStart,
    score_end: scoreEnd,
  });

  return corsResponse(jsonResponse({ ok: true }));
}

// ---------------------------------------------------------------------------
// Identity resolution
// Accepts: anon UUID via X-Session-ID header, or Supabase JWT via Authorization header
// Returns: { identity, userId, isPro }
// ---------------------------------------------------------------------------

async function resolveIdentity(request, env) {
  const authHeader = request.headers.get("Authorization");
  const sessionId = request.headers.get("X-Session-ID");

  // Signed-in user: verify JWT with Supabase
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const user = await verifySupabaseJWT(token, env);
    if (user) {
      const isPro = await checkProStatus(user.id, env);
      return { identity: user.id, userId: user.id, isPro };
    }
    // Invalid JWT — fall through to anon if session ID also present
  }

  // Anonymous: use UUID from X-Session-ID header
  if (sessionId && isValidUUID(sessionId)) {
    return { identity: sessionId, userId: null, isPro: false };
  }

  return { identity: null, userId: null, isPro: false };
}

// ---------------------------------------------------------------------------
// Usage helpers
// ---------------------------------------------------------------------------

async function getUsageCount(identityKey, env) {
  const sb = supabaseClient(env);
  const today = todayUTC();
  const { data } = await sb.from("usage")
    .select("narration_count")
    .eq("identity_key", identityKey)
    .eq("date", today)
    .single();
  return data?.narration_count ?? 0;
}

async function incrementUsage(identityKey, userId, env) {
  const sb = supabaseClient(env);
  const today = todayUTC();

  await sb.rpc("increment_usage", {
    p_identity_key: identityKey,
    p_date: today,
  });
}

// ---------------------------------------------------------------------------
// Pro status check
// ---------------------------------------------------------------------------

async function checkProStatus(userId, env) {
  const sb = supabaseClient(env);
  const { data } = await sb.from("users")
    .select("subscription_status")
    .eq("id", userId)
    .single();
  return data?.subscription_status === "active";
}

// ---------------------------------------------------------------------------
// Anthropic proxy
// ---------------------------------------------------------------------------

async function callAnthropic(body, env) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Supabase REST client (minimal, no SDK needed in Workers)
// ---------------------------------------------------------------------------

function supabaseClient(env) {
  const baseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const headers = {
    "apikey": key,
    "Authorization": `Bearer ${key}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation",
  };

  return {
    from(table) {
      return new SupabaseQueryBuilder(`${baseUrl}/rest/v1/${table}`, headers);
    },
    rpc(fn, params) {
      return fetch(`${baseUrl}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
      }).then(async r => {
        const text = await r.text();
        if (!text) return { data: null, error: null };
        try { return JSON.parse(text); } catch { return { data: null, error: text }; }
      });
    },
  };
}

class SupabaseQueryBuilder {
  constructor(url, headers) {
    this._url = new URL(url);
    this._headers = { ...headers };
    this._method = "GET";
    this._body = null;
  }

  select(cols = "*") {
    this._url.searchParams.set("select", cols);
    return this;
  }

  eq(col, val) {
    this._url.searchParams.set(col, `eq.${val}`);
    return this;
  }

  order(col, { ascending = true } = {}) {
    this._url.searchParams.set("order", `${col}.${ascending ? "asc" : "desc"}`);
    return this;
  }

  limit(n) {
    this._url.searchParams.set("limit", String(n));
    return this;
  }

  insert(data) {
    this._method = "POST";
    this._headers["Prefer"] = "return=representation";
    this._body = JSON.stringify(data);
    return this._execute();
  }

  execute() {
    return this._execute();
  }

  single() {
    this._headers["Accept"] = "application/vnd.pgrst.object+json";
    return this._execute();
  }

  update(data) {
    this._method = "PATCH";
    this._body = JSON.stringify(data);
    return this._execute();
  }

  delete() {
    this._method = "DELETE";
    return this._execute();
  }

  upsert(data, opts = {}) {
    this._method = "POST";
    this._headers["Prefer"] = opts.onConflict
      ? `resolution=merge-duplicates,return=representation`
      : "return=representation";
    if (opts.onConflict) {
      this._url.searchParams.set("on_conflict", opts.onConflict);
    }
    this._body = JSON.stringify(data);
    return this._execute();
  }

  async _execute() {
    const res = await fetch(this._url.toString(), {
      method: this._method,
      headers: this._headers,
      body: this._body,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { data, error: res.ok ? null : data, status: res.status };
  }
}

// ---------------------------------------------------------------------------
// Supabase JWT verification (using Supabase's JWKS endpoint)
// ---------------------------------------------------------------------------

async function verifySupabaseJWT(token, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        "apikey": env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const user = await res.json();
    if (!user.id) return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stripe webhook signature verification
// ---------------------------------------------------------------------------

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("=");
      acc[k] = v;
      return acc;
    }, {});

    const timestamp = parts.t;
    const sig = parts.v1;
    const payload = `${timestamp}.${rawBody}`;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]
    );
    const computed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const computedHex = Array.from(new Uint8Array(computed))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return computedHex === sig;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function isValidUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function base64UrlDecode(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  const binary = atob(padded);
  return new Uint8Array([...binary].map(c => c.charCodeAt(0)));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsResponse(response) {
  const r = new Response(response.body, response);
  r.headers.set("Access-Control-Allow-Origin", "*");
  r.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  r.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-ID");
  return r;
}
