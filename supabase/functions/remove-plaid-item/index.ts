import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
function buildAdminClient() {
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
}
function buildPlaidClient(plaidEnv) {
  const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
  const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) throw new Error("Missing Plaid credentials");
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[plaidEnv] ?? PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": PLAID_SECRET
      }
    }
  }));
}
async function purgePlaidSupabaseItem(db, userId, itemId, env) {
  console.log(`[remove-plaid-item] purging supabase data item=${itemId} user=${userId} env=${env}`);
  const match = {
    item_id: itemId,
    user_id: userId,
    plaid_env: env
  };
  await db.from("plaid_transactions").delete().match(match);
  await db.from("plaid_recurring").delete().match(match);
  await db.from("plaid_accounts").delete().match(match);
  await db.from("plaid_webhook_events").delete().match(match);
  await db.from("plaid_item_secrets").delete().match(match);
  await db.from("plaid_items").delete().match(match);
  console.log(`[remove-plaid-item] supabase purge complete item=${itemId}`);
}
Deno.serve(async (req)=>{
  console.log(`[remove-plaid-item] request method=${req.method}`);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  try {
    // 1. Authenticate the user making the request
    const authHeader = req.headers.get("Authorization");
    const supabaseClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      console.warn("[remove-plaid-item] auth failed", userError?.message);
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: corsHeaders
      });
    }
    console.log(`[remove-plaid-item] authenticated user_id=${user.id}`);
    const { item_id } = await req.json();
    if (!item_id) {
      console.warn("[remove-plaid-item] missing item_id in request body");
      return new Response(JSON.stringify({
        error: "Missing item_id"
      }), {
        status: 400,
        headers: corsHeaders
      });
    }
    const db = buildAdminClient();
    const env = (Deno.env.get("PLAID_ENV") ?? "production").toLowerCase();
    console.log(`[remove-plaid-item] item_id=${item_id} env=${env}`);
    // 2. Fetch the access token for this item_id to ensure ownership
    console.log(`[remove-plaid-item] fetching access token for item_id=${item_id} user_id=${user.id}`);
    const { data: secrets, error: secsErr } = await db.from("plaid_item_secrets").select("access_token").eq("item_id", item_id).eq("user_id", user.id).eq("plaid_env", env).single();
    if (secsErr || !secrets) {
      console.warn(`[remove-plaid-item] item not found or unauthorized item_id=${item_id} user_id=${user.id}`);
      return new Response(JSON.stringify({
        error: "Item not found or unauthorized"
      }), {
        status: 404,
        headers: corsHeaders
      });
    }
    console.log(`[remove-plaid-item] access token found for item_id=${item_id}`);
    // 3. Call Plaid to remove the item
    const plaid = buildPlaidClient(env);
    let successfullyRemoved = false;
    console.log(`[remove-plaid-item] calling Plaid itemRemove item_id=${item_id}`);
    try {
      await plaid.itemRemove({
        access_token: secrets.access_token
      });
      successfullyRemoved = true; // If it doesn't throw, it succeeded!
      console.log(`[remove-plaid-item] Plaid itemRemove success item_id=${item_id}`);
    } catch (err) {
      const errCode = err?.response?.data?.error_code;
      console.warn(`[remove-plaid-item] Plaid itemRemove error_code=${errCode} item_id=${item_id}`);
      // If it's already gone or token is invalid, treat as success so we can purge our DB
      if (errCode === "ITEM_NOT_FOUND" || errCode === "INVALID_ACCESS_TOKEN") {
        successfullyRemoved = true;
        console.log(`[remove-plaid-item] treating error_code=${errCode} as successful removal`);
      } else {
        throw new Error(`Plaid Error: ${errCode}`);
      }
    }
    // 4. Purge from Supabase
    if (successfullyRemoved) {
      await purgePlaidSupabaseItem(db, user.id, item_id, env);
      // Check if user has any remaining items, if not, update profile
      console.log(`[remove-plaid-item] checking remaining plaid items for user_id=${user.id}`);
      const { count } = await db.from('plaid_items').select('*', {
        count: 'exact',
        head: true
      }).eq('user_id', user.id);
      console.log(`[remove-plaid-item] remaining plaid items count=${count}`);
      if (count === 0) {
        console.log(`[remove-plaid-item] no remaining items, updating bank_disconnected_at for user_id=${user.id}`);
        await db.from('profiles').update({
          bank_disconnected_at: new Date().toISOString()
        }).eq('user_id', user.id);
      }
      console.log(`[remove-plaid-item] bank disconnected successfully item_id=${item_id} user_id=${user.id}`);
      return new Response(JSON.stringify({
        ok: true,
        message: "Bank disconnected successfully"
      }), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    throw new Error("Unexpected response from Plaid");
  } catch (err) {
    console.error("[remove-plaid-item] Error:", err.message);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
