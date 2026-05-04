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
    console.log(`[exchange-plaid-token] authenticated user_id=${user.id}`);
    const body = await req.json().catch(()=>({}));
    const publicToken = body?.public_token;
    const institutionName = (body?.institution_name ?? "").toString();
    console.log(`[exchange-plaid-token] institution_name="${institutionName}" public_token_present=${!!publicToken}`);
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
    const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";
    console.log(`[exchange-plaid-token] plaid_env=${PLAID_ENV}`);
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
    console.log(`[exchange-plaid-token] calling Plaid itemPublicTokenExchange user_id=${user.id}`);
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });
    const { access_token, item_id } = exchangeResponse.data;
    console.log(`[exchange-plaid-token] token exchange success item_id=${item_id} user_id=${user.id}`);
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
      console.error(`[exchange-plaid-token] plaid_items upsert failed item_id=${item_id}:`, itemError);
      throw itemError;
    }
    console.log(`[exchange-plaid-token] plaid_items upsert ok item_id=${item_id}`);
    console.log(`[exchange-plaid-token] upserting plaid_item_secrets item_id=${item_id} user_id=${user.id}`);
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
      console.error(`[exchange-plaid-token] plaid_item_secrets upsert failed item_id=${item_id}:`, secretError);
      throw secretError;
    }
    console.log(`[exchange-plaid-token] plaid_item_secrets upsert ok item_id=${item_id}`);
    if (PLAID_ENV === "production") {
      console.log(`[exchange-plaid-token] clearing bank_disconnected_at for user_id=${user.id}`);
      await adminClient.from("profiles").update({
        bank_disconnected_at: null
      }).eq("user_id", user.id);
    }
    console.log(`[exchange-plaid-token] success item_id=${item_id} user_id=${user.id} institution="${institutionName}"`);
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
    console.error("[exchange-plaid-token] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to exchange token";
    const errorDetails = error && typeof error === "object" && "response" in error ? error.response?.data : null;
    return new Response(JSON.stringify({
      error: errorMessage,
      details: errorDetails
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
