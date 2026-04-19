import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function buildAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

function mapSource(store: string) {
  const s = (store || '').toUpperCase().trim();
  if (s === 'APP_STORE' || s === 'MAC_APP_STORE') return 'ios';
  if (s === 'PLAY_STORE') return 'android';
  if (s === 'STRIPE') return 'web';
  if (s === 'TEST_STORE') return 'test';
  return 'revenuecat';
}

function mapPlan(productId: string) {
  const pid = (productId || '').toLowerCase().trim();
  if (pid.includes('year'))  return { plan: 'credit_builder', interval: 'year' as string | null };
  if (pid.includes('month')) return { plan: 'credit_builder', interval: 'month' as string | null };
  return { plan: 'credit_builder', interval: null as string | null };
}

function mapStatus(eventType: string, expirationAtMs: number | null) {
  const t = (eventType || '').toUpperCase().trim();
  const now = Date.now();
  const hasFutureExpiry = !!expirationAtMs && expirationAtMs > now;
  switch (t) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
      return 'active';
    case 'BILLING_ISSUE':
      return 'past_due';
    case 'EXPIRATION':
      return 'expired';
    case 'CANCELLATION':
      return hasFutureExpiry ? 'active' : 'cancelled';
    default:
      return hasFutureExpiry ? 'active' : 'expired';
  }
}

// Skip anonymous RC IDs — only real (Supabase user_id) app user IDs are valid.
function pickRealAppUserId(values: unknown[]): string | null {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const s = String(value || '').trim();
    if (!s) continue;
    if (s.startsWith('$RCAnonymousID:')) continue;
    return s;
  }
  return null;
}

function isNonWebSource(source: string): boolean {
  const s = String(source || '').trim().toLowerCase();
  return s === 'ios' || s === 'android' || s === 'revenuecat' || s === 'test';
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
async function getSubscriptionRowByUserId(db: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await db
    .from('subscriptions')
    .select('id, user_id, plan, interval, stripe_status, next_renewal, source')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

interface UpsertPayload {
  plan: string;
  interval: string | null;
  stripe_status: string;
  source: string;
  next_renewal?: string | null;
  force_id?: string;
}

async function upsertSubscriptionRowByUserId(
  db: ReturnType<typeof createClient>,
  userId: string,
  payload: UpsertPayload,
) {
  const existingRow = await getSubscriptionRowByUserId(db, userId);

  const updatePayload: Record<string, unknown> = {
    plan: payload.plan,
    interval: payload.interval,
    stripe_status: payload.stripe_status,
    source: payload.source,
    updated_at: new Date().toISOString(),
  };

  if ('next_renewal' in payload) {
    updatePayload['next_renewal'] = payload.next_renewal ?? null;
  }

  // If force_id provided and differs from current row id, update the row id too.
  if (payload.force_id) {
    updatePayload['id'] = payload.force_id;
  }

  if (existingRow) {
    const { error } = await db.from('subscriptions').update(updatePayload).eq('user_id', userId);
    if (error) throw error;
    return { action: 'updated', id: String(payload.force_id || existingRow.id) };
  }

  const insertId = String(payload.force_id || `rc_${userId}`);
  const { error } = await db.from('subscriptions').insert({
    id: insertId,
    user_id: userId,
    plan: payload.plan,
    interval: payload.interval,
    stripe_status: payload.stripe_status,
    next_renewal: payload.next_renewal ?? null,
    source: payload.source,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  return { action: 'inserted', id: insertId };
}

async function deleteOldTransferredNonWebRow(db: ReturnType<typeof createClient>, userId: string) {
  const existingRow = await getSubscriptionRowByUserId(db, userId);
  if (!existingRow) return { deleted: false, reason: 'no_row' };

  const source = String(existingRow.source || '').trim().toLowerCase();
  const rowId  = String(existingRow.id   || '').trim();
  const looksLikeNonWebSource = isNonWebSource(source) || rowId.startsWith('rc_');

  if (!looksLikeNonWebSource) {
    return { deleted: false, reason: 'source_is_web_or_unknown' };
  }

  const { error } = await db.from('subscriptions').delete().eq('user_id', userId);
  if (error) throw error;
  return { deleted: true, reason: 'deleted_non_web_row' };
}

async function getProfileByUserId(db: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, stripe_customer_id, email, full_name, phone')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Stripe helpers (used only during TRANSFER to cancel old Stripe subs)
// ---------------------------------------------------------------------------
async function stripeFetch(path: string, init: RequestInit = {}) {
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  const headers = new Headers((init.headers as HeadersInit) || {});
  headers.set('Authorization', `Bearer ${STRIPE_SECRET_KEY}`);
  const method = (init.method || 'GET').toUpperCase();
  if (method !== 'GET') headers.set('Content-Type', 'application/x-www-form-urlencoded');
  return fetch(`https://api.stripe.com${path}`, { ...init, headers });
}

async function stripeListCustomerSubscriptions(customerId: string) {
  const url  = `/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`;
  const res  = await stripeFetch(url, { method: 'GET' });
  const text = await res.text();
  if (!res.ok) throw new Error(`stripeListCustomerSubscriptions failed: ${res.status} ${text}`);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.data) ? parsed.data : [];
  } catch {
    throw new Error('stripeListCustomerSubscriptions returned invalid JSON');
  }
}

async function stripeCancelSubscription(subId: string) {
  const res  = await stripeFetch(`/v1/subscriptions/${encodeURIComponent(subId)}`, { method: 'DELETE' });
  const text = await res.text();
  if (!res.ok) throw new Error(`stripeCancelSubscription failed for ${subId}: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return null; }
}

async function cancelStripeSubscriptionsForUser(
  db: ReturnType<typeof createClient>,
  userId: string,
  reason: string,
) {
  const profile    = await getProfileByUserId(db, userId);
  const customerId = String(profile?.stripe_customer_id || '').trim();
  if (!customerId) {
    console.log(`[RC-webhook] no stripe_customer_id for user=${userId}, skipping Stripe cancel reason=${reason}`);
    return { ok: true, cancelled: [] as string[], reason: 'no_customer_id' };
  }

  const subs               = await stripeListCustomerSubscriptions(customerId);
  const actionableStatuses = new Set(['trialing', 'active', 'past_due', 'unpaid', 'incomplete']);
  const cancelled: string[] = [];

  for (const sub of subs) {
    const subId  = String(sub?.id     || '').trim();
    const status = String(sub?.status || '').trim().toLowerCase();
    if (!subId || !actionableStatuses.has(status)) continue;
    try {
      await stripeCancelSubscription(subId);
      cancelled.push(subId);
      console.log(`[RC-webhook] cancelled Stripe sub sub_id=${subId} customer=${customerId} user=${userId} reason=${reason}`);
    } catch (err) {
      console.error(`[RC-webhook] failed to cancel Stripe sub sub_id=${subId} customer=${customerId} user=${userId} reason=${reason}:`, err);
    }
  }

  return {
    ok: true,
    cancelled,
    reason: cancelled.length ? 'cancelled_matching_subscriptions' : 'no_actionable_subscriptions',
  };
}

// ---------------------------------------------------------------------------
// Plaid disconnect — mirrors hutsy_plaid_disconnect_for_user() in PHP
// ---------------------------------------------------------------------------
function buildPlaidClient(plaidEnv: string) {
  const PLAID_CLIENT_ID = Deno.env.get('PLAID_CLIENT_ID');
  const PLAID_SECRET    = Deno.env.get('PLAID_SECRET');
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) throw new Error('Missing Plaid credentials');
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[plaidEnv] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
        'PLAID-SECRET':    PLAID_SECRET,
      },
    },
  }));
}

interface PlaidErrorData { error_code?: string; error_message?: string; display_message?: string; }
interface PlaidSdkError  { response?: { data?: PlaidErrorData; status?: number } }

function extractPlaidError(err: unknown): PlaidErrorData & { status?: number } {
  const e = err as PlaidSdkError;
  return {
    error_code:      e?.response?.data?.error_code,
    error_message:   e?.response?.data?.error_message,
    display_message: e?.response?.data?.display_message,
    status:          e?.response?.status,
  };
}

async function plaidCallItemGet(plaid: PlaidApi, accessToken: string): Promise<{ ok: boolean; errorCode: string | null }> {
  try {
    const res = await plaid.itemGet({ access_token: accessToken });
    return res.data?.item ? { ok: true, errorCode: null } : { ok: false, errorCode: 'unknown' };
  } catch (err: unknown) {
    const { error_code, error_message } = extractPlaidError(err);
    console.error(`[RC-webhook] plaidCallItemGet: error_code=${error_code} error_message=${error_message}`);
    return { ok: false, errorCode: error_code ?? 'unknown' };
  }
}

async function plaidCallItemRemove(plaid: PlaidApi, accessToken: string): Promise<{ ok: boolean; errorCode: string | null }> {
  console.log('[RC-webhook] plaidCallItemRemove: calling /item/remove');
  try {
    const res     = await plaid.itemRemove({ access_token: accessToken });
    const removed = (res.data as { removed?: boolean })?.removed;
    if (removed) {
      console.log('[RC-webhook] plaidCallItemRemove: success, item removed');
      return { ok: true, errorCode: null };
    }
    console.warn('[RC-webhook] plaidCallItemRemove: unexpected response (no removed flag)', JSON.stringify(res.data));
    return { ok: false, errorCode: 'unexpected_response' };
  } catch (err: unknown) {
    const { error_code, error_message, display_message, status } = extractPlaidError(err);
    const errCode = error_code ?? '';
    console.error(`[RC-webhook] plaidCallItemRemove: status=${status} error_code=${errCode} error_message=${error_message} display_message=${display_message}`);
    if (errCode === 'ITEM_NOT_FOUND') {
      console.log('[RC-webhook] plaidCallItemRemove: ITEM_NOT_FOUND — treating as already removed');
      return { ok: true, errorCode: 'ITEM_NOT_FOUND' };
    }
    if (errCode) return { ok: false, errorCode: errCode };
    console.warn('[RC-webhook] plaidCallItemRemove: ambiguous error, verifying via itemGet');
    const check = await plaidCallItemGet(plaid, accessToken);
    if (!check.ok && check.errorCode === 'ITEM_NOT_FOUND') {
      console.log('[RC-webhook] plaidCallItemRemove: itemGet confirmed item gone — treating as removed');
      return { ok: true, errorCode: 'ALREADY_REMOVED' };
    }
    console.error('[RC-webhook] plaidCallItemRemove: item still exists or unknown error after verification');
    return { ok: false, errorCode: 'unexpected_response' };
  }
}

async function purgePlaidSupabaseItem(db: ReturnType<typeof createClient>, userId: string, itemId: string, env: string) {
  const match = { item_id: itemId, user_id: userId, plaid_env: env };
  await db.from('plaid_transactions').delete().match(match);
  await db.from('plaid_recurring').delete().match(match);
  await db.from('plaid_accounts').delete().match(match);
  await db.from('plaid_webhook_events').delete().match(match);
  await db.from('plaid_item_secrets').delete().match(match);
  await db.from('plaid_items').delete().match(match);
}

async function disconnectPlaidForUser(db: ReturnType<typeof createClient>, userId: string, reason: string) {
  if (!userId) return;

  const env = (Deno.env.get('PLAID_ENV') ?? 'production').toLowerCase();

  const { data: secrets, error: secsErr } = await db
    .from('plaid_item_secrets')
    .select('item_id, access_token')
    .eq('user_id', userId)
    .eq('plaid_env', env);

  if (secsErr) console.error('[RC-webhook] plaid_item_secrets fetch error:', secsErr);

  if (!secrets?.length) {
    console.log(`[RC-webhook] no plaid items for user=${userId}, marking disconnected anyway`);
    //@ts-ignore
    await db.from('profiles').update({ bank_disconnected_at: new Date().toISOString() }).eq('user_id', userId);
    return;
  }

  const plaid = buildPlaidClient(env);

  for (const { item_id: itemId, access_token: token } of secrets) {
    if (!itemId || !token) continue;
    const { ok, errorCode } = await plaidCallItemRemove(plaid, token);
    const effectivelyRemoved = ok || errorCode === 'ITEM_NOT_FOUND' || errorCode === 'ALREADY_REMOVED';
    if (effectivelyRemoved) {
      await purgePlaidSupabaseItem(db, userId, itemId, env);
      console.log(`[RC-webhook] plaid item purged item=${itemId} user=${userId} reason=${reason}`);
    } else {
      console.error(`[RC-webhook] plaid /item/remove failed item=${itemId} user=${userId} error=${errorCode}`);
    }
  }

  //@ts-ignore
  await db.from('profiles').update({ bank_disconnected_at: new Date().toISOString() }).eq('user_id', userId);
}

// ---------------------------------------------------------------------------
// Transfer handler
// TRANSFER events do not reliably include event.app_user_id.
// They must be handled before the normal app_user_id validation.
// ---------------------------------------------------------------------------
async function handleTransferEvent(db: ReturnType<typeof createClient>, event: Record<string, unknown>) {
  const fromUserId = pickRealAppUserId(
    Array.isArray(event.transferred_from) ? event.transferred_from as unknown[] : [],
  );
  const toUserId = pickRealAppUserId(
    Array.isArray(event.transferred_to) ? event.transferred_to as unknown[] : [],
  );

  console.log(`[RC-webhook] TRANSFER detected from=${fromUserId} to=${toUserId} store=${String(event.store || '')}`);

  if (!toUserId) {
    console.warn('[RC-webhook] TRANSFER has no real transferred_to app user id, ignoring');
    return json({
      ok: true,
      ignored: true,
      reason: 'transfer_missing_to_user',
      from_user_id: fromUserId,
      to_user_id: toUserId,
    });
  }

  const source    = mapSource(String(event.store || ''));
  const targetRow = await getSubscriptionRowByUserId(db, toUserId);

  // Normalize the row to rc_<toUserId> so Stripe webhook won't overwrite it.
  const forcedRcId = `rc_${toUserId}`;
  const payload: UpsertPayload = {
    plan:          String(targetRow?.plan || 'credit_builder'),
    interval:      targetRow?.interval ?? 'month',
    stripe_status: 'active',
    source,
    next_renewal:  targetRow?.next_renewal ?? null,
    force_id:      forcedRcId,
  };

  const upserted = await upsertSubscriptionRowByUserId(db, toUserId, payload);
  await cancelStripeSubscriptionsForUser(db, toUserId, 'revenuecat:TRANSFER');

  let transferredFromCleanup: { deleted: boolean; reason: string } = { deleted: false, reason: 'no_from_user' };
  if (fromUserId && fromUserId !== toUserId) {
    try {
      transferredFromCleanup = await deleteOldTransferredNonWebRow(db, fromUserId);
    } catch (err) {
      console.error(`[RC-webhook] failed cleaning transferred_from row user=${fromUserId}:`, err);
      transferredFromCleanup = { deleted: false, reason: 'cleanup_failed' };
    }
  }

  console.log(`[RC-webhook] TRANSFER handled to=${toUserId} action=${upserted.action} id=${upserted.id} from_cleanup=${JSON.stringify(transferredFromCleanup)}`);

  return json({
    ok: true,
    action: 'transfer_handled',
    transferred_from_user_id:   fromUserId,
    transferred_to_user_id:     toUserId,
    target_subscription_action: upserted.action,
    target_subscription_id:     upserted.id,
    source,
    old_row_cleanup: transferredFromCleanup,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    const body = await req.json().catch(() => null);
    console.log('[RC-webhook] raw body:', JSON.stringify(body));
    const event = body?.event;
    if (!event) {
      console.error('[RC-webhook] missing event', body);
      return json({ ok: false, error: 'missing_event' }, 400);
    }

    const eventType = String(event.type || '').toUpperCase().trim();

    if (eventType === 'TEST') {
      console.log('[RC-webhook] test event received');
      return json({ ok: true, ignored: true, reason: 'test_event' });
    }

    const db = buildAdminClient();

    // TRANSFER events must be handled before app_user_id validation — they use
    // transferred_from/transferred_to arrays and may not include app_user_id.
    if (eventType === 'TRANSFER') {
      return await handleTransferEvent(db, event);
    }

    const userId = String(event.app_user_id || '').trim();
    if (!userId) {
      console.error('[RC-webhook] missing app_user_id', event);
      return json({ ok: false, error: 'missing_app_user_id' }, 400);
    }

    const { plan, interval } = mapPlan(String(event.product_id || ''));
    const source       = mapSource(String(event.store || ''));
    const stripeStatus = mapStatus(eventType, event.expiration_at_ms ?? null);
    const nextRenewal  = event.expiration_at_ms ? new Date(event.expiration_at_ms as number).toISOString() : null;
    const isPaid       = ['active', 'trialing'].includes(stripeStatus);

    console.log(`[RC-webhook] user_id=${userId} type=${eventType} product_id=${String(event.product_id || '')} store=${String(event.store || '')} status=${stripeStatus}`);

    const payload: UpsertPayload = { plan, interval, stripe_status: stripeStatus, source };

    if (nextRenewal) {
      payload.next_renewal = nextRenewal;
    } else if (stripeStatus === 'expired' || stripeStatus === 'cancelled' || stripeStatus === 'past_due') {
      payload.next_renewal = null;
    }

    // Keep non-web subscriptions normalized to rc_<user_id> so Stripe webhook
    // events cannot overwrite them.
    if (isNonWebSource(source)) {
      payload.force_id = `rc_${userId}`;
    }

    const result = await upsertSubscriptionRowByUserId(db, userId, payload);

    if (!isPaid) {
      await disconnectPlaidForUser(db, userId, `revenuecat:${eventType}`);
    }

    console.log(`[RC-webhook] ${result.action} subscription row id=${result.id} user_id=${userId} source=${source} status=${stripeStatus}`);

    return json({
      ok: true,
      action: result.action,
      user_id: userId,
      id: result.id,
      stripe_status: stripeStatus,
      source,
    });

  } catch (e) {
    console.error('[RC-webhook] fatal error:', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'unknown_error' }, 500);
  }
});
