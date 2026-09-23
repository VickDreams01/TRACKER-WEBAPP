// Public endpoint: GET /track?tn=STK-XXXXXX
//
// The customer-facing "Track a Parcel" page never gets a Supabase Auth
// session, so it can't read the parcels table directly (RLS on `parcels`
// only grants access to `authenticated` staff — see migrations/0001_init.sql).
// Instead it calls this function, which looks the one parcel up with the
// service role key and returns just that document. No listing, no
// enumeration of other tracking numbers.
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleOptions, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if(req.method !== 'GET') return json({error:'GET only'},405);
  const url = new URL(req.url);
  const tn = (url.searchParams.get("tn") || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(tn)) return json({ error: "Missing tn (tracking number)" }, 400);

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("parcels")
    .select("data")
    .eq("id", tn)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "not_found" }, 404);

  const p = data.data;
  // A tracking number exposes progress, never contact details or internal notes.
  const parcel = {
    trackingNumber:p.trackingNumber, status:p.status, serviceType:p.serviceType,
    createdAt:p.createdAt, updatedAt:p.updatedAt,
    sender:{city:p.sender?.city || ''}, receiver:{city:p.receiver?.city || ''},
    history:(p.history || []).map((h:Record<string,unknown>)=>({status:h.status,label:h.label,timestamp:h.timestamp,location:h.location})),
  };
  return json({ parcel }, 200);
});
