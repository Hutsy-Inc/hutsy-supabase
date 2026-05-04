// supabase/functions/app-snapshot/index.ts
// =============================================================================
// Daily Snapshot Edge Function
//
// Actions (POST with { action: "..." }):
//   snapshot_current  — returns today's snapshot, generates if missing/stale
//   snapshot_feedback — records yes/no feedback + atomic counter via RPC
//
// ✅ scale-safe (atomic increment RPC with user JWT)
// ✅ gate-aware (subscription → bank → credit)
// ✅ duplicate-avoiding (up to 4 AI retries with hash comparison)
// ✅ robust AI output parsing (JSON-first with fallback)
// =============================================================================

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { decodeJwt } from "@panva/jose";
import { AuthMiddleware, getAuthToken } from "../_shared/jwt/default.ts";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
function ok(data: Record<string, any> = {}): Response {
  return json({ ok: true, ...data });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

// ---------------------------------------------------------------------------
// Supabase clients
// ---------------------------------------------------------------------------
function buildAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

/** Anon client carrying the user's JWT — required for RPC calls that use auth.uid() */
function buildUserClient(token: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") ??
  "claude-sonnet-4-5-20250929";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------
function utcNow(): Date {
  return new Date();
}

function utcNowIso(): string {
  return utcNow().toISOString();
}

function utcToday(): string {
  return utcNow().toISOString().split("T")[0];
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function stableContentHash(
  title: string,
  body: string,
  ctaLabel = "",
  ctaPrompt = "",
): Promise<string> {
  return sha256Hex(
    `${title.trim()}\n${body.trim()}\n${ctaLabel.trim()}\n${ctaPrompt.trim()}`,
  );
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------
function safeStr(v: unknown): string {
  return (v == null ? "" : String(v)).trim();
}

function clampWords(s: string, maxWords: number): string {
  return safeStr(s).split(/\s+/).filter(Boolean).slice(0, maxWords).join(" ");
}

function buildAskPrompt(title: string, body: string, ctaPrompt = ""): string {
  const p = safeStr(ctaPrompt);
  if (p) return p;
  return (
    "Give me 3 quick actions based on today's Daily Snapshot.\n\n" +
    `${body}\n\n` +
    "Keep it short, specific, and focused on what I should do today."
  );
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function isSubscriptionActive(db: any, userId: string): Promise<[boolean, any]> {
  console.log(`[app-snapshot] isSubscriptionActive checking user_id=${userId}`);
  const { data: subs } = await db
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const sub = subs?.[0] ?? null;
  if (!sub) {
    console.log(`[app-snapshot] isSubscriptionActive no subscription row found user_id=${userId}`);
    return [false, null];
  }
  const status = (sub.stripe_status ?? "").toLowerCase().trim();
  const active = status === "active" || status === "trialing";
  console.log(`[app-snapshot] isSubscriptionActive user_id=${userId} stripe_status=${status} active=${active}`);
  return [active, sub];
}

// deno-lint-ignore no-explicit-any
async function isBankConnected(db: any, userId: string): Promise<boolean> {
  console.log(`[app-snapshot] isBankConnected checking user_id=${userId}`);
  const { data: items } = await db
    .from("plaid_items")
    .select("status")
    .eq("user_id", userId);
  if (!items?.length) {
    console.log(`[app-snapshot] isBankConnected no plaid_items found user_id=${userId}`);
    return false;
  }
  for (const it of items) {
    const st = String(it.status || "").toLowerCase();
    if (["connected", "active", "good"].includes(st)) {
      console.log(`[app-snapshot] isBankConnected connected item found status=${st} user_id=${userId}`);
      return true;
    }
  }
  console.log(`[app-snapshot] isBankConnected no active item found user_id=${userId}`);
  return false;
}

// ---------------------------------------------------------------------------
// Snapshot builder (mirrors hutsy/snapshot/builder.py & app-chat getSnapshot)
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function parseJsonField(val: any): any {
  if (!val) return null;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return null;
  }
}

function maskAccounts(
  // deno-lint-ignore no-explicit-any
  accounts: any[],
  itemsLookup: Record<string, string>,
) {
  return accounts.map((a) => {
    const bal = parseJsonField(a.balances) ?? {};
    let availBal = bal.available ?? a.available_balance ?? a.available ?? null;
    let currBal = bal.current ?? a.current_balance ?? a.current ?? availBal;
    const currency =
      bal.iso_currency_code ?? bal.unofficial_currency_code ??
      a.iso_currency_code ?? a.currency ?? null;
    try { if (availBal != null) availBal = parseFloat(availBal); } catch { /**/ }
    try { if (currBal != null) currBal = parseFloat(currBal); } catch { /**/ }
    return {
      bank: itemsLookup[a.item_id] ?? "Bank",
      name: a.name ?? "Account",
      last4: a.mask,
      account_id: a.account_id ?? a.id,
      available_balance: availBal,
      current_balance: currBal,
      currency,
    };
  });
}

// deno-lint-ignore no-explicit-any
function maskTxn(txns: any[], acctLookup: Record<string, any>) {
  return txns.map((t) => {
    let amt = t.amount ?? 0;
    try { amt = parseFloat(amt); } catch { /**/ }
    const acctId = t.account_id;
    const acctMeta = acctId ? (acctLookup[acctId] ?? {}) : {};
    return {
      date: t.date_posted ?? t.date ?? "",
      name: t.name ?? t.merchant_name ?? "Transaction",
      amount: amt,
      currency: t.iso_currency_code ?? t.currency ?? acctMeta.currency ?? null,
      account_id: acctId,
      account_name: acctMeta.name,
      account_last4: acctMeta.last4,
      bank: acctMeta.bank,
      transaction_id: t.transaction_id ?? t.id,
    };
  });
}

// deno-lint-ignore no-explicit-any
async function getSnapshot(db: any, userId: string) {
  console.log(`[app-snapshot] getSnapshot start user_id=${userId}`);
  const [
    { data: profileRows },
    { data: items },
    { data: accounts },
    { data: txns },
    { data: recurring },
  ] = await Promise.all([
    db.from("profiles").select("full_name,email").eq("user_id", userId).limit(1),
    db.from("plaid_items").select("item_id,institution_name").eq("user_id", userId),
    db.from("plaid_accounts").select("*").eq("user_id", userId),
    db.from("plaid_transactions").select("*").eq("user_id", userId)
      .order("date_posted", { ascending: false }).limit(25),
    db.from("plaid_recurring").select("*").eq("user_id", userId),
  ]);

  const profile = profileRows?.[0] ?? null;

  const itemsLookup: Record<string, string> = {};
  for (const it of items ?? []) {
    itemsLookup[it.item_id] = it.institution_name ?? "Bank";
  }

  const maskedAccounts = maskAccounts(accounts ?? [], itemsLookup);
  // deno-lint-ignore no-explicit-any
  const acctLookup: Record<string, any> = {};
  for (const a of maskedAccounts) {
    if (a.account_id) {
      acctLookup[a.account_id] = { name: a.name, last4: a.last4, currency: a.currency, bank: a.bank };
    }
  }

  const maskedTx = maskTxn(txns ?? [], acctLookup);

  const outflows: Array<{ label: string; amount: unknown; next_date: string | null }> = [];
  for (const r of recurring ?? []) {
    const arr = parseJsonField(r.outflow_streams) ?? [];
    const streams = Array.isArray(arr) ? arr : [arr];
    for (const o of streams) {
      const avg = o.average_amount ?? {};
      outflows.push({
        label: o.merchant_name ?? o.description ?? "Bill",
        amount: avg.amount,
        next_date: o.predicted_next_date ?? null,
      });
    }
  }
  outflows.sort((a, b) =>
    (a.next_date ?? "9999-12-31").localeCompare(b.next_date ?? "9999-12-31")
  );
  const nextBill = outflows[0] ?? { label: "Bill", amount: "0", next_date: "N/A" };

  const defaultCurrency = maskedAccounts.find((a) => a.currency)?.currency ?? "CAD";
  const outgoingTotal = outflows.reduce(
    (acc, b) => acc + (parseFloat(String(b.amount ?? 0)) || 0),
    0,
  );

  console.log(`[app-snapshot] getSnapshot done user_id=${userId} accounts=${maskedAccounts.length} txns=${maskedTx.length} outflows=${outflows.length}`);
  return {
    profile: { full_name: profile?.full_name ?? "Hutsy member", email: profile?.email ?? null },
    masked_accounts: maskedAccounts,
    transactions: maskedTx,
    recurring_outflows: outflows,
    next_bill: nextBill,
    outgoing_total: outgoingTotal.toFixed(2),
    default_currency: defaultCurrency,
  };
}

// ---------------------------------------------------------------------------
// AI card generation
// ---------------------------------------------------------------------------

const ALLOWED_CATEGORIES = new Set([
  "utilization_alert",
  "cash_flow_warning",
  "credit_timing",
  "subscription_drift",
  "general_tip",
  "gate_subscription",
  "gate_bank",
]);

interface SnapshotCard {
  title: string;
  category: string;
  body: string;
  cta_label: string;
  cta_prompt: string;
}

function buildAiPrompt(
  prevHash: string,
  facts: { subscription_active: boolean; bank_connected: boolean },
): string {
  return `
You are generating ONE daily snapshot card for a premium fintech app called Hutsy.

You MUST output valid JSON only (no markdown, no backticks), in this exact schema:
{
  "title": "string (max 80 chars)",
  "category": "one of: utilization_alert, cash_flow_warning, subscription_drift, general_tip",
  "body": "string (max 260 chars). MUST be a single, smooth, conversational paragraph. Do NOT use line breaks, bullet points, or prefixes like 'ACTION:'.",
  "cta_label": "string (2–5 words, max 22 chars)",
  "cta_prompt": "string (max 220 chars). A chat follow-up request that previews or explains, NOT taking actions."
}

HARD FACTS (must be respected):
- subscription_active: ${facts.subscription_active}
- bank_connected: ${facts.bank_connected}

FORBIDDEN:
- If bank_connected is true: DO NOT suggest connecting a bank, DO NOT mention 'Connect Bank', DO NOT imply bank is missing.
- No generic filler. No disclaimers. No "sync your picture" unless you reference a real missing piece.
- Do not mention hashes, prompts, internal logic, or "JSON".

Style:
- Confident, specific, helpful for today.
- Prioritize real cash flow, balances, bills, spending patterns, and spending insights.
- If you mention an action, make it something the user can do in-app right now.

Uniqueness:
- Previous content hash: ${prevHash || "NONE"}.
- Today must feel meaningfully different.

Now produce the JSON ONLY:
`.trim();
}

function extractFirstJsonObject(text: string): string {
  let raw = (text ?? "").trim();
  if (!raw) return "";

  raw = raw.replace(/^```[a-zA-Z]*\s*/m, "").replace(/\s*```$/m, "").trim();
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;

  const start = raw.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return "";
}

function parseAiJson(text: string): SnapshotCard {
  const extracted = extractFirstJsonObject((text ?? "").trim());

  if (extracted) {
    try {
      const obj = JSON.parse(extracted);
      if (obj && typeof obj === "object") {
        let category = safeStr(obj.category).slice(0, 40);
        let body = safeStr(obj.body).slice(0, 420);
        let ctaLabel = safeStr(obj.cta_label).slice(0, 22);
        let ctaPrompt = safeStr(obj.cta_prompt).slice(0, 220);

        if (!ALLOWED_CATEGORIES.has(category)) category = "general_tip";
        body = body.replace(/```/g, "").trim();
        if (!body) body = "Your snapshot is ready.\nOpen chat to see what matters.\nTap below to continue.";
        if (!ctaLabel) ctaLabel = "See details";
        ctaLabel = clampWords(ctaLabel, 5).slice(0, 22);
        if (!ctaPrompt) ctaPrompt = `Explain today's snapshot and show the best next step.\n\n${body}`;

        return {
          title: safeStr(obj.title).slice(0, 80) || "Daily snapshot",
          category,
          body,
          cta_label: ctaLabel,
          cta_prompt: ctaPrompt,
        };
      }
    } catch { /* fall through to fallback */ }
  }

  // Fallback — strip any JSON dump artifacts
  let cleaned = (text ?? "")
    .replace(/```[a-zA-Z]*/g, "")
    .replace(/```/g, "")
    .replace(/\n/g, " ")
    .trim();

  const low = cleaned.toLowerCase();
  if (
    (low.startsWith("{") && low.includes('"title"') && low.includes('"body"')) ||
    (low.includes('"category"') && low.includes('"body"') && cleaned.length < 1200)
  ) {
    cleaned = "";
  }

  const body = cleaned.slice(0, 420).trim() ||
    "Your snapshot is ready.\nTap below to see what matters.\nLet's pick one move for today.";

  return {
    title: "Daily snapshot",
    category: "general_tip",
    body,
    cta_label: "See details",
    cta_prompt: "Based on today's snapshot, give me the best next step and 3 quick actions.",
  };
}

async function anthropicMessage(prompt: string, snapshotCtx: unknown): Promise<string> {
  console.log("[app-snapshot] anthropicMessage calling Anthropic API");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.warn("[app-snapshot] anthropicMessage ANTHROPIC_API_KEY not set, returning empty");
    return "";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 500,
      system: "You are a daily financial card generator for Hutsy. Output valid JSON only. No markdown, no backticks.",
      messages: [{
        role: "user",
        content: `${prompt}\n\nUser financial data (ground truth for your card):\n${JSON.stringify(snapshotCtx)}`,
      }],
    }),
  });
  const j = await res.json();
  const text = (j.content?.[0]?.text ?? "").trim();
  console.log(`[app-snapshot] anthropicMessage response length=${text.length}`);
  return text;
}

async function generateDailyCard(
  // deno-lint-ignore no-explicit-any
  snapshotCtx: any,
  prevHash: string,
  facts: { subscription_active: boolean; bank_connected: boolean },
): Promise<SnapshotCard> {
  console.log(`[app-snapshot] generateDailyCard start prev_hash=${prevHash || "none"} sub_active=${facts.subscription_active} bank_connected=${facts.bank_connected}`);
  const prompt = buildAiPrompt(prevHash, facts);
  const text = await anthropicMessage(prompt, snapshotCtx);
  const card = parseAiJson(text);
  console.log(`[app-snapshot] generateDailyCard done category=${card.category} title_length=${card.title.length}`);
  return card;
}

// ---------------------------------------------------------------------------
// Snapshot validation helpers
// ---------------------------------------------------------------------------
function looksLikeBadJsonDump(s: string): boolean {
  const t = safeStr(s).toLowerCase();
  if (!t) return true;
  if (t.includes("```")) return true;
  if (t.startsWith("{") && t.includes('"title"') && t.includes('"body"')) return true;
  if (t.includes('"category"') && t.includes('"body"') && t.length < 1200) return true;
  return false;
}

// deno-lint-ignore no-explicit-any
function isRowValidForToday(row: any): boolean {
  if (!row) return false;
  if (safeStr(row.generated_for_day) !== utcToday()) return false;
  const title = safeStr(row.title);
  const body = safeStr(row.body);
  if (!title || !body) return false;
  if (looksLikeBadJsonDump(body)) return false;
  return true;
}

// deno-lint-ignore no-explicit-any
function ensureAskPrompt(row: any): any {
  if (!safeStr(row?.ask_prompt)) {
    row.ask_prompt = buildAskPrompt(
      safeStr(row?.title) || "Daily snapshot",
      safeStr(row?.body) || "Snapshot ready.",
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Gate payload builder
// ---------------------------------------------------------------------------
async function payloadForGate(
  userId: string,
  category: string,
  title: string,
  body: string,
  // deno-lint-ignore no-explicit-any
): Promise<Record<string, any>> {
  const ctaLabel = "See steps";
  const ctaPrompt = `Help me fix this: ${title}. Explain what I should do next.`;
  const h = await stableContentHash(title, body, ctaLabel, ctaPrompt);
  return {
    user_id: userId,
    title,
    body,
    category,
    cta_label: ctaLabel,
    cta_prompt: ctaPrompt,
    generated_for_day: utcToday(),
    content_hash: h,
    ask_prompt: buildAskPrompt(title, body, ctaPrompt),
    generated_at: utcNowIso(),
  };
}

// ---------------------------------------------------------------------------
// Build + store today's snapshot
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function getPrevHash(db: any, userId: string): Promise<string> {
  const { data: rows } = await db
    .from("snapshot_current")
    .select("content_hash")
    .eq("user_id", userId)
    .limit(1);
  return safeStr(rows?.[0]?.content_hash);
}

// deno-lint-ignore no-explicit-any
async function buildAndStoreToday(db: any, userId: string): Promise<Record<string, any>> {
  console.log(`[app-snapshot] buildAndStoreToday start user_id=${userId}`);
  // 1) Subscription gate
  const [subActive] = await isSubscriptionActive(db, userId);
  if (!subActive) {
    console.log(`[app-snapshot] buildAndStoreToday subscription gate hit user_id=${userId}`);
    const payload = await payloadForGate(
      userId,
      "gate_subscription",
      "Action needed",
      "Your plan is not active. Update payment to receive daily snapshots.",
    );
    await db.from("snapshot_current").upsert(payload, { onConflict: "user_id" });
    console.log(`[app-snapshot] buildAndStoreToday gate_subscription payload stored user_id=${userId}`);
    return payload;
  }

  // 2) Bank gate — never cache, always re-check on next request
  if (!(await isBankConnected(db, userId))) {
    console.log(`[app-snapshot] buildAndStoreToday bank gate hit user_id=${userId}`);
    return await payloadForGate(
      userId,
      "gate_bank",
      "Connect your bank",
      "Connect your bank to unlock balances, bills, and daily alerts.",
    );
  }

  // 3) AI snapshot
  console.log(`[app-snapshot] buildAndStoreToday building AI snapshot user_id=${userId}`);
  const snapshotCtx = await getSnapshot(db, userId);
  const prevHash = await getPrevHash(db, userId);
  console.log(`[app-snapshot] buildAndStoreToday prev_hash=${prevHash || "none"} user_id=${userId}`);
  const facts = { subscription_active: true, bank_connected: true };

  // deno-lint-ignore no-explicit-any
  let lastPayload: Record<string, any> | null = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    console.log(`[app-snapshot] buildAndStoreToday AI card attempt=${attempt + 1} user_id=${userId}`);
    const card = await generateDailyCard(snapshotCtx, prevHash, facts);

    const h = await stableContentHash(
      card.title,
      card.body,
      card.cta_label,
      card.cta_prompt,
    );
    console.log(`[app-snapshot] buildAndStoreToday attempt=${attempt + 1} new_hash=${h} prev_hash=${prevHash || "none"} hash_changed=${h !== prevHash}`);

    lastPayload = {
      user_id: userId,
      title: card.title,
      body: card.body,
      category: card.category,
      cta_label: card.cta_label,
      cta_prompt: card.cta_prompt,
      generated_for_day: utcToday(),
      content_hash: h,
      ask_prompt: buildAskPrompt(card.title, card.body, card.cta_prompt),
      generated_at: utcNowIso(),
    };

    // Break as soon as we have a new hash (or there was no prior hash to compare)
    if (!prevHash || h !== prevHash) break;
  }

  // Safety fallback — should never be reached
  if (!lastPayload) {
    const title = "Daily snapshot";
    const body = "Your snapshot is ready. Open chat and ask for the top 3 moves for today.";
    lastPayload = {
      user_id: userId,
      title,
      body,
      category: "general_tip",
      generated_for_day: utcToday(),
      content_hash: await stableContentHash(title, body),
      ask_prompt: buildAskPrompt(title, body),
      generated_at: utcNowIso(),
    };
  }

  console.log(`[app-snapshot] buildAndStoreToday upserting snapshot user_id=${userId} category=${lastPayload?.category}`);
  await db.from("snapshot_current").upsert(lastPayload, { onConflict: "user_id" });
  console.log(`[app-snapshot] buildAndStoreToday snapshot stored user_id=${userId}`);
  return lastPayload;
}

// ---------------------------------------------------------------------------
// Optional anti-mismatch guard for feedback
// ---------------------------------------------------------------------------
async function optionalMatchGuard(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  providedDay: string,
  providedHash: string,
): Promise<boolean> {
  if (!providedDay && !providedHash) return true;

  const { data: rows } = await db
    .from("snapshot_current")
    .select("generated_for_day,content_hash")
    .eq("user_id", userId)
    .limit(1);

  const cur = rows?.[0] ?? {};
  const curDay = safeStr(cur.generated_for_day);
  const curHash = safeStr(cur.content_hash);

  if (providedDay && curDay && providedDay !== curDay) return false;
  if (providedHash && curHash && providedHash !== curHash) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/**
 * snapshot_current
 * Returns today's snapshot. Generates (and stores) a new one if missing or stale.
 */
// deno-lint-ignore no-explicit-any
async function handleSnapshotCurrent(db: any, userId: string): Promise<Response> {
  console.log(`[app-snapshot] handleSnapshotCurrent start user_id=${userId}`);
  // Read current row
  const { data: rows } = await db
    .from("snapshot_current")
    .select("*")
    .eq("user_id", userId)
    .limit(1);

  const row = rows?.[0] ?? null;
  const isGateRow = (r: any) => String(r?.category ?? "").startsWith("gate_");

  console.log(`[app-snapshot] handleSnapshotCurrent cached_row=${!!row} valid_for_today=${row ? isRowValidForToday(row) : false} is_gate=${row ? isGateRow(row) : false}`);
  // Serve cached row only if valid for today AND not a stale gate response
  if (row && isRowValidForToday(row) && !isGateRow(row)) {
    console.log(`[app-snapshot] handleSnapshotCurrent serving cached snapshot user_id=${userId}`);
    return ok({ snapshot: ensureAskPrompt(row) });
  }

  // Build today's snapshot (gate responses are no longer written to DB)
  console.log(`[app-snapshot] handleSnapshotCurrent building fresh snapshot user_id=${userId}`);
  const payload = await buildAndStoreToday(db, userId);

  // If gate response, return it directly (no DB row to re-read)
  if (isGateRow(payload)) {
    console.log(`[app-snapshot] handleSnapshotCurrent returning gate payload category=${payload.category} user_id=${userId}`);
    return ok({ snapshot: ensureAskPrompt(payload) });
  }

  // Re-read real snapshot as source of truth
  const { data: rows2 } = await db
    .from("snapshot_current")
    .select("*")
    .eq("user_id", userId)
    .limit(1);

  console.log(`[app-snapshot] handleSnapshotCurrent returning fresh snapshot user_id=${userId}`);
  return ok({ snapshot: ensureAskPrompt(rows2?.[0] ?? payload) });
}

/**
 * snapshot_feedback
 * Records yes/no feedback on the current snapshot.
 *
 * Body:
 *   { feedback: "yes"|"no", day?: "YYYY-MM-DD", content_hash?: "..." }
 *   OR
 *   { choice: "yes"|"no", ... }
 */
async function handleSnapshotFeedback(
  req: Request,
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  // deno-lint-ignore no-explicit-any
  body: any,
): Promise<Response> {
  // Accept either "feedback" or "choice" field
  const choice = safeStr(body.choice || body.feedback).toLowerCase();
  console.log(`[app-snapshot] handleSnapshotFeedback start user_id=${userId} choice=${choice}`);
  if (choice !== "yes" && choice !== "no") {
    console.warn(`[app-snapshot] handleSnapshotFeedback invalid choice="${choice}" user_id=${userId}`);
    return err("feedback must be 'yes' or 'no'");
  }

  const providedDay = safeStr(body.day);
  const providedHash = safeStr(body.content_hash);
  console.log(`[app-snapshot] handleSnapshotFeedback provided_day=${providedDay || "none"} provided_hash=${providedHash || "none"}`);

  // Guard: skip counter bump if client day/hash doesn't match current snapshot
  const matched = await optionalMatchGuard(db, userId, providedDay, providedHash);
  if (!matched) {
    console.log(`[app-snapshot] handleSnapshotFeedback snapshot mismatch, ignoring user_id=${userId}`);
    return ok({ ignored: true, reason: "snapshot_mismatch" });
  }

  const nowIso = utcNowIso();

  // 1) Update feedback fields on snapshot_current (service role)
  console.log(`[app-snapshot] handleSnapshotFeedback updating last_feedback=${choice} user_id=${userId}`);
  await db
    .from("snapshot_current")
    .update({ last_feedback: choice, last_feedback_at: nowIso })
    .eq("user_id", userId);

  // 2) Atomic counter bump via RPC — must run under the user's JWT so auth.uid() resolves
  console.log(`[app-snapshot] handleSnapshotFeedback calling bump_snapshot_feedback RPC choice=${choice} user_id=${userId}`);
  const token = getAuthToken(req);
  const userClient = buildUserClient(token);
  const { error: rpcErr } = await userClient
    .rpc("bump_snapshot_feedback", { choice });

  if (rpcErr) {
    console.error("[app-snapshot] bump_snapshot_feedback RPC error:", rpcErr);
    return err(`feedback rpc failed: ${rpcErr.message}`, 500);
  }

  console.log(`[app-snapshot] handleSnapshotFeedback success choice=${choice} user_id=${userId}`);
  return ok({ choice });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve((req) =>
  AuthMiddleware(req, async (req) => {
    if (req.method !== "POST") return err("method_not_allowed", 405);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return err("invalid_json");
    }

    const token = getAuthToken(req);
    const { sub: userId } = decodeJwt(token);
    if (!userId) return err("invalid_token", 401);

    const db = buildAdminClient();
    const action = String(body.action ?? "");

    console.log(`[app-snapshot] action=${action} user_id=${userId}`);

    try {
      switch (action) {
        case "snapshot_current":
          return await handleSnapshotCurrent(db, userId);
        case "snapshot_feedback":
          return await handleSnapshotFeedback(req, db, userId, body);
        default:
          return err(`unknown action: ${action || "(none)"}`);
      }
    } catch (e) {
      console.error(`[app-snapshot] action=${action} error:`, e);
      return err(e instanceof Error ? e.message : "internal_error", 500);
    }
  })
);
