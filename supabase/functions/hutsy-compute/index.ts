import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { decodeJwt } from "@panva/jose";
import { AuthMiddleware, getAuthToken } from "../_shared/jwt/default.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Admin client — full service role access, used only after identity is verified
function buildAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

function buildPlaidClient(plaidEnv: string) {
  const clientId = Deno.env.get('PLAID_CLIENT_ID');
  const secret   = Deno.env.get('PLAID_SECRET');
  if (!clientId || !secret) throw new Error('Missing Plaid credentials');
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[plaidEnv] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret },
    },
  }));
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// delete_account — full account closure
// ---------------------------------------------------------------------------

/** 1) Remove every Plaid item from Plaid (stops billing) then wipe Supabase rows. */
// deno-lint-ignore no-explicit-any
async function deletePlaidData(db: SupabaseClient<any>, userId: string) {
  const plaidEnv = (Deno.env.get('PLAID_ENV') ?? 'production').toLowerCase();
  const plaid = buildPlaidClient(plaidEnv);

  const { data: secrets } = await db
    .from('plaid_item_secrets')
    .select('item_id, access_token')
    .eq('user_id', userId)
    .eq('plaid_env', plaidEnv);

  for (const { item_id: itemId, access_token: token } of secrets ?? []) {
    if (!itemId || !token) continue;
    try {
      await plaid.itemRemove({ access_token: token });
      console.log(`[delete_account] plaid item removed item=${itemId}`);
    } catch (err: unknown) {
      const code = (err as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code ?? '';
      if (code !== 'ITEM_NOT_FOUND') {
        console.error(`[delete_account] plaid itemRemove failed item=${itemId} error=${code}`);
      }
    }
  }

  const tables = [
    'plaid_transactions',
    'plaid_recurring',
    'plaid_accounts',
    'plaid_webhook_events',
    'plaid_item_secrets',
    'plaid_items',
  ];
  for (const table of tables) {
    const { error } = await db.from(table).delete().eq('user_id', userId);
    if (error) console.error(`[delete_account] failed to delete ${table}:`, error.message);
  }
  console.log(`[delete_account] plaid data wiped user=${userId}`);
}

/** 2) Cancel active Stripe subscriptions then delete the Stripe customer. */
// deno-lint-ignore no-explicit-any
async function deleteStripeData(db: SupabaseClient<any>, userId: string) {
  const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');
  if (!STRIPE_SECRET_KEY) {
    console.warn('[delete_account] STRIPE_SECRET_KEY not set, skipping Stripe deletion');
    return;
  }

  const { data: profile } = await db
    .from('profiles')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle() as { data: { stripe_customer_id?: string } | null };

  const customerId = profile?.stripe_customer_id;
  if (!customerId) {
    console.log(`[delete_account] no stripe_customer_id for user=${userId}, skipping`);
    return;
  }

  const headers = { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` };

  // Cancel all active subscriptions first
  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=active&limit=10`,
    { headers },
  );
  if (subsRes.ok) {
    const subsBody = await subsRes.json();
    for (const sub of subsBody?.data ?? []) {
      const cancelRes = await fetch(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(sub.id)}`,
        { method: 'DELETE', headers },
      );
      if (cancelRes.ok) {
        console.log(`[delete_account] stripe subscription cancelled sub=${sub.id}`);
      } else {
        console.error(`[delete_account] stripe cancel failed sub=${sub.id} status=${cancelRes.status}`);
      }
    }
  } else {
    console.error(`[delete_account] stripe subscriptions list failed status=${subsRes.status}`);
  }

  // Delete the customer (cascades invoices, payment methods, etc.)
  const delRes = await fetch(
    `https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`,
    { method: 'DELETE', headers },
  );
  if (delRes.ok) {
    console.log(`[delete_account] stripe customer deleted customer=${customerId}`);
  } else {
    console.error(`[delete_account] stripe customer delete failed status=${delRes.status} body=${await delRes.text()}`);
  }
}

/** 3) Revoke all RevenueCat entitlements by deleting the subscriber. */
async function deleteRevenueCatData(userId: string) {
  const RC_API_KEY = Deno.env.get('REVENUECAT_API_KEY');
  if (!RC_API_KEY) {
    console.warn('[delete_account] REVENUECAT_API_KEY not set, skipping RevenueCat deletion');
    return;
  }
  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}/delete`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RC_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );
  if (res.ok) {
    console.log(`[delete_account] revenuecat subscriber deleted user=${userId}`);
  } else {
    console.error(`[delete_account] revenuecat delete failed status=${res.status} body=${await res.text()}`);
  }
}

/** 4) Delete all remaining Supabase rows then hard-delete the Auth user. */
// deno-lint-ignore no-explicit-any
async function deleteSupabaseData(db: SupabaseClient<any>, userId: string) {
  const tables = [
    'payments',
    'subscriptions',
    'chat_messages',
    'device_push_tokens',
  ];
  for (const table of tables) {
    const { error } = await db.from(table).delete().eq('user_id', userId);
    if (error) console.error(`[delete_account] failed to delete ${table}:`, error.message);
  }

  // Profile last (FK target)
  const { error: profErr } = await db.from('profiles').delete().eq('user_id', userId);
  if (profErr) console.error('[delete_account] profiles delete error:', profErr.message);

  // Hard-delete the Auth user — requires service role key
  const { error: authErr } = await db.auth.admin.deleteUser(userId);
  if (authErr) {
    console.error('[delete_account] auth.admin.deleteUser error:', authErr.message);
  } else {
    console.log(`[delete_account] auth user deleted user=${userId}`);
  }
}

/** Full account closure for the authenticated user.
 *  Each service is wrapped independently — a failure in one never blocks the others. */
async function deleteAccount(userId: string) {
  console.log(`[delete_account] starting full account closure user=${userId}`);
  const db = buildAdminClient();
  const errors: Record<string, string> = {};

  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[delete_account] step=${name} failed: ${msg}`);
      errors[name] = msg;
    }
  };

  await step('plaid',      () => deletePlaidData(db, userId));
  await step('stripe',     () => deleteStripeData(db, userId));
  await step('revenuecat', () => deleteRevenueCatData(userId));
  await step('supabase',   () => deleteSupabaseData(db, userId));  // auth deletion last

  const hadErrors = Object.keys(errors).length > 0;
  console.log(`[delete_account] account closure complete user=${userId} errors=${JSON.stringify(errors)}`);
  return { ok: true, user_id: userId, ...(hadErrors && { partial_errors: errors }) };
}

// ---------------------------------------------------------------------------
// Entry point — wrapped with AuthMiddleware, action router inside
// ---------------------------------------------------------------------------
Deno.serve((req) =>
  AuthMiddleware(req, async (req) => {
    if (req.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405);
    }

    let body: { action?: string };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }

    const { action } = body;

    // Decode user_id from the already-verified JWT — never from the request body
    const token = getAuthToken(req);
    const { sub: userId } = decodeJwt(token);
    if (!userId) return json({ ok: false, error: 'invalid_token' }, 401);

    console.log(`[hutsy-compute] action=${action} user_id=${userId}`);

    if (action === 'delete_account') {
      try {
        const result = await deleteAccount(userId);
        return json(result);
      } catch (e) {
        console.error('[hutsy-compute] delete_account error:', e);
        return json({ ok: false, error: e instanceof Error ? e.message : 'unknown_error' }, 500);
      }
    }

    return json({ ok: false, error: `unknown action: ${action}` }, 400);
  })
);
