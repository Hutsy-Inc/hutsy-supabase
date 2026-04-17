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
// Supabase admin client
// ---------------------------------------------------------------------------
function buildAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const NPS_COOLDOWN_DAYS = parseInt(Deno.env.get("NPS_COOLDOWN_DAYS") ?? "5");
const NPS_AFTER_MESSAGES = parseInt(Deno.env.get("NPS_AFTER_MESSAGES") ?? "3");
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

function parseDt(s: string | null | undefined): Date | null {
  if (!s) return null;
  try {
    const d = new Date(String(s).trim().replace(/Z$/, "+00:00"));
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shape helper — mirrors Python _shape()
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function shape(row: any, fallbackRole: string, fallbackBody: string) {
  if (!row) {
    return {
      id: `fallback_${Date.now()}`,
      role: fallbackRole,
      body: fallbackBody,
      created_at: utcNowIso(),
      channel: "app",
    };
  }
  return {
    id: row.id,
    role: row.role,
    body: row.body,
    created_at: row.created_at,
    channel: row.channel,
  };
}

// ---------------------------------------------------------------------------
// AI consent helpers (Apple Guideline 5.1.1 / 5.1.2)
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function readAiConsent(req: Request, data: any): string {
  const h = (req.headers.get("x-ai-consent") ?? "").trim().toLowerCase();
  if (h === "granted" || h === "deferred") return h;
  const b = (String(data?.ai_consent ?? "")).trim().toLowerCase();
  if (b === "granted" || b === "deferred") return b;
  return "unknown";
}

function aiConsentBlockReply(): string {
  return (
    "To use Hutsy's AI insights, please tap Allow on the AI data permission prompt.\n\n" +
    "If you selected Not now earlier, the prompt will appear again so you can continue."
  );
}

// ---------------------------------------------------------------------------
// Chat settings (logging toggle)
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function getChatSettings(db: any): Promise<{ enabled: boolean }> {
  try {
    const { data } = await db
      .from("chat_settings")
      .select("enabled")
      .limit(1)
      .single();
    return { enabled: data?.enabled ?? true };
  } catch {
    return { enabled: true };
  }
}

// ---------------------------------------------------------------------------
// Chat message logging
// ---------------------------------------------------------------------------
async function insertChatMessage(
  // deno-lint-ignore no-explicit-any
  db: any,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  try {
    const { data } = await db
      .from("chat_messages")
      .insert(payload)
      .select()
      .single();
    return data;
  } catch (e) {
    console.error("[app-chat] insertChatMessage error:", e);
    return null;
  }
}

async function insertUserMessage(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  msg: string,
  localId: string | null,
  deviceId: string | null,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const body = msg.length <= 4000 ? msg : msg.slice(0, 4000) + "…";
  const meta: Record<string, unknown> = { source: "app" };
  if (localId) meta.local_id = localId;
  if (deviceId) meta.device_id = deviceId;
  return insertChatMessage(db, {
    user_id: userId,
    channel: "app",
    role: "user",
    direction: "in",
    body,
    wa_from: deviceId ?? null,
    wa_message_id: null,
    meta,
  });
}

async function insertAssistantMessage(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  text: string,
  localId: string | null,
  deviceId: string | null,
  metaExtra: Record<string, unknown> = {},
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const body = text.length <= 4000 ? text : text.slice(0, 4000) + "…";
  const meta: Record<string, unknown> = { source: "app", ...metaExtra };
  if (localId) meta.reply_to_local_id = localId;
  if (deviceId) meta.device_id = deviceId;
  return insertChatMessage(db, {
    user_id: userId,
    channel: "app",
    role: "assistant",
    direction: "out",
    body,
    wa_from: deviceId ?? null,
    wa_message_id: null,
    meta,
  });
}

// Build conversation history from recent DB messages (replaces in-memory session)
// deno-lint-ignore no-explicit-any
async function buildHistory(db: any, userId: string): Promise<string> {
  try {
    const cutoff = new Date(utcNow().getTime() - 30 * 60 * 1000).toISOString();
    const { data: rows } = await db
      .from("chat_messages")
      .select("role,body")
      .eq("user_id", userId)
      .eq("channel", "app")
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!rows?.length) return "";
    return rows
      .reverse()
      .map((r: { role: string; body: string }) =>
        `${r.role === "user" ? "user" : "bot"}: ${r.body}`
      )
      .join("\n");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// NPS helpers
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function getLatestNps(db: any, userId: string): Promise<any> {
  const { data } = await db
    .from("nps_surveys")
    .select("*")
    .eq("user_id", userId)
    .order("core_value_sent_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function getLastNpsSentDt(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
): Promise<Date | null> {
  let lastDt: Date | null = null;

  try {
    const { data } = await db
      .from("profiles")
      .select("nps_sent_at")
      .eq("user_id", userId)
      .limit(1);
    const p = parseDt(data?.[0]?.nps_sent_at);
    if (p) lastDt = p;
  } catch { /* ignore */ }

  try {
    const { data } = await db
      .from("nps_surveys")
      .select("nps_sent_at")
      .eq("user_id", userId)
      .not("nps_sent_at", "is", null)
      .order("nps_sent_at", { ascending: false })
      .limit(1);
    const sdt = parseDt(data?.[0]?.nps_sent_at);
    if (sdt && (lastDt === null || sdt > lastDt)) lastDt = sdt;
  } catch { /* ignore */ }

  return lastDt;
}

// deno-lint-ignore no-explicit-any
async function cooldownOk(db: any, userId: string): Promise<boolean> {
  const last = await getLastNpsSentDt(db, userId);
  if (!last) return true;
  return utcNow().getTime() - last.getTime() >= NPS_COOLDOWN_DAYS * 86_400_000;
}

// deno-lint-ignore no-explicit-any
async function ensureScheduledNps(db: any, userId: string): Promise<any> {
  const latest = await getLatestNps(db, userId);
  if (
    latest &&
    ["scheduled", "pending_score", "pending_feedback"].includes(latest.status)
  ) return latest;

  if (!(await cooldownOk(db, userId))) return latest;

  const nowIso = utcNowIso();
  const cohort = utcNow().toISOString().split("T")[0];

  const { data: profRows } = await db
    .from("profiles")
    .select("activated_at,activation_cohort,first_core_value_type")
    .eq("user_id", userId)
    .limit(1);
  const prof = profRows?.[0] ?? {};

  const payload = {
    user_id: userId,
    activated_at: prof.activated_at ?? nowIso,
    activation_cohort: prof.activation_cohort ?? cohort,
    first_core_value_type: prof.first_core_value_type ?? "app_chat",
    core_value_sent_at: nowIso,
    status: "scheduled",
    time_since_activation_seconds: 0,
  };

  const { data: created } = await db
    .from("nps_surveys")
    .insert(payload)
    .select();
  return created?.[0] ?? payload;
}

function buildNpsPopupPayload(
  stage: string,
  name: string,
  surveyId: string,
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
  const title = name.trim()
    ? `Quick question, ${name.trim()} 👋`
    : "Quick question 👋";
  if (stage === "score") {
    return {
      ui: "popup",
      stage: "score",
      survey_id: surveyId,
      title,
      description:
        "How likely are you to recommend Hutsy to a friend or family member?",
      min: 0,
      max: 10,
      minLabel: "Not likely",
      maxLabel: "Extremely likely",
    };
  }
  return {
    ui: "popup",
    stage: "feedback",
    survey_id: surveyId,
    title: "Tell us more",
    description: "What's the main reason for that score?",
    placeholder: "Write your feedback…",
    minChars: 1,
    maxChars: 500,
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------
async function isSubscriptionActive(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  // deno-lint-ignore no-explicit-any
): Promise<[boolean, any]> {
  const { data: subs } = await db
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  const sub = subs?.[0] ?? null;
  if (!sub) return [false, null];
  const status = (sub.stripe_status ?? "").toLowerCase().trim();
  return [status === "active" || status === "trialing", sub];
}

// deno-lint-ignore no-explicit-any
async function isBankConnected(db: any, userId: string): Promise<boolean> {
  const { data: items } = await db
    .from("plaid_items")
    .select("status")
    .eq("user_id", userId);
  if (!items?.length) return false;
  for (const it of items) {
    const st = String(it.status || "").toLowerCase();
    if (["connected", "active", "good"].includes(st)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Snapshot builder — mirrors hutsy/snapshot/builder.py
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
    const currency = bal.iso_currency_code ??
      bal.unofficial_currency_code ??
      a.iso_currency_code ??
      a.currency ??
      null;
    try {
      if (availBal != null) availBal = parseFloat(availBal);
    } catch { /* */ }
    try {
      if (currBal != null) currBal = parseFloat(currBal);
    } catch { /* */ }
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
    try {
      amt = parseFloat(amt);
    } catch { /* */ }
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
  const [
    { data: profileRows },
    { data: items },
    { data: accounts },
    { data: txns },
    { data: recurring },
  ] = await Promise.all([
    db.from("profiles").select("full_name,email").eq("user_id", userId).limit(
      1,
    ),
    db.from("plaid_items").select("item_id,institution_name").eq(
      "user_id",
      userId,
    ),
    db.from("plaid_accounts").select("*").eq("user_id", userId),
    db
      .from("plaid_transactions")
      .select("*")
      .eq("user_id", userId)
      .order("date_posted", { ascending: false })
      .limit(25),
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
      acctLookup[a.account_id] = {
        name: a.name,
        last4: a.last4,
        currency: a.currency,
        bank: a.bank,
      };
    }
  }

  const maskedTx = maskTxn(txns ?? [], acctLookup);

  // Recurring outflows
  const outflows: Array<
    { label: string; amount: unknown; next_date: string | null }
  > = [];
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
  const nextBill = outflows[0] ??
    { label: "Bill", amount: "0", next_date: "N/A" };

  const defaultCurrency = maskedAccounts.find((a) => a.currency)?.currency ??
    "CAD";
  const outgoingTotal = outflows.reduce(
    (acc, b) => acc + (parseFloat(String(b.amount ?? 0)) || 0),
    0,
  );

  return {
    profile: {
      full_name: profile?.full_name ?? "Hutsy member",
      email: profile?.email ?? null,
    },
    masked_accounts: maskedAccounts,
    transactions: maskedTx,
    recurring_outflows: outflows,
    next_bill: nextBill,
    outgoing_total: outgoingTotal.toFixed(2),
    default_currency: defaultCurrency,
  };
}

// ---------------------------------------------------------------------------
// AI Agent — mirrors hutsy/chat/agent.py
// ---------------------------------------------------------------------------
const SENSITIVE_KEYS = [
  "ssn",
  "social",
  "birth",
  "dob",
  "address",
  "street",
  "postal",
  "zip",
  "email",
  "phone",
  "employer",
  "company",
  "raw",
  "credit_response",
  "private_key",
  "client_email",
];

// deno-lint-ignore no-explicit-any
function redactDeep(obj: any): any {
  if (Array.isArray(obj)) return obj.map(redactDeep);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) continue;
      out[k] = redactDeep(v);
    }
    return out;
  }
  return obj;
}

// deno-lint-ignore no-explicit-any
function hasBankData(snapshot: any): boolean {
  return !!(snapshot.masked_accounts?.length || snapshot.transactions?.length);
}

// deno-lint-ignore no-explicit-any
function safeBankPayload(snapshot: any) {
  const ccy = snapshot.default_currency ?? "USD";
  return redactDeep({
    connected: hasBankData(snapshot),
    default_currency: ccy,
    // deno-lint-ignore no-explicit-any
    accounts: (snapshot.masked_accounts ?? []).slice(0, 12).map((a: any) => ({
      bank: a.bank,
      name: a.name,
      last4: a.last4,
      available_balance: a.available_balance,
      current_balance: a.current_balance,
      currency: a.currency ?? ccy,
    })),
    // deno-lint-ignore no-explicit-any
    recent_transactions: (snapshot.transactions ?? []).slice(0, 20).map((
      t: any,
    ) => ({
      date: t.date,
      name: t.name,
      amount: t.amount,
      currency: t.currency ?? ccy,
      account_last4: t.account_last4,
      bank: t.bank,
    })),
    // deno-lint-ignore no-explicit-any
    upcoming_bills: (snapshot.recurring_outflows ?? []).slice(0, 15).map((
      b: any,
    ) => ({
      label: b.label,
      amount: b.amount,
      next_date: b.next_date,
      currency: ccy,
    })),
    next_bill: snapshot.next_bill,
    outgoing_total: snapshot.outgoing_total,
  });
}

// deno-lint-ignore no-explicit-any
function safeSubscriptionPayload(subRow: any) {
  if (!subRow) return { is_active: false, stripe_status: "none" };
  const status = (subRow.stripe_status ?? "").toLowerCase();
  return redactDeep({
    is_active: status === "active" || status === "trialing",
    stripe_status: status || "unknown",
    plan: subRow.plan,
    interval: subRow.interval,
    next_renewal: subRow.next_renewal,
  });
}

async function anthropicMessage(
  system: string,
  userContent: string,
  maxTokens = 850,
): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return "AI is not configured (missing ANTHROPIC_API_KEY).";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  const j = await res.json();
  return (j.content?.[0]?.text ?? "").trim();
}

// deno-lint-ignore no-explicit-any
function jsonLooseParse(txt: string): Record<string, any> | null {
  if (!txt) return null;
  const t = txt.trim();
  if (t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch { /* */ }
  }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch { /* */ }
  }
  return null;
}

const ALLOWED_MODES = new Set(["normal", "roast", "hype", "cooked"]);
function normalizeMode(mode: unknown): string {
  const m = String(mode ?? "").trim().toLowerCase();
  return ALLOWED_MODES.has(m) ? m : "normal";
}

function firstName(fullName: string): string {
  return (fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

// ── Chat mode system prompts ─────────────────────────────────────────────────
const NORMAL_SYSTEM = `You are Hutsy, a friendly finance assistant.

Tone:
- Calm, clear, supportive, non-judgmental
- No slang overload, no roasting
- Avoid long paragraphs

Hard rules:
- Output MUST be plain text only (the app does not render markdown).
- Do NOT use markdown, code blocks, tables with pipes, backticks, or formatting markers like ** or *.
- Use bullets with the "•" character only when helpful.
- Keep answers grounded in the provided SAFE DATA only. Never invent numbers.
- Never reveal or guess sensitive identifiers (SSN/DOB/address/email/phone).

Behavior:
- Be practical and grounded in the user's SAFE DATA
- Don't lecture; give 1–2 useful insights max if data is limited`;

const ROAST_SYSTEM = `You are Hutsy, a playful roast-style finance assistant.

Tone:
- Light teasing, witty, never mean
- No insults about identity, appearance, or sensitive topics
- The goal is motivation through humor

Hard rules:
- Output MUST be plain text only (the app does not render markdown).
- Do NOT use markdown, code blocks, tables with pipes, backticks, or formatting markers like ** or *.
- Use bullets with the "•" character only when helpful.
- Stay grounded in the provided SAFE DATA only. Never invent numbers.
- Never reveal or guess sensitive identifiers (SSN/DOB/address/email/phone).
- Do NOT insult protected attributes. Keep it about choices/behavior, not identity.

Behavior:
- Roast the behavior, not the person
- Keep it safe; avoid harsh language
- Always pivot to a helpful next step`;

const HYPE_SYSTEM = `You are Hutsy, a high-energy finance coach.

Tone:
- Motivating, upbeat, confident
- Use light excitement (but don't be cringe)
- Celebrate small wins

Hard rules:
- Output MUST be plain text only (the app does not render markdown).
- Do NOT use markdown, code blocks, tables with pipes, backticks, or formatting markers like ** or *.
- Use bullets with the "•" character only when helpful.
- Stay grounded in the provided SAFE DATA only. Never invent numbers.
- Never reveal or guess sensitive identifiers (SSN/DOB/address/email/phone).

Behavior:
- Keep advice short and actionable
- If the user is improving (lower spend, higher score, paid bills), call it out
- Never shame the user`;

const BASE_RESPONDER_SYSTEM =
  `You are Hutsy's finance assistant. You are not a lender. You do not approve/decline loans.

Be concise: 3–6 short sentences OR up to 4 bullets. One message.

CRITICAL: End EVERY reply with exactly ONE short, relevant open-ended question that naturally continues the topic. Do NOT ask multiple questions.

Privacy and truth rules:
- Never reveal or invent personal identifiers (SSN/DOB/address/email/phone).
- Never claim you can see data that is not in SAFE DATA.`;

async function agentPlan(
  userMsg: string,
  history: string,
  mode: string,
  // deno-lint-ignore no-explicit-any
): Promise<Record<string, any>> {
  const system =
    "You are a planner for a finance assistant. Return ONLY valid JSON. No markdown, no extra text.";
  const user = [
    `Conversation history:\n${history}`,
    `\nUser message:\n${userMsg}`,
    `\nSession context:\n${JSON.stringify({ mode })}`,
    `\nReturn JSON:\n{\n  "needs": "bank" | "none",`,
    `  "task": "one short label",`,
    `  "focus_account_last4": "1234 or null",`,
    `  "clarifying_question": "string or null"\n}`,
    `\nRules:`,
    `- Infer needs from the user's intent.`,
    `- Choose "bank" if the request requires account/transaction/bill data.`,
    `- Choose "none" for general coaching not requiring any user data.`,
    `- Only ask clarifying_question if truly required (short).`,
  ].join("\n");

  const txt = await anthropicMessage(system, user, 240);
  const plan = jsonLooseParse(txt) ?? {};
  if (!["bank", "none"].includes(plan.needs as string)) {
    plan.needs = "bank";
  }
  plan.clarifying_question ??= null;
  plan.focus_account_last4 ??= null;
  plan.task ??= "general";
  return plan;
}

async function agentChatApp(
  userMsg: string,
  // deno-lint-ignore no-explicit-any
  snapshot: any,
  history: string,
  mode: string,
  // deno-lint-ignore no-explicit-any
  subRow: any,
): Promise<string> {
  const fallback =
    "I can help with balances, bills, transactions, and credit insights. What do you want to check?";

  // deno-lint-ignore no-explicit-any
  let plan: Record<string, any>;
  try {
    plan = await agentPlan(userMsg, history, mode);
  } catch (e) {
    console.error("[app-chat] agentPlan error:", e);
    plan = {
      needs: "both",
      clarifying_question: null,
      focus_account_last4: null,
      task: "fallback",
    };
  }

  const cq = plan.clarifying_question;
  if (cq) return String(cq);

  const needs = String(plan.needs ?? "bank");
  const safeData = {
    profile: { name: firstName(snapshot.profile?.full_name ?? "") },
    subscription: safeSubscriptionPayload(subRow),
    connections: {
      bank_connected: hasBankData(snapshot),
    },
    bank: needs === "bank"
      ? safeBankPayload(snapshot)
      : null,
    focus_account_last4: plan.focus_account_last4,
    session: { mode },
  };

  let toneSystem = NORMAL_SYSTEM;
  if (mode === "roast") toneSystem = ROAST_SYSTEM;
  else if (mode === "hype") toneSystem = HYPE_SYSTEM;

  const system = `${toneSystem}\n\n${BASE_RESPONDER_SYSTEM}`;
  const userContent = [
    `Conversation history:\n${history}`,
    `\nUser message:\n${userMsg}`,
    `\nSession context:\n${JSON.stringify({ mode })}`,
    `\nSAFE DATA (ground truth, already redacted):\n${
      JSON.stringify(safeData)
    }`,
    `\nRules:`,
    `- If bank_connected is false, do NOT talk like bank data exists. Ask 1 short question about connecting bank.`,
    `- If asked for balances/transactions/bills use bank data.`,
    `\nFormatting rules:`,
    `- Use *single asterisks* for bold (example: *Important*)`,
    `- Never use **double asterisks**`,
    `- Use bullets like:\n  • Item one\n  • Item two`,
    `- No tables. No code blocks.`,
    `- End with EXACTLY ONE question.`,
  ].join("\n");

  try {
    const reply = (await anthropicMessage(system, userContent, 260)).trim();
    return reply || fallback;
  } catch (e) {
    console.error("[app-chat] agentChatApp error:", e);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Action: nps_score
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleNpsScore(
  db: any,
  userId: string,
  body: any,
): Promise<Response> {
  const scoreRaw = body.score;
  if (
    scoreRaw === null || scoreRaw === undefined ||
    !String(scoreRaw).match(/^\d+$/)
  ) {
    return err("score must be an integer 0-10");
  }
  const scoreI = parseInt(String(scoreRaw));
  if (scoreI < 0 || scoreI > 10) return err("score must be 0-10");

  const survey = await getLatestNps(db, userId);
  if (!survey || survey.status !== "pending_score") {
    return ok({ ignored: true });
  }

  const tag = scoreI >= 9 ? "promoter" : scoreI >= 6 ? "passive" : "detractor";
  await db
    .from("nps_surveys")
    .update({
      score: scoreI,
      tag,
      status: "pending_feedback",
      score_received_at: utcNowIso(),
    })
    .eq("id", survey.id);
  await db
    .from("profiles")
    .update({ nps_score: scoreI, nps_tag: tag, nps_state: "pending_feedback" })
    .eq("user_id", userId);

  const meetingUrl = Deno.env.get("NPS_MEETING_URL") ?? "";
  const appStoreId = Deno.env.get("APP_STORE_ID") ?? "";
  const playPkg = Deno.env.get("PLAY_STORE_PACKAGE") ?? "";

  if (scoreI <= 5) {
    return ok({
      next: "meeting",
      tag,
      nps: {
        ui: "popup",
        stage: "meeting",
        survey_id: survey.id,
        title: "Let's fix this fast",
        description:
          "I'd love to personally understand what went wrong. Book a quick call with our CEO.",
        meeting_url: meetingUrl,
        cta: "Book a call",
      },
    });
  }
  if (scoreI <= 8) {
    return ok({
      next: "feedback",
      tag,
      nps: buildNpsPopupPayload("feedback", "", survey.id),
    });
  }
  return ok({
    next: "review",
    tag,
    nps: {
      ui: "popup",
      stage: "review",
      survey_id: survey.id,
      title: "You made our day 🙌",
      description: "Would you leave a quick review? It helps Hutsy grow.",
      app_store_id: appStoreId,
      play_store_package: playPkg,
      cta: "Leave a review",
    },
  });
}

// ---------------------------------------------------------------------------
// Action: nps_feedback
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleNpsFeedback(
  db: any,
  userId: string,
  body: any,
): Promise<Response> {
  let feedback = (body.feedback ?? "").trim();
  if (!feedback) return err("feedback required");
  if (feedback.length > 500) feedback = feedback.slice(0, 500);

  const survey = await getLatestNps(db, userId);
  if (!survey || survey.status !== "pending_feedback") {
    return ok({ ignored: true });
  }

  await db
    .from("nps_surveys")
    .update({ feedback, status: "complete", feedback_received_at: utcNowIso() })
    .eq("id", survey.id);
  await db
    .from("profiles")
    .update({ nps_feedback: feedback, nps_state: "complete" })
    .eq("user_id", userId);

  return ok({});
}

// ---------------------------------------------------------------------------
// Action: chat_send
// ---------------------------------------------------------------------------
async function handleChatSend(
  req: Request,
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  // deno-lint-ignore no-explicit-any
  body: any,
): Promise<Response> {
  const msg = (body.message ?? "").trim();
  const localId = (body.local_id ?? "").trim() || null;
  const deviceId = (body.device_id ?? "").trim() || null;
  const mode = normalizeMode(body.mode);

  if (!msg) return err("message required");

  const { enabled: logEnabled } = await getChatSettings(db);
  const userRow = logEnabled
    ? await insertUserMessage(db, userId, msg, localId, deviceId)
    : null;

  // AI consent gate (Apple requirement)
  const aiConsent = readAiConsent(req, body);
  if (aiConsent !== "granted") {
    const reply = aiConsentBlockReply();
    const assistantRow = logEnabled
      ? await insertAssistantMessage(db, userId, reply, localId, deviceId, {
        gate: true,
        type: "ai_consent",
        ai_consent: aiConsent,
      })
      : null;
    return ok({
      user_message: shape(userRow, "user", msg),
      assistant_message: shape(assistantRow, "assistant", reply),
    });
  }

  // Text-based NPS capture (fallback when user types score/feedback manually)
  try {
    const survey = await getLatestNps(db, userId);
    if (survey?.status === "pending_score") {
      const t = msg.trim();
      if (/^\d+$/.test(t)) {
        const score = parseInt(t);
        if (score >= 0 && score <= 10) {
          const tag = score >= 9
            ? "promoter"
            : score >= 7
            ? "passive"
            : "detractor";
          await db
            .from("nps_surveys")
            .update({
              score,
              tag,
              status: "pending_feedback",
              score_received_at: utcNowIso(),
            })
            .eq("id", survey.id);
          await db
            .from("profiles")
            .update({
              nps_score: score,
              nps_tag: tag,
              nps_state: "pending_feedback",
            })
            .eq("user_id", userId);
          return ok({
            user_message: shape(userRow, "user", msg),
            assistant_message: shape(null, "assistant", "Got it 👍"),
            nps: buildNpsPopupPayload("feedback", "", survey.id),
          });
        }
      }
    }
    if (survey?.status === "pending_feedback") {
      const feedback = msg.trim().slice(0, 500);
      if (feedback) {
        await db
          .from("nps_surveys")
          .update({
            feedback,
            status: "complete",
            feedback_received_at: utcNowIso(),
          })
          .eq("id", survey.id);
        await db
          .from("profiles")
          .update({ nps_feedback: feedback, nps_state: "complete" })
          .eq("user_id", userId);
        return ok({
          user_message: shape(userRow, "user", msg),
          assistant_message: shape(null, "assistant", "Appreciate it 🙏"),
        });
      }
    }
  } catch (e) {
    console.warn("[app-chat] NPS text capture failed:", e);
  }

  // Subscription gate
  const [subActive, subRow] = await isSubscriptionActive(db, userId);
  if (!subActive) {
    const reply = "Your plan is not active. Please update payment to continue.";
    const assistantRow = logEnabled
      ? await insertAssistantMessage(db, userId, reply, localId, deviceId, {
        gate: true,
        type: "subscription",
      })
      : null;
    return ok({
      user_message: shape(userRow, "user", msg),
      assistant_message: shape(assistantRow, "assistant", reply),
    });
  }

  const snapshot = await getSnapshot(db, userId);

  // Bank gate
  if (!(await isBankConnected(db, userId))) {
    const reply =
      "Please connect your bank in Hutsy to unlock balances, bills, and alerts.";
    const assistantRow = logEnabled
      ? await insertAssistantMessage(db, userId, reply, localId, deviceId, {
        gate: true,
        type: "bank",
      })
      : null;
    return ok({
      user_message: shape(userRow, "user", msg),
      assistant_message: shape(assistantRow, "assistant", reply),
    });
  }

  // NPS trigger — message-count based, emits popup payload (no chat bubble)
  let npsPayload = null;
  try {
    if (await cooldownOk(db, userId)) {
      const { data: profRows } = await db
        .from("profiles")
        .select("full_name")
        .eq("user_id", userId)
        .limit(1);
      const name = firstName(profRows?.[0]?.full_name ?? "");

      const survey = await ensureScheduledNps(db, userId);
      if (survey?.status === "scheduled") {
        const curCount =
          parseInt(String(survey.time_since_activation_seconds ?? 0)) || 0;
        const newCount = curCount + 1;

        await db
          .from("nps_surveys")
          .update({ time_since_activation_seconds: newCount })
          .eq("id", survey.id);

        if (newCount >= NPS_AFTER_MESSAGES) {
          const nowIso = utcNowIso();
          await db
            .from("nps_surveys")
            .update({ status: "pending_score", nps_sent_at: nowIso })
            .eq("id", survey.id);
          await db
            .from("profiles")
            .update({ nps_state: "pending_score", nps_sent_at: nowIso })
            .eq("user_id", userId);
          npsPayload = buildNpsPopupPayload("score", name, survey.id);
        }
      }
    }
  } catch (e) {
    console.warn("[app-chat] NPS trigger failed:", e);
  }

  // AI response
  const history = await buildHistory(db, userId);
  const reply = await agentChatApp(msg, snapshot, history, mode, subRow);

  const assistantRow = logEnabled
    ? await insertAssistantMessage(db, userId, reply, localId, deviceId, {
      ai_consent: aiConsent,
    })
    : null;

  const resp: Record<string, unknown> = {
    user_message: shape(userRow, "user", msg),
    assistant_message: shape(assistantRow, "assistant", reply),
  };
  if (npsPayload) resp.nps = npsPayload;
  return ok(resp);
}

// ---------------------------------------------------------------------------
// Action: chat_history
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleChatHistory(
  db: any,
  userId: string,
  body: any,
): Promise<Response> {
  const { enabled } = await getChatSettings(db);
  if (!enabled) return ok({ messages: [] });

  const limit = Math.max(1, Math.min(parseInt(String(body.limit ?? 80)), 200));
  const { data: rows } = await db
    .from("chat_messages")
    .select("id,created_at,role,direction,body,channel,meta")
    .eq("user_id", userId)
    .eq("channel", "app")
    .order("created_at", { ascending: true })
    .limit(limit);

  return ok({ messages: rows ?? [] });
}

// ---------------------------------------------------------------------------
// Action: chat_clear
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function handleChatClear(db: any, userId: string): Promise<Response> {
  try {
    await db
      .from("chat_messages")
      .delete()
      .eq("user_id", userId)
      .eq("channel", "app");
    return ok({});
  } catch (e) {
    console.error("[app-chat] chat_clear error:", e);
    return err("clear failed", 500);
  }
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

    console.log(`[app-chat] action=${action} user_id=${userId}`);

    try {
      switch (action) {
        case "chat_send":
          return await handleChatSend(req, db, userId, body);
        case "chat_history":
          return await handleChatHistory(db, userId, body);
        case "chat_clear":
          return await handleChatClear(db, userId);
        case "nps_score":
          return await handleNpsScore(db, userId, body);
        case "nps_feedback":
          return await handleNpsFeedback(db, userId, body);
        default:
          return err(`unknown action: ${action || "(none)"}`);
      }
    } catch (e) {
      console.error(`[app-chat] action=${action} error:`, e);
      return err(e instanceof Error ? e.message : "internal_error", 500);
    }
  })
);
