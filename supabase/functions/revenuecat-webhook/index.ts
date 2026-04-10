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
  if (pid.includes('year'))  return { plan: 'credit_builder', interval: 'year' };
  if (pid.includes('month')) return { plan: 'credit_builder', interval: 'month' };
  return { plan: 'credit_builder', interval: null };
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

// ---------------------------------------------------------------------------
// Plaid disconnect — mirrors hutsy_plaid_disconnect_for_user() in PHP
// Copied pattern from stripe-webhook/index.ts
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
interface PlaidSdkError { response?: { data?: PlaidErrorData; status?: number } }

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
    const res = await plaid.itemRemove({ access_token: accessToken });
    // SDK type doesn't declare `removed`; cast to access it
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
    // Ambiguous error — verify via itemGet
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

/**
 * Full Plaid disconnect for a user.
 * - Calls Plaid /item/remove for each item to stop billing.
 * - On success (or ITEM_NOT_FOUND), purges all related Supabase rows.
 * - Always stamps profiles.bank_disconnected_at.
 */
async function disconnectPlaidForUser(db: ReturnType<typeof createClient>, userId: string, reason: string) {
  if (!userId) return;

  const env = (Deno.env.get('PLAID_ENV') ?? 'production').toLowerCase();

  const { data: secrets, error: secsErr } = await db
    .from('plaid_item_secrets')
    .select('item_id, access_token')
    .eq('user_id', userId)
    .eq('plaid_env', env);

  if (secsErr) console.error('[RC-webhook-v2] plaid_item_secrets fetch error:', secsErr);

  if (!secrets?.length) {
    console.log(`[RC-webhook-v2] no plaid items for user=${userId}, marking disconnected anyway`);
    //@ts-ignore //TODO add comment
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
      console.log(`[RC-webhook-v2] plaid item purged item=${itemId} user=${userId} reason=${reason}`);
    } else {
      console.error(`[RC-webhook-v2] plaid /item/remove failed item=${itemId} user=${userId} error=${errorCode}`);
    }
  }

  //@ts-ignore //TODO add comment
  await db.from('profiles').update({ bank_disconnected_at: new Date().toISOString() }).eq('user_id', userId);
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
    console.log('[RC-webhook-v2] raw body:', JSON.stringify(body));
    const event = body?.event;
    if (!event) {
      console.error('[RC-webhook-v2] missing event', body);
      return json({ ok: false, error: 'missing_event' }, 400);
    }

    const userId = (event.app_user_id || '').trim();
    if (!userId) {
      console.error('[RC-webhook-v2] missing app_user_id', event);
      return json({ ok: false, error: 'missing_app_user_id' }, 400);
    }

    const eventType = (event.type || '').toUpperCase().trim();

    if (eventType === 'TEST') {
      console.log('[RC-webhook-v2] test event received');
      return json({ ok: true, ignored: true, reason: 'test_event' });
    }

    const db = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { plan, interval } = mapPlan(event.product_id);
    const source       = mapSource(event.store);
    const stripeStatus = mapStatus(event.type, event.expiration_at_ms ?? null);
    const nextRenewal  = event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null;
    const syntheticId  = `rc_${userId}`;
    const isPaid       = ['active', 'trialing'].includes(stripeStatus);

    console.log(`[RC-webhook-v2] user_id=${userId} type=${eventType} product_id=${event.product_id} store=${event.store} status=${stripeStatus}`);

    const { data: existingRow, error: existingError } = await db
      .from('subscriptions')
      .select('id, user_id')
      .eq('id', syntheticId)
      .maybeSingle();

    if (existingError) {
      console.error('[RC-webhook-v2] existing row lookup failed:', existingError);
      return json({ ok: false, error: 'existing_lookup_failed', details: existingError.message }, 500);
    }

    if (existingRow) {
      const updatePayload: Record<string, unknown> = {
        plan,
        interval,
        stripe_status: stripeStatus,
        source,
        updated_at: new Date().toISOString(),
      };
      if (nextRenewal) {
        updatePayload['next_renewal'] = nextRenewal;
      } else if (stripeStatus === 'expired' || stripeStatus === 'cancelled' || stripeStatus === 'past_due') {
        updatePayload['next_renewal'] = null;
      }

      const { error: updateError } = await db.from('subscriptions').update(updatePayload).eq('id', syntheticId);
      if (updateError) {
        console.error('[RC-webhook-v2] update failed:', updateError);
        return json({ ok: false, error: 'update_failed', details: updateError.message }, 500);
      }

      //@ts-ignore //TODO add comment
      if (!isPaid) await disconnectPlaidForUser(db, userId, `revenuecat:${eventType}`);

      console.log(`[RC-webhook-v2] updated existing subscription id=${existingRow.id} user_id=${userId}`);
      return json({ ok: true, action: 'updated', user_id: userId, id: existingRow.id, stripe_status: stripeStatus, source });
    }

    const { error: insertError } = await db.from('subscriptions').insert({
      id: syntheticId,
      user_id: userId,
      plan,
      interval,
      stripe_status: stripeStatus,
      next_renewal: nextRenewal,
      source,
    });

    if (insertError) {
      console.error('[RC-webhook-v2] insert failed:', insertError);
      return json({ ok: false, error: 'insert_failed', details: insertError.message }, 500);
    }

    //@ts-ignore //TODO add comment
    if (!isPaid) await disconnectPlaidForUser(db, userId, `revenuecat:${eventType}`);

    console.log(`[RC-webhook-v2] inserted new subscription id=${syntheticId} user_id=${userId}`);
    return json({ ok: true, action: 'inserted', user_id: userId, id: syntheticId, stripe_status: stripeStatus, source });

  } catch (e) {
    console.error('[RC-webhook-v2] fatal error:', e);
    return json({ ok: false, error: e instanceof Error ? e.message : 'unknown_error' }, 500);
  }
});
