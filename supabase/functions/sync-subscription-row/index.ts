import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
Deno.serve(async (req)=>{
  console.log(`[sync-subscription-row] request method=${req.method}`);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return json({
      ok: false,
      error: "method_not_allowed"
    }, 405);
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.warn("[sync-subscription-row] missing Authorization header");
      return json({
        ok: false,
        error: "missing_authorization_header"
      }, 401);
    }
    const supabaseUserClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: userData, error: userError } = await supabaseUserClient.auth.getUser();
    if (userError || !userData.user) {
      console.warn("[sync-subscription-row] auth failed", userError?.message);
      return json({
        ok: false,
        error: "unauthorized"
      }, 401);
    }
    const userId = userData.user.id;
    console.log(`[sync-subscription-row] authenticated user_id=${userId}`);
    const body = await req.json().catch(()=>({}));
    const plan = (body?.plan ?? "credit_builder").toString();
    const intervalRaw = body?.interval;
    const interval = intervalRaw == null || intervalRaw.toString().trim().isEmpty ? null : intervalRaw.toString().trim();
    const stripeStatus = (body?.stripe_status ?? "").toString().trim();
    const nextRenewalRaw = body?.next_renewal;
    const nextRenewal = nextRenewalRaw == null || nextRenewalRaw.toString().trim().isEmpty ? null : nextRenewalRaw.toString().trim();
    const source = (body?.source ?? "revenuecat").toString().trim();
    console.log(`[sync-subscription-row] params plan=${plan} interval=${interval} stripe_status=${stripeStatus} source=${source} next_renewal=${nextRenewal}`);
    if (!stripeStatus) {
      console.warn("[sync-subscription-row] missing stripe_status");
      return json({
        ok: false,
        error: "missing_stripe_status"
      }, 400);
    }
    const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    console.log(`[sync-subscription-row] looking up existing subscription row for user_id=${userId}`);
    const { data: existingRow, error: existingError } = await supabaseAdmin.from("subscriptions").select("id, user_id").eq("user_id", userId).maybeSingle();
    if (existingError) {
      console.error("[sync-subscription-row] existing row lookup failed:", existingError);
      return json({
        ok: false,
        error: "existing_lookup_failed",
        details: existingError.message
      }, 500);
    }
    console.log(`[sync-subscription-row] existing row found=${!!existingRow} id=${existingRow?.id ?? "none"}`);
    const payload = {
      plan,
      interval,
      stripe_status: stripeStatus,
      source,
      updated_at: new Date().toISOString(),
      next_renewal: nextRenewal
    };
    if (existingRow) {
      console.log(`[sync-subscription-row] updating existing row id=${existingRow.id} user_id=${userId}`);
      const { error: updateError } = await supabaseAdmin.from("subscriptions").update(payload).eq("user_id", userId);
      if (updateError) {
        console.error("[sync-subscription-row] update failed:", updateError);
        return json({
          ok: false,
          error: "update_failed",
          details: updateError.message
        }, 500);
      }
      console.log(`[sync-subscription-row] update success user_id=${userId} id=${existingRow.id}`);
      return json({
        ok: true,
        action: "updated",
        user_id: userId,
        id: existingRow.id
      });
    }
    const syntheticId = `rc_${userId}`;
    console.log(`[sync-subscription-row] inserting new row id=${syntheticId} user_id=${userId}`);
    const { error: insertError } = await supabaseAdmin.from("subscriptions").insert({
      id: syntheticId,
      user_id: userId,
      ...payload
    });
    if (insertError) {
      console.error("[sync-subscription-row] insert failed:", insertError);
      return json({
        ok: false,
        error: "insert_failed",
        details: insertError.message
      }, 500);
    }
    console.log(`[sync-subscription-row] insert success user_id=${userId} id=${syntheticId}`);
    return json({
      ok: true,
      action: "inserted",
      user_id: userId,
      id: syntheticId
    });
  } catch (e) {
    console.error("[sync-subscription-row] fatal error:", e);
    return json({
      ok: false,
      error: e instanceof Error ? e.message : "unknown_error"
    }, 500);
  }
});
