import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
// ---------------------------------------------------------------------------
// Stripe webhook signature verification
// ---------------------------------------------------------------------------
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for(let i = 0; i < a.length; i++){
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = sigHeader.split(',');
  const tPart = parts.find((p)=>p.startsWith('t='));
  const v1Parts = parts.filter((p)=>p.startsWith('v1='));
  if (!tPart || !v1Parts.length) return false;
  const timestamp = tPart.slice(2);
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {
    name: 'HMAC',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const computed = Array.from(new Uint8Array(sigBuf)).map((b)=>b.toString(16).padStart(2, '0')).join('');
  return v1Parts.some((vp)=>timingSafeEqual(vp.slice(3), computed));
}
// ---------------------------------------------------------------------------
// Supabase admin client
// ---------------------------------------------------------------------------
function buildAdminClient() {
  return createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
}
// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
async function sbGetProfileByCustomer(db, stripeCustomerId) {
  const { data } = await db.from('profiles').select('user_id, email, full_name, phone').eq('stripe_customer_id', stripeCustomerId).limit(1);
  return data?.[0] ?? null;
}
async function sbGetSubscriptionByUserId(db, userId: string) {
  const { data, error } = await db
    .from('subscriptions')
    .select('id, user_id, source, stripe_status, plan, interval, next_renewal')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) { console.error('[stripe-webhook] sbGetSubscriptionByUserId error:', error); return null; }
  return data ?? null;
}
function isNonWebOwnedRow(row: { source?: string; id?: string } | null): boolean {
  if (!row) return false;
  const source = String(row.source || '').trim().toLowerCase();
  const rowId  = String(row.id   || '').trim();
  return source === 'ios' || source === 'android' || source === 'revenuecat' || source === 'test' || rowId.startsWith('rc_');
}
async function shouldIgnoreStripeForUser(db, userId: string): Promise<boolean> {
  const row = await sbGetSubscriptionByUserId(db, userId);
  return isNonWebOwnedRow(row);
}
async function sbUpsertSubscription(db, subId, userId, plan, interval, status, nextRenewal) {
  const existing = await sbGetSubscriptionByUserId(db, userId);
  // If this user is already owned by RevenueCat / mobile, Stripe must not overwrite it.
  if (isNonWebOwnedRow(existing)) {
    console.log(`[stripe-webhook] skip subscription upsert for user=${userId} sub_id=${subId} because row is non-web owned id=${existing?.id} source=${existing?.source}`);
    return;
  }
  const row = {
    id: subId,
    user_id: userId,
    plan,
    interval,
    stripe_status: status,
    source: 'web',
    updated_at: new Date().toISOString()
  };
  if (nextRenewal !== null) row['next_renewal'] = nextRenewal;
  const { error } = await db.from('subscriptions').upsert(row, {
    onConflict: 'id'
  });
  if (error) console.error('[stripe-webhook] sbUpsertSubscription error:', error);
}
async function sbInsertPayment(db, id, userId, amount, currency, status, raw) {
  const { error } = await db.from('payments').insert({
    id,
    user_id: userId,
    amount,
    currency: currency.toLowerCase(),
    status,
    raw,
    created_at: new Date().toISOString()
  });
  if (error && !error.message?.includes('duplicate')) {
    console.error('[stripe-webhook] sbInsertPayment error:', error);
  }
}
// ---------------------------------------------------------------------------
// Plaid disconnect — mirrors hutsy_plaid_disconnect_for_user() in PHP
// ---------------------------------------------------------------------------

// Copied from plaid-webhook/index.ts
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

/** Verify whether a Plaid item still exists via the SDK. */
async function plaidCallItemGet(plaid: PlaidApi, accessToken: string): Promise<{ ok: boolean; errorCode: string | null }> {
  try {
    const res = await plaid.itemGet({ access_token: accessToken });
    return res.data?.item ? { ok: true, errorCode: null } : { ok: false, errorCode: 'unknown' };
  } catch (err: any) {
    const code = err?.response?.data?.error_code ?? 'unknown';
    return { ok: false, errorCode: code };
  }
}

/** Remove a Plaid item via the SDK, with ITEM_NOT_FOUND treated as success. */
async function plaidCallItemRemove(plaid: PlaidApi, accessToken: string): Promise<{ ok: boolean; errorCode: string | null }> {
  try {
    const res = await plaid.itemRemove({ access_token: accessToken });
    // SDK type doesn't declare `removed`; cast to access it
    return (res.data as any)?.removed ? { ok: true, errorCode: null } : { ok: false, errorCode: 'unexpected_response' };
  } catch (err: any) {
    const errCode: string = err?.response?.data?.error_code ?? '';
    // ITEM_NOT_FOUND means it's already gone — treat as success
    if (errCode === 'ITEM_NOT_FOUND') return { ok: true, errorCode: 'ITEM_NOT_FOUND' };
    if (errCode) return { ok: false, errorCode: errCode };

    // Ambiguous error — verify via itemGet
    const check = await plaidCallItemGet(plaid, accessToken);
    if (!check.ok && check.errorCode === 'ITEM_NOT_FOUND') {
      return { ok: true, errorCode: 'ALREADY_REMOVED' };
    }
    return { ok: false, errorCode: 'unexpected_response' };
  }
}

/** Delete all Supabase Plaid rows for one item (leaf tables first, then secrets + item). */
async function purgePlaidSupabaseItem(db, userId: string, itemId: string, env: string) {
  const match = { item_id: itemId, user_id: userId, plaid_env: env };
  await db.from('plaid_transactions').delete().match(match);
  await db.from('plaid_recurring').delete().match(match);
  await db.from('plaid_accounts').delete().match(match);
  await db.from('plaid_webhook_events').delete().match(match);
  await db.from('plaid_item_secrets').delete().match(match);
  await db.from('plaid_items').delete().match(match);
}

/**
 * Full Plaid disconnect for a user — mirrors hutsy_plaid_disconnect_for_user() in PHP.
 * - Only runs in production (sandbox is skipped to avoid nuking test data).
 * - Calls Plaid /item/remove for each item to stop billing.
 * - On success (or ITEM_NOT_FOUND), purges all related Supabase rows.
 * - Always stamps profiles.bank_disconnected_at regardless of item count.
 */
async function disconnectPlaidForUser(db, userId: string, reason: string) {
  if (!userId) return;

  const env = (Deno.env.get('PLAID_ENV') ?? 'production').toLowerCase();

  // Fetch all item secrets for this user
  const { data: secrets, error: secsErr } = await db
    .from('plaid_item_secrets')
    .select('item_id, access_token')
    .eq('user_id', userId)
    .eq('plaid_env', env);

  if (secsErr) console.error('[stripe-webhook] plaid_item_secrets fetch error:', secsErr);

  if (!secrets?.length) {
    console.log(`[stripe-webhook] no plaid items found for user=${userId}, marking disconnected anyway`);
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
      console.log(`[stripe-webhook] plaid item purged item=${itemId} user=${userId} reason=${reason}`);
    } else {
      console.error(`[stripe-webhook] plaid /item/remove failed item=${itemId} user=${userId} error=${errorCode}`);
    }
  }

  // Always mark disconnected after the attempt
  await db.from('profiles').update({ bank_disconnected_at: new Date().toISOString() }).eq('user_id', userId);
}
// ---------------------------------------------------------------------------
// FCM push notifications (HTTP v1 API with service account JWT)
// Mirrors hutsy/push/fcm.py
// ---------------------------------------------------------------------------
function base64urlEncode(data) {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function toBase64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function getFcmAccessToken() {
  const saJson = Deno.env.get('FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!saJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON not set');
  const sa = JSON.parse(saJson);
  const clientEmail = sa.client_email;
  const privateKeyPem = sa.private_key;
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = toBase64url(JSON.stringify({
    alg: 'RS256',
    typ: 'JWT'
  }));
  const payload = toBase64url(JSON.stringify({
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${payload}`;
  const pemBody = privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemBody), (c)=>c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, {
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-256'
  }, false, [
    'sign'
  ]);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${base64urlEncode(new Uint8Array(sig))}`;
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  if (!resp.ok) throw new Error(`FCM token exchange failed: ${resp.status} ${await resp.text()}`);
  const j = await resp.json();
  if (!j.access_token) throw new Error('FCM token exchange returned no access_token');
  return j.access_token;
}
async function pushToUser(db, userId, title, body, data = {}) {
  const projectId = Deno.env.get('FIREBASE_PROJECT_ID');
  if (!projectId) {
    console.warn('[stripe-webhook] FIREBASE_PROJECT_ID not set, skipping push');
    return;
  }
  const { data: rows } = await db.from('device_push_tokens').select('token').eq('user_id', userId).eq('is_enabled', true).order('updated_at', {
    ascending: false
  }).limit(50);
  const tokens = (rows ?? []).map((r)=>r.token).filter(Boolean);
  if (!tokens.length) return;
  let accessToken;
  try {
    accessToken = await getFcmAccessToken();
  } catch (err) {
    console.error('[stripe-webhook] FCM token error:', err.message);
    return;
  }
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  for (const token of tokens){
    const payload = {
      message: {
        token,
        notification: {
          title,
          body
        },
        data,
        android: {
          priority: 'HIGH'
        },
        apns: {
          headers: {
            'apns-priority': '10'
          }
        }
      }
    };
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        const txt = await r.text();
        if (txt.includes('UNREGISTERED') || txt.includes('NotRegistered') || txt.includes('InvalidRegistration')) {
          await db.from('device_push_tokens').update({
            is_enabled: false
          }).eq('token', token);
        } else {
          console.error(`[stripe-webhook] FCM send failed token=${token.slice(0, 10)}... status=${r.status}`);
        }
      }
    } catch (err) {
      console.error('[stripe-webhook] push send error:', err.message);
    }
  }
}
// ---------------------------------------------------------------------------
// Chat message storage
// Mirrors hutsy/chat/logging.py — only inserts when chat_logging is enabled
// ---------------------------------------------------------------------------
async function storeChatMessage(db, userId, body, data) {
  const { data: rows } = await db.from('admin_settings').select('value').eq('key', 'chat_logging').limit(1);
  const raw = rows?.[0]?.value ?? {};
  const settings = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!settings?.enabled) return;
  const meta = {
    source: 'system'
  };
  if (data) meta.data = data;
  const { error } = await db.from('chat_messages').insert({
    user_id: userId,
    channel: 'app',
    role: 'assistant',
    direction: 'out',
    body: body.slice(0, 4000),
    wa_from: null,
    wa_message_id: null,
    meta
  });
  if (error) console.error('[stripe-webhook] storeChatMessage error:', error);
}
// ---------------------------------------------------------------------------
// Subscription notification
// Mirrors the notification logic from hutsy/webhooks/subscription.py
// ---------------------------------------------------------------------------
async function handleSubscriptionNotification(db, userId, status, amount, currency) {
  if (status === 'trialing') {
    console.log(`[stripe-webhook] status=trialing — skipping notifications for user=${userId}`);
    return;
  }
  if (status === 'active') {
    // Dedup: only notify once per active period
    const { data: prof } = await db.from('profiles').select('sub_active_notified_at').eq('user_id', userId).limit(1);
    if (prof?.[0]?.sub_active_notified_at) {
      console.log(`[stripe-webhook] already notified user=${userId}, skipping`);
      return;
    }
    await storeChatMessage(db, userId, '✅ Membership active — you can now use Hutsy AI.', {
      amount,
      currency
    });
    await pushToUser(db, userId, 'Hutsy membership active ✅', "You're all set. Open the app to start using Hutsy AI.", {
      type: 'subscription',
      status: 'active'
    });
    await db.from('profiles').update({
      sub_active_notified_at: new Date().toISOString()
    }).eq('user_id', userId);
  } else {
    // past_due, canceled, unpaid, etc.
    await db.from('profiles').update({
      sub_active_notified_at: null
    }).eq('user_id', userId);
    await storeChatMessage(db, userId, '⚠️ Membership issue — please update payment.');
    await pushToUser(db, userId, 'Payment issue ⚠️', "Your membership isn't active right now. Please update payment in the app.", {
      type: 'subscription',
      status
    });
  }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getInterval(sub) {
  const items = sub['items']?.['data'];
  return items?.[0]?.['price']?.['recurring']?.['interval'] ?? items?.[0]?.['plan']?.['interval'] ?? 'month';
}
function getNextRenewal(inv, sub) {
  const lines = inv['lines']?.['data'];
  const periodEnd = lines?.[0]?.['period']?.['end'];
  if (periodEnd) return new Date(periodEnd * 1000).toISOString();
  const cpe = sub['current_period_end'];
  if (cpe) return new Date(cpe * 1000).toISOString();
  const te = sub['trial_end'];
  if (te) return new Date(te * 1000).toISOString();
  return null;
}
function getSubId(inv) {
  if (inv['subscription']) return inv['subscription'];
  const parent = inv['parent'];
  if (parent?.['type'] === 'subscription_details') {
    const sd = parent['subscription_details'];
    if (sd?.['subscription']) return sd['subscription'];
  }
  return null;
}
// ---------------------------------------------------------------------------
// Stripe REST helper
// ---------------------------------------------------------------------------
async function stripeRetrieveSubscription(subId) {
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  if (!STRIPE_SECRET_KEY) {
    console.error('[stripe-webhook] STRIPE_SECRET_KEY not set');
    return null;
  }
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, {
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET_KEY}`
    }
  });
  if (!res.ok) {
    console.error('[stripe-webhook] stripeRetrieveSubscription error:', res.status, await res.text());
    return null;
  }
  return await res.json();
}
// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------
async function handleSubscriptionEvent(db, sub) {
  const custId = sub['customer'];
  if (!custId) return;
  const profile = await sbGetProfileByCustomer(db, custId);
  if (!profile) return;
  const userId = profile.user_id;
  const shouldSkip = await shouldIgnoreStripeForUser(db, userId);
  if (shouldSkip) {
    console.log(`[stripe-webhook] skipping customer.subscription.* update for user=${userId} because subscription is non-web owned`);
    return;
  }
  const interval = getInterval(sub);
  const status = sub['status'] ?? 'unknown';
  await sbUpsertSubscription(db, sub['id'], userId, 'credit_builder', interval, status, null);
  const isPaidSub = ['active', 'trialing'].includes(String(status).toLowerCase());
  if (!isPaidSub) await disconnectPlaidForUser(db, userId, `customer.subscription.${status}`);
}
async function handleInvoicePaymentSucceeded(db, inv) {
  const custId = inv['customer'];
  if (!custId) return;
  const profile = await sbGetProfileByCustomer(db, custId);
  if (!profile) return;
  const { user_id: uid } = profile;
  const shouldSkip = await shouldIgnoreStripeForUser(db, uid);
  await sbInsertPayment(db, inv['id'], uid, inv['amount_paid'] ?? 0, inv['currency'] ?? 'usd', inv['status'] ?? 'paid', inv);
  if (shouldSkip) {
    console.log(`[stripe-webhook] skipping invoice.payment_succeeded subscription update for user=${uid} because subscription is non-web owned`);
    return;
  }
  const subId = getSubId(inv);
  if (!subId) return;
  const sub = await stripeRetrieveSubscription(subId);
  if (!sub) return;
  const interval = getInterval(sub);
  const status = sub['status'] ?? 'unknown';
  const nextRenewal = getNextRenewal(inv, sub);
  await sbUpsertSubscription(db, subId, uid, 'credit_builder', interval, status, nextRenewal);
  const amount = (inv['amount_paid'] ?? 0) / 100;
  const currency = (inv['currency'] ?? 'usd').toUpperCase();
  await handleSubscriptionNotification(db, uid, status, amount, currency);
}
async function handleInvoicePaymentFailed(db, inv) {
  const custId = inv['customer'];
  if (!custId) return;
  const profile = await sbGetProfileByCustomer(db, custId);
  if (!profile) return;
  const { user_id: uid } = profile;
  const shouldSkip = await shouldIgnoreStripeForUser(db, uid);
  await sbInsertPayment(db, inv['id'], uid, inv['amount_due'] ?? 0, inv['currency'] ?? 'usd', inv['status'] ?? 'open', inv);
  if (shouldSkip) {
    console.log(`[stripe-webhook] skipping invoice.payment_failed subscription update for user=${uid} because subscription is non-web owned`);
    return;
  }
  await disconnectPlaidForUser(db, uid, 'invoice.payment_failed');
  const amount = (inv['amount_due'] ?? 0) / 100;
  const currency = (inv['currency'] ?? 'usd').toUpperCase();
  await handleSubscriptionNotification(db, uid, 'past_due', amount, currency);
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  const raw = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET not set');
    return new Response('misconfigured', {
      status: 500
    });
  }
  const valid = await verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.warn('[stripe-webhook] invalid signature');
    return new Response('invalid signature', {
      status: 400
    });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch  {
    return new Response('invalid json', {
      status: 400
    });
  }
  const type = event['type'];
  const obj = event['data']?.['object'];
  console.log(`[stripe-webhook] event=${type}`);
  EdgeRuntime.waitUntil((async ()=>{
    const db = buildAdminClient();
    try {
      if ([
        'customer.subscription.created',
        'customer.subscription.updated',
        'customer.subscription.deleted'
      ].includes(type)) {
        await handleSubscriptionEvent(db, obj);
      } else if (type === 'invoice.payment_succeeded') {
        await handleInvoicePaymentSucceeded(db, obj);
      } else if (type === 'invoice.payment_failed') {
        await handleInvoicePaymentFailed(db, obj);
      } else {
        console.log(`[stripe-webhook] unhandled event type=${type}`);
      }
    } catch (err) {
      console.error('[stripe-webhook] handler uncaught:', err);
    }
  })());
  return new Response(JSON.stringify({
    ok: true
  }), {
    headers: {
      'Content-Type': 'application/json'
    }
  });
});
