/**
 * Supabase Edge Function to create a Plaid Link Token.
 *
 * This function handles HTTP POST requests to generate a Plaid Link Token for a user,
 * using credentials and configuration provided via environment variables. It supports
 * CORS preflight requests and returns appropriate error messages for missing parameters
 * or Plaid API errors.
 *
 * Environment Variables:
 * - PLAID_CLIENT_ID: Plaid API client ID.
 * - PLAID_SECRET: Plaid API secret.
 * - PLAID_ENV: Plaid environment ('sandbox', 'development', or 'production').
 *
 * Request Body Parameters:
 * - email (string, required): User's email address (used as client_user_id).
 * - phone (string, optional): User's phone number.
 *
 * Responses:
 * - 200: Returns a JSON object containing the generated `link_token`.
 * - 400: Returns an error if required parameters are missing.
 * - 500: Returns an error if the Plaid API call fails or other exceptions occur.
 *
 * Example Usage:
 * See the code comments for a sample `curl` command to invoke this function locally.
 */ import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "npm:plaid";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
Deno.serve(async (req)=>{
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
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
    const { data: userData, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !userData.user) {
      console.error("[create_plaid_link] auth.getUser failed", userError);
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
    const PLAID_CLIENT_ID = Deno.env.get("PLAID_CLIENT_ID");
    const PLAID_SECRET = Deno.env.get("PLAID_SECRET");
    const PLAID_ENV = Deno.env.get("PLAID_ENV") || "sandbox";
    const PLAID_IOS_REDIRECT_URI = Deno.env.get("PLAID_IOS_REDIRECT_URI") || "";
    const PLAID_ANDROID_PACKAGE_NAME = Deno.env.get("PLAID_ANDROID_PACKAGE_NAME") || "";
    if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
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
    const webhookUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/plaid-webhook`;
    const body = await req.json().catch(()=>({}));
    const platform = (body?.platform ?? "").toString().toLowerCase();
    const request = {
      user: {
        client_user_id: user.id
      },
      client_name: "Hutsy",
      products: [
        Products.Transactions,
        Products.Auth
      ],
      country_codes: [
        CountryCode.Ca
      ],
      language: "en",
      webhook: webhookUrl
    };
    if (platform === "ios" && PLAID_IOS_REDIRECT_URI) {
      request.redirect_uri = PLAID_IOS_REDIRECT_URI;
    }
    if (platform === "android" && PLAID_ANDROID_PACKAGE_NAME) {
      request.android_package_name = PLAID_ANDROID_PACKAGE_NAME;
    }
    const response = await plaidClient.linkTokenCreate(request);
    return new Response(JSON.stringify({
      link_token: response.data.link_token
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("[create_plaid_link] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to create link token";
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
}); /* To invoke locally:

  1. Set environment variables in .env file:
     PLAID_CLIENT_ID=your_client_id
     PLAID_SECRET=your_secret
     PLAID_ENV=sandbox

  2. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)

  3. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create_plaid_link' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{
      "email": "user@example.com",
      "phone": "+1 415 5550123"
    }'

*/ 
