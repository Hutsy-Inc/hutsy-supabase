import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function buildAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
}

function buildPlaidClient(plaidEnv: string) {
  const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
  const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) throw new Error("Missing Plaid credentials");

  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[plaidEnv] ?? PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET,
        },
      },
    }),
  );
}

async function purgePlaidSupabaseItem(db: any, userId: string, itemId: string, env: string) {
  const match = { item_id: itemId, user_id: userId, plaid_env: env };
  await db.from("plaid_transactions").delete().match(match);
  await db.from("plaid_recurring").delete().match(match);
  await db.from("plaid_accounts").delete().match(match);
  await db.from("plaid_webhook_events").delete().match(match);
  await db.from("plaid_item_secrets").delete().match(match);
  await db.from("plaid_items").delete().match(match);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authenticate the user making the request
    const authHeader = req.headers.get("Authorization")!;
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });
    }

    const { item_id } = await req.json();
    if (!item_id) {
      return new Response(JSON.stringify({ error: "Missing item_id" }), { status: 400, headers: corsHeaders });
    }

    const db = buildAdminClient();
    const env = (Deno.env.get("PLAID_ENV") ?? "production").toLowerCase();

    // 2. Fetch the access token for this item_id to ensure ownership
    const { data: secrets, error: secsErr } = await db
      .from("plaid_item_secrets")
      .select("access_token")
      .eq("item_id", item_id)
      .eq("user_id", user.id)
      .eq("plaid_env", env)
      .single();

    if (secsErr || !secrets) {
      return new Response(JSON.stringify({ error: "Item not found or unauthorized" }), { status: 404, headers: corsHeaders });
    }

    // 3. Call Plaid to remove the item
    const plaid = buildPlaidClient(env);
    let successfullyRemoved = false;
    try {
      await plaid.itemRemove({ access_token: secrets.access_token });
      successfullyRemoved = true; // If it doesn't throw, it succeeded!
    } catch (err: any) {
      const errCode = err?.response?.data?.error_code;
      // If it's already gone or token is invalid, treat as success so we can purge our DB
      if (errCode === "ITEM_NOT_FOUND" || errCode === "INVALID_ACCESS_TOKEN") {
        successfullyRemoved = true;
      } else {
        throw new Error(`Plaid Error: ${errCode}`);
      }
    }

    // 4. Purge from Supabase
    if (successfullyRemoved) {
      await purgePlaidSupabaseItem(db, user.id, item_id, env);
      
      // Check if user has any remaining items, if not, update profile
      const { count } = await db.from('plaid_items').select('*', { count: 'exact', head: true }).eq('user_id', user.id);
      if (count === 0) {
        await db.from('profiles').update({ bank_disconnected_at: new Date().toISOString() }).eq('user_id', user.id);
      }

      return new Response(JSON.stringify({ ok: true, message: "Bank disconnected successfully" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error("Unexpected response from Plaid");

  } catch (err: any) {
    console.error("[remove-plaid-item] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});