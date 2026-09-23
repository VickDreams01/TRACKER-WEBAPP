// Shared CORS headers for every edge function. The frontend HTML can be
// hosted anywhere (a Claude Artifact, Netlify, GitHub Pages, ...) so we
// allow any origin to call these endpoints — auth is enforced separately by
// checking the caller's Supabase session / role inside each function, not
// by the origin header.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
