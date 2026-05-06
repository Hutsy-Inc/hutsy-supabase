import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
// ---------------------------------------------------------------------------
// CORS + response helpers
// ---------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
function ok(data, status = 200) {
  return new Response(JSON.stringify({
    ok: true,
    ...data
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
function err(message, status = 400) {
  return new Response(JSON.stringify({
    ok: false,
    error: message
  }), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ---------------------------------------------------------------------------
// Stripe REST helper (no SDK — uses fetch against api.stripe.com)
// ---------------------------------------------------------------------------
async function stripe(method, path, params, idempotencyKey) {
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  const headers = {
    'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
    'Stripe-Version': '2024-04-10'
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let url = `https://api.stripe.com/v1${path}`;
  let body;
  if (method === 'GET' && params) {
    url += '?' + encodeStripeParams(params);
  } else if (method === 'POST' && params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encodeStripeParams(params);
  }
  const res = await fetch(url, {
    method,
    headers,
    body
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.['error']?.['message'] ?? `Stripe error ${res.status}`;
    throw new Error(msg);
  }
  return json;
}
// Stripe uses form-encoded bodies with bracket notation for nested objects/arrays.
function encodeStripeParams(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)){
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v){
        if (typeof item === 'object' && item !== null) {
          parts.push(encodeStripeParams(item, `${key}[]`));
        } else {
          parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
        }
      }
    } else if (typeof v === 'object') {
      parts.push(encodeStripeParams(v, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.join('&');
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
async function sbAdminCreateUser(email, password, meta) {
  const db = buildAdminClient();
  const { data, error } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: meta
  });
  if (error) throw new Error(`Supabase admin create failed: ${error.message}`);
  return data.user;
}
async function sbUpsertProfile(userId, email, name, phone, zip, consent, stripeCustomerId) {
  const db = buildAdminClient();
  const { error } = await db.from('profiles').upsert({
    user_id: userId,
    email,
    full_name: name,
    phone,
    zip,
    consent,
    stripe_customer_id: stripeCustomerId
  }, {
    onConflict: 'user_id'
  });
  if (error) console.error('[stripe-backend] sbUpsertProfile error:', error);
}
async function sbUpsertSubscription(subId, userId, interval, status, nextRenewal) {
  const db = buildAdminClient();
  const row = {
    id: subId,
    user_id: userId,
    plan: 'credit_builder',
    interval,
    stripe_status: status,
    updated_at: new Date().toISOString()
  };
  if (nextRenewal) row['next_renewal'] = nextRenewal;
  const { error } = await db.from('subscriptions').upsert(row, {
    onConflict: 'id'
  });
  if (error) console.error('[stripe-backend] sbUpsertSubscription error:', error);
}
// ---------------------------------------------------------------------------
// Action: setup_intent (mobile)
// JWT-authenticated. Creates (or reuses) a Stripe Customer, then creates a
// SetupIntent (usage=off_session) so the mobile payment sheet saves the card
// without charging. The subscription with 5-min trial is created separately
// via create_upsell_subscription after the card is confirmed.
//
// Request:  {} + Authorization: Bearer <supabase-access-token>
// Response: { client_secret, stripe_customer_id }
// ---------------------------------------------------------------------------
async function handleSetupIntentMobile(req) {
  console.log('[stripe-backend] handleSetupIntentMobile start');
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    console.warn('[stripe-backend] handleSetupIntentMobile missing Bearer token');
    return err('Unauthorized', 401);
  }
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_ANON_KEY) {
    console.error('[stripe-backend] handleSetupIntentMobile SUPABASE_ANON_KEY not set');
    return err('Server misconfigured', 500);
  }
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  console.log('[stripe-backend] handleSetupIntentMobile verifying user JWT');
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) {
    console.error('[stripe-backend] handleSetupIntentMobile auth failed:', authError);
    return err('Unauthorized', 401);
  }
  console.log(`[stripe-backend] handleSetupIntentMobile user_id=${user.id}`);
  // 1. Look up profile for existing stripe_customer_id
  const db = buildAdminClient();
  console.log(`[stripe-backend] handleSetupIntentMobile fetching profile user_id=${user.id}`);
  const { data: profile } = await db.from('profiles').select('email, phone, stripe_customer_id').eq('user_id', user.id).maybeSingle();
  const email = profile?.['email'] ?? user.email ?? '';
  const phone = profile?.['phone'] ?? '';
  let customerId = profile?.['stripe_customer_id'] ?? '';
  console.log(`[stripe-backend] handleSetupIntentMobile existing_customer_id=${customerId || 'none'}`);
  // 2. Create customer if needed
  if (!customerId) {
    console.log(`[stripe-backend] handleSetupIntentMobile creating Stripe customer email=${email}`);
    const customer = await stripe('POST', '/customers', {
      email,
      phone,
      metadata: {
        sb_user_id: user.id
      }
    });
    customerId = customer['id'];
    console.log(`[stripe-backend] handleSetupIntentMobile Stripe customer created customer_id=${customerId}`);
    // Persist customer id immediately so finalize_mobile can find it
    await db.from('profiles').update({
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString()
    }).eq('user_id', user.id);
    console.log(`[stripe-backend] handleSetupIntentMobile profile updated with customer_id=${customerId}`);
  }
  // 3. Create SetupIntent — saves card for future off-session charges
  console.log(`[stripe-backend] handleSetupIntentMobile creating SetupIntent customer_id=${customerId}`);
  const si = await stripe('POST', '/setup_intents', {
    customer: customerId,
    usage: 'off_session',
    payment_method_types: [
      'card'
    ],
    metadata: {
      hutsy_sb_uid: user.id,
      hutsy_source: 'mobile_signup'
    }
  });
  const clientSecret = si['client_secret'];
  if (!clientSecret) {
    console.error('[stripe-backend] handleSetupIntentMobile SetupIntent returned no client_secret');
    return err('Failed to create SetupIntent', 500);
  }
  console.log(`[stripe-backend] handleSetupIntentMobile success customer_id=${customerId} user_id=${user.id}`);
  return ok({
    client_secret: clientSecret,
    stripe_customer_id: customerId
  });
}
// ---------------------------------------------------------------------------
// Action: finalize
// Attaches/validates the payment method, creates the Supabase auth user,
// and upserts the profile row.
//
// Request:  { action, stripe_customer_id, payment_method_id?, email, name,
//             phone, zip, password, tos_consent, partner_consent? }
// Response: { sb_user_id }
// ---------------------------------------------------------------------------
const REQUIRE_PARTNER_CONSENT = (Deno.env.get('REQUIRE_PARTNER_CONSENT') ?? 'false') === 'true';
async function handleFinalize(body) {
  console.log('[stripe-backend] handleFinalize start');
  const customerId = body['stripe_customer_id']?.trim();
  const email = body['email']?.trim();
  const name = body['name']?.trim() ?? '';
  const phone = body['phone']?.trim() ?? '';
  const zip = body['zip']?.trim() ?? '';
  const password = body['password'] ?? '';
  const tosConsent = body['tos_consent'] === true || body['tos_consent'] === 'true' || body['tos_consent'] === '1';
  const partnerConsent = body['partner_consent'] === true || body['partner_consent'] === 'true';
  console.log(`[stripe-backend] handleFinalize customer_id=${customerId} email=${email} tos_consent=${tosConsent} partner_consent=${partnerConsent}`);
  if (!customerId) {
    console.warn('[stripe-backend] handleFinalize missing stripe_customer_id');
    return err('stripe_customer_id is required');
  }
  if (!email) {
    console.warn('[stripe-backend] handleFinalize missing email');
    return err('email is required');
  }
  if (!tosConsent) {
    console.warn('[stripe-backend] handleFinalize tos_consent not granted');
    return err('Please agree to Terms & Privacy.');
  }
  if (REQUIRE_PARTNER_CONSENT && !partnerConsent) {
    console.warn('[stripe-backend] handleFinalize partner_consent required but not granted');
    return err('Please consent to partner sharing.');
  }
  if (password.length < 8) {
    console.warn('[stripe-backend] handleFinalize password too short');
    return err('Password missing or too short.');
  }
  let pmId = body['payment_method_id']?.trim() ?? '';
  // 1) Ensure a payment method is attached to the customer
  if (pmId) {
    console.log(`[stripe-backend] handleFinalize attaching payment_method pm_id=${pmId} customer_id=${customerId}`);
    // Attach the provided PM and set as default
    await stripe('POST', `/payment_methods/${pmId}/attach`, {
      customer: customerId
    });
    await stripe('POST', `/customers/${customerId}`, {
      invoice_settings: {
        default_payment_method: pmId
      }
    });
    console.log(`[stripe-backend] handleFinalize payment_method attached pm_id=${pmId}`);
  } else {
    console.log(`[stripe-backend] handleFinalize no pm_id provided, fetching existing customer default`);
    // Try to use the customer's existing default PM
    const customer = await stripe('GET', `/customers/${customerId}`);
    const invoiceSettings = customer['invoice_settings'];
    const defaultPm = invoiceSettings?.['default_payment_method'];
    pmId = typeof defaultPm === 'string' ? defaultPm : defaultPm?.['id'] ?? '';
    if (!pmId) {
      console.log(`[stripe-backend] handleFinalize no default PM, falling back to first card customer_id=${customerId}`);
      // Fall back to first card on file
      const pms = await stripe('GET', '/payment_methods', {
        customer: customerId,
        type: 'card',
        limit: 1
      });
      const pmList = pms['data'];
      if (!pmList?.length) {
        console.warn(`[stripe-backend] handleFinalize no payment method found customer_id=${customerId}`);
        return err('No payment method found for customer.');
      }
      pmId = pmList[0]['id'];
      await stripe('POST', `/customers/${customerId}`, {
        invoice_settings: {
          default_payment_method: pmId
        }
      });
    }
    console.log(`[stripe-backend] handleFinalize resolved pm_id=${pmId}`);
  }
  // 2) Flatten consent to text (mirrors PHP)
  const flatConsent = `tos:${tosConsent} | partner:${partnerConsent}`;
  // 3) Create Supabase auth user
  console.log(`[stripe-backend] handleFinalize creating Supabase auth user email=${email}`);
  const sbUser = await sbAdminCreateUser(email, password, {
    full_name: name,
    phone,
    zip,
    consent: flatConsent,
    stripe_customer_id: customerId
  });
  if (!sbUser?.id) throw new Error('Missing Supabase user ID');
  console.log(`[stripe-backend] handleFinalize Supabase user created user_id=${sbUser.id}`);
  // 4) Upsert profile row
  console.log(`[stripe-backend] handleFinalize upserting profile user_id=${sbUser.id}`);
  await sbUpsertProfile(sbUser.id, email, name, phone, zip, flatConsent, customerId);
  console.log(`[stripe-backend] handleFinalize success user_id=${sbUser.id} customer_id=${customerId}`);
  return ok({
    sb_user_id: sbUser.id,
    message: 'Account created, card saved, and profile synced.'
  });
}
// ---------------------------------------------------------------------------
// Action: create_upsell_subscription
// Idempotently creates a Stripe Subscription for the credit-builder plan.
// Checks both client-supplied subscription_id and existing Stripe subscriptions
// for the customer before creating, so double-requests are safe.
//
// Request:  { action, stripe_customer_id, sb_user_id?, flow_id?,
//             subscription_id? }
// Response: { subscription_id }
// ---------------------------------------------------------------------------
async function handleCreateUpsellSubscription(body) {
  console.log('[stripe-backend] handleCreateUpsellSubscription start');
  const customerId = body['stripe_customer_id']?.trim();
  const sbUserId = body['sb_user_id']?.trim() ?? '';
  const flowId = body['flow_id']?.trim() ?? crypto.randomUUID();
  const existingSubId = body['subscription_id']?.trim() ?? '';
  console.log(`[stripe-backend] handleCreateUpsellSubscription customer_id=${customerId} sb_user_id=${sbUserId} flow_id=${flowId} existing_sub_id=${existingSubId || 'none'}`);
  if (!customerId) {
    console.warn('[stripe-backend] handleCreateUpsellSubscription missing stripe_customer_id');
    return err('stripe_customer_id is required');
  }
  const PRICE_ID = Deno.env.get('STRIPE_PRICE_ID');
  if (!PRICE_ID) {
    console.error('[stripe-backend] handleCreateUpsellSubscription STRIPE_PRICE_ID not set');
    return err('STRIPE_PRICE_ID not configured', 500);
  }
  // Guard 1: client already has a subscription id from a previous call
  if (existingSubId) {
    console.log(`[stripe-backend] handleCreateUpsellSubscription client already has sub_id=${existingSubId}, returning early`);
    return ok({
      subscription_id: existingSubId,
      message: 'Subscription already created (client).'
    });
  }
  // Guard 2: check Stripe for an existing non-dead subscription for this price
  console.log(`[stripe-backend] handleCreateUpsellSubscription checking Stripe for existing subscription customer_id=${customerId}`);
  const existingSubs = await stripe('GET', '/subscriptions', {
    customer: customerId,
    status: 'all',
    limit: 20,
    expand: [
      'data.items.data.price'
    ]
  });
  const subList = existingSubs['data'] ?? [];
  console.log(`[stripe-backend] handleCreateUpsellSubscription Stripe returned ${subList.length} subscription(s)`);
  for (const s of subList){
    if ([
      'canceled',
      'incomplete_expired'
    ].includes(s['status'])) continue;
    const items = s['items']?.['data'] ?? [];
    for (const it of items){
      const pid = it['price']?.['id'] ?? it['price'];
      if (pid === PRICE_ID) {
        console.log(`[stripe-backend] handleCreateUpsellSubscription found existing Stripe sub sub_id=${s['id']} status=${s['status']}`);
        return ok({
          subscription_id: s['id'],
          message: 'Subscription already exists (Stripe).'
        });
      }
    }
  }
  // Create the subscription with a 5-minute trial and an idempotency key
  const trialEnd = Math.floor(Date.now() / 1000) + 300;
  const idempotencyKey = `hutsy_upsell_${shortHash(customerId + '|' + flowId)}`;
  console.log(`[stripe-backend] handleCreateUpsellSubscription creating Stripe subscription customer_id=${customerId} price_id=${PRICE_ID} trial_end=${trialEnd}`);
  const sub = await stripe('POST', '/subscriptions', {
    customer: customerId,
    items: [
      {
        price: PRICE_ID
      }
    ],
    trial_end: trialEnd,
    collection_method: 'charge_automatically',
    metadata: {
      hutsy_flow_id: flowId,
      hutsy_sb_uid: sbUserId,
      hutsy_source: 'signup_step4'
    }
  }, idempotencyKey);
  console.log(`[stripe-backend] handleCreateUpsellSubscription Stripe subscription created sub_id=${sub['id']} status=${sub['status']}`);
  // Persist to Supabase subscriptions table if we have a user id
  if (sbUserId) {
    const items = sub['items']?.['data'];
    const plan = items?.[0]?.['plan'];
    const price = items?.[0]?.['price'];
    const interval = price?.['recurring']?.['interval'] ?? plan?.['interval'] ?? 'month';
    const status = sub['status'] ?? 'trialing';
    const periodEnd = sub['current_period_end'];
    const trialEndTs = sub['trial_end'];
    const nextRenewal = periodEnd ? new Date(periodEnd * 1000).toISOString() : trialEndTs ? new Date(trialEndTs * 1000).toISOString() : null;
    console.log(`[stripe-backend] handleCreateUpsellSubscription upserting Supabase subscription sub_id=${sub['id']} user_id=${sbUserId} status=${status}`);
    await sbUpsertSubscription(sub['id'], sbUserId, interval, status, nextRenewal);
  }
  console.log(`[stripe-backend] handleCreateUpsellSubscription success sub_id=${sub['id']} customer_id=${customerId}`);
  return ok({
    subscription_id: sub['id'],
    message: 'Subscription created. Billing starts after trial.'
  });
}
// ---------------------------------------------------------------------------
// Action: activate_mobile
// JWT-authenticated. Called after PaymentIntent is confirmed.
// Links stripe_customer_id to profile and upserts subscription row.
//
// Request:  { action, stripe_customer_id, subscription_id, sb_user_id? }
//           Authorization: Bearer <supabase-access-token>
// Response: { message }
// ---------------------------------------------------------------------------
async function handleActivateMobile(req, body) {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return err('Unauthorized', 401);
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured', 500);
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return err('Unauthorized', 401);
  const stripeCustomerId = body['stripe_customer_id']?.trim();
  const subscriptionId = body['subscription_id']?.trim();
  if (!stripeCustomerId) return err('stripe_customer_id is required');
  if (!subscriptionId) return err('subscription_id is required');
  const db = buildAdminClient();
  // Link customer to profile
  const { error: profileError } = await db.from('profiles').update({
    stripe_customer_id: stripeCustomerId,
    updated_at: new Date().toISOString()
  }).eq('user_id', user.id);
  if (profileError) console.error('[stripe-backend] activate_mobile profile error:', profileError);
  // Fetch subscription status from Stripe
  let interval = 'month', status = 'active', nextRenewal = null;
  try {
    const sub = await stripe('GET', `/subscriptions/${subscriptionId}`);
    const items = sub['items']?.['data'] ?? [];
    const price = items[0]?.['price'];
    interval = price?.['recurring']?.['interval'] ?? 'month';
    status = sub['status'] ?? 'active';
    const periodEnd = sub['current_period_end'];
    nextRenewal = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
  } catch (e) {
    console.error('[stripe-backend] activate_mobile stripe fetch error:', e);
  }
  await sbUpsertSubscription(subscriptionId, user.id, interval, status, nextRenewal);
  return ok({
    message: 'Subscription activated.'
  });
}
// ---------------------------------------------------------------------------
// Action: delete_user
// JWT-authenticated. Deletes the calling user from Supabase auth.
// Called on mobile when payment fails to clean up the incomplete account.
//
// Request:  { action } + Authorization: Bearer <supabase-access-token>
// Response: { message }
// ---------------------------------------------------------------------------
async function handleDeleteUser(req) {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return err('Unauthorized', 401);
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured', 500);
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return err('Unauthorized', 401);
  const db = buildAdminClient();
  const { error } = await db.auth.admin.deleteUser(user.id);
  if (error) {
    console.error('[stripe-backend] delete_user error:', error);
    return err('Failed to delete user', 500);
  }
  return ok({
    message: 'User deleted.'
  });
}
// ---------------------------------------------------------------------------
// Action: finalize_mobile
// Mobile-only: user already exists in Supabase (created via OTP).
// Validates JWT, links stripe_customer_id to their profile row.
//
// Request:  { action, stripe_customer_id, tos_consent }
//           Authorization: Bearer <supabase-access-token>
// Response: { message }
// ---------------------------------------------------------------------------
async function handleFinalizeMobile(req, body) {
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return err('Unauthorized', 401);
  const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
  if (!SUPABASE_ANON_KEY) return err('Server misconfigured', 500);
  // Resolve the calling user via their JWT
  const userClient = createClient(Deno.env.get('SUPABASE_URL') ?? '', SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return err('Unauthorized', 401);
  const stripeCustomerId = body['stripe_customer_id']?.trim();
  const tosConsent = body['tos_consent'] === true || body['tos_consent'] === 'true';
  if (!stripeCustomerId) return err('stripe_customer_id is required');
  if (!tosConsent) return err('Please agree to Terms & Privacy.');
  const db = buildAdminClient();
  const { error } = await db.from('profiles').update({
    stripe_customer_id: stripeCustomerId,
    updated_at: new Date().toISOString()
  }).eq('user_id', user.id);
  if (error) {
    console.error('[stripe-backend] finalize_mobile error:', error);
    return err('Failed to update profile', 500);
  }
  return ok({
    message: 'Profile linked to Stripe customer.'
  });
}
// Short deterministic hash for idempotency key — first 24 hex chars of MD5 (mirrors PHP)
function shortHash(input) {
  return createHash('md5').update(input).digest('hex').slice(0, 24);
}
// ---------------------------------------------------------------------------
// Entry point — dispatch by action
// ---------------------------------------------------------------------------
Deno.serve(async (req)=>{
  console.log(`[stripe-backend] request method=${req.method}`);
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: CORS
    });
  }
  let body;
  try {
    body = await req.json();
  } catch  {
    console.warn('[stripe-backend] invalid JSON body');
    return err('invalid json');
  }
  const action = body['action'];
  console.log(`[stripe-backend] action=${action ?? '(none)'}`);
  try {
    switch(action){
      // ── Mobile (new) ──────────────────────────────────────────────────────
      case 'setup_intent':
        return await handleSetupIntentMobile(req);
      case 'activate_mobile':
        return await handleActivateMobile(req, body);
      case 'delete_user':
        return await handleDeleteUser(req);
      // ── Web (legacy) ──────────────────────────────────────────────────────
      case 'finalize':
        return await handleFinalize(body);
      case 'create_upsell_subscription':
        return await handleCreateUpsellSubscription(body);
      case 'finalize_mobile':
        return await handleFinalizeMobile(req, body);
      default:
        console.warn(`[stripe-backend] unknown action="${action ?? '(none)'}"`);
        return err(`unknown action: ${action ?? '(none)'}`);
    }
  } catch (e) {
    console.error(`[stripe-backend] action=${action} error:`, e);
    return err(e.message ?? 'internal error', 500);
  }
});
