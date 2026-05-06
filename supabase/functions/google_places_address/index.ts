import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
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
function getComponent(components, type) {
  return components.find((c)=>(c.types ?? []).includes(type));
}
Deno.serve(async (req)=>{
  console.log(`[google_places_address] request method=${req.method}`);
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    console.warn("[google_places_address] rejected non-POST request");
    return json({
      ok: false,
      error: "method_not_allowed"
    }, 405);
  }
  console.log("[google_places_address] verifying user JWT");
  const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: {
      headers: {
        Authorization: req.headers.get("Authorization") ?? ""
      }
    }
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    console.error("[google_places_address] auth.getUser failed:", userError);
    return json({
      ok: false,
      error: "unauthorized"
    }, 401);
  }
  console.log(`[google_places_address] authenticated user_id=${userData.user.id}`);
  const GOOGLE_PLACES_API_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
  if (!GOOGLE_PLACES_API_KEY) {
    console.error("[google_places_address] GOOGLE_PLACES_API_KEY not set");
    return json({
      ok: false,
      error: "missing_google_places_api_key"
    }, 500);
  }
  try {
    const body = await req.json().catch(()=>({}));
    const action = (body?.action ?? "").toString().trim();
    console.log(`[google_places_address] action=${action}`);
    if (action === "autocomplete") {
      const input = (body?.input ?? "").toString().trim();
      console.log(`[google_places_address] autocomplete input_length=${input.length}`);
      if (input.length < 3) {
        console.log("[google_places_address] autocomplete input too short, returning empty suggestions");
        return json({
          ok: true,
          suggestions: []
        });
      }
      const sessionToken = (body?.session_token ?? "").toString().trim() || crypto.randomUUID();
      console.log(`[google_places_address] calling Google Places autocomplete session_token=${sessionToken}`);
      const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY
        },
        body: JSON.stringify({
          input,
          sessionToken,
          includedRegionCodes: [
            "us"
          ]
        })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`[google_places_address] autocomplete API error status=${res.status}`, data);
        return json({
          ok: false,
          error: "autocomplete_failed",
          details: data
        }, 500);
      }
      const rawPredictions = Array.isArray(data?.suggestions) ? data.suggestions : [];
      const suggestions = rawPredictions.map((item)=>{
        const pred = item?.placePrediction;
        if (!pred) return null;
        return {
          place_id: pred.placeId ?? "",
          text: pred.text?.text ?? pred.structuredFormat?.mainText?.text ?? ""
        };
      }).filter((x)=>x && x.place_id && x.text);
      console.log(`[google_places_address] autocomplete returned suggestions=${suggestions.length}`);
      return json({
        ok: true,
        session_token: sessionToken,
        suggestions
      });
    }
    if (action === "details") {
      const placeId = (body?.place_id ?? "").toString().trim();
      const sessionToken = (body?.session_token ?? "").toString().trim();
      console.log(`[google_places_address] details place_id=${placeId} session_token=${sessionToken}`);
      if (placeId.isEmpty) {
        console.warn("[google_places_address] missing place_id in details request");
        return json({
          ok: false,
          error: "missing_place_id"
        }, 400);
      }
      const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);
      console.log(`[google_places_address] calling Google Places details place_id=${placeId}`);
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "X-Goog-Api-Key": GOOGLE_PLACES_API_KEY,
          "X-Goog-FieldMask": "addressComponents,formattedAddress,postalAddress"
        }
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`[google_places_address] details API error status=${res.status}`, data);
        return json({
          ok: false,
          error: "details_failed",
          details: data
        }, 500);
      }
      const components = Array.isArray(data?.addressComponents) ? data.addressComponents : [];
      const streetNumber = getComponent(components, "street_number")?.longText ?? "";
      const route = getComponent(components, "route")?.longText ?? "";
      const city = getComponent(components, "locality")?.longText ?? getComponent(components, "postal_town")?.longText ?? getComponent(components, "sublocality_level_1")?.longText ?? "";
      const state = getComponent(components, "administrative_area_level_1")?.shortText ?? "";
      const zip = getComponent(components, "postal_code")?.longText ?? "";
      const street = [
        streetNumber,
        route
      ].filter((e)=>e && e.trim().length > 0).join(" ").trim();
      console.log(`[google_places_address] details resolved street="${street}" city="${city}" state="${state}" zip="${zip}"`);
      return json({
        ok: true,
        address: {
          street,
          city,
          state,
          zip,
          formatted_address: data?.formattedAddress ?? ""
        }
      });
    }
    console.warn(`[google_places_address] unknown action="${action}"`);
    return json({
      ok: false,
      error: "invalid_action"
    }, 400);
  } catch (e) {
    console.error("[google_places_address] unhandled error:", e);
    return json({
      ok: false,
      error: e instanceof Error ? e.message : "unknown_error"
    }, 500);
  }
});
