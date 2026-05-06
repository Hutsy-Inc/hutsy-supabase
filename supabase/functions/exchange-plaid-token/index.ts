import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Configuration, PlaidApi, PlaidEnvironments } from "npm:plaid";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
Deno.serve(async (req)=>{
  console.log(`[exchange-plaid-token] request method=${req.method}`);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    console.warn("[exchange-plaid-token] rejected non-POST request");
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.warn("[exchange-plaid-token] missing Authorization header");
      return new Response(JSON.stringify({
        error: "Missing Authorization header"
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const supabaseClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    console.log("[exchange-plaid-token] verifying user JWT");
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData.user) {
      console.error("[exchange-plaid-token] auth.getUser failed", userError);
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const user = userData.user;
    const userIdShort = user.id.substring(0, 8);
    console.log(`[exchange-plaid-token] called userId=${userIdShort}`);

    const PLAID_ENV = Deno.env.get("PLAID_ENV");
    if (!PLAID_ENV) {
      console.error("[exchange-plaid-token] PLAID_ENV secret is not set");
      return new Response(JSON.stringify({ error: "PLAID_ENV missing" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    console.log(`[exchange-plaid-token] PLAID_ENV=${PLAID_ENV}`);

    const body = await req.json().catch(()=>({}));
    const publicToken = body?.public_token;
    const institutionName = (body?.institution_name ?? "").toString();

    console.log(`[exchange-plaid-token] public_token_present=${Boolean(publicToken)} length=${publicToken?.length ?? 0}`);
    console.log(`[exchange-plaid-token] institution_name_present=${Boolean(institutionName && institutionName.length > 0)}`);

    if (!publicToken) {
      console.warn("[exchange-plaid-token] missing public_token in request body");
      return new Response(JSON.stringify({
        error: "Missing public_token"
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
      console.error("[exchange-plaid-token] missing Plaid credentials in environment");
      throw new Error("Missing Plaid credentials");
    }
    const configuration = new Configuration({
      basePath: PlaidEnvironments[PLAID_ENV],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET
        }
      }
    });
    const plaidClient = new PlaidApi(configuration);
    console.log("[exchange-plaid-token] calling itemPublicTokenExchange");
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });
    const { access_token, item_id } = exchangeResponse.data;
    console.log(`[exchange-plaid-token] item_id=${item_id} access_token_received=${Boolean(access_token)}`);

    const adminClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    const now = new Date().toISOString();
    console.log(`[exchange-plaid-token] upserting plaid_items item_id=${item_id} user_id=${user.id}`);
    const { error: itemError } = await adminClient.from("plaid_items").upsert({
      user_id: user.id,
      item_id,
      institution_name: institutionName,
      status: "connected",
      plaid_env: PLAID_ENV,
      updated_at: now
    }, {
      onConflict: "item_id"
    });
    if (itemError) {
      console.error(`[exchange-plaid-token] plaid_items upsert failed: ${itemError.message}`);
      throw itemError;
    }
    console.log(`[exchange-plaid-token] plaid_items upsert ok item_id=${item_id}`);
    console.log(`[exchange-plaid-token] upserting plaid_item_secrets item_id=${item_id} userId=${userIdShort}`);
    const { error: secretError } = await adminClient.from("plaid_item_secrets").upsert({
      user_id: user.id,
      item_id,
      access_token,
      plaid_env: PLAID_ENV,
      updated_at: now
    }, {
      onConflict: "item_id"
    });
    if (secretError) {
      console.error(`[exchange-plaid-token] plaid_item_secrets upsert failed: ${secretError.message}`);
      throw secretError;
    }
    console.log(`[exchange-plaid-token] plaid_item_secrets upsert ok item_id=${item_id}`);
    if (PLAID_ENV === "production") {
      console.log(`[exchange-plaid-token] clearing bank_disconnected_at for user_id=${user.id}`);
      await adminClient.from("profiles").update({
        bank_disconnected_at: null
      }).eq("user_id", user.id);
      console.log(`[exchange-plaid-token] profiles.bank_disconnected_at cleared userId=${userIdShort}`);
    }
    console.log(`[exchange-plaid-token] success status=connected institution=${institutionName}`);
    return new Response(JSON.stringify({
      item_id,
      status: "connected",
      institution: institutionName,
      supabase_user: user.id
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("[exchange-plaid-token] Error:", error instanceof Error ? error.message : error);
    const plaidErr = error && typeof error === "object" && "response" in error ? (error as any).response?.data : null;
    if (plaidErr) {
      console.error(`[exchange-plaid-token] plaid error_code=${plaidErr.error_code} error_message=${plaidErr.error_message} request_id=${plaidErr.request_id}`);
    }
    const errorMessage = error instanceof Error ? error.message : "Failed to exchange token";
    return new Response(JSON.stringify({
      error: errorMessage,
      details: plaidErr
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
