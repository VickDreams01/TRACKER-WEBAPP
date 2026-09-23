// Service-role Supabase client for use inside edge functions only. Never
// ship the service role key to the browser — it bypasses Row Level
// Security entirely, which is exactly why booking/notification/staff-admin
// logic runs here instead of directly from the frontend.
import { createClient } from "npm:@supabase/supabase-js@2";

export function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Resolves the calling staff member from the Authorization header a logged
// in browser sends automatically (supabase-js attaches the session's
// access token as a Bearer token). Returns null if there's no valid
// session — callers decide whether that's allowed.
export async function callerProfile(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const admin = supabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return null;

  const { data: profile } = await admin
    .from("profiles")
    .select("user_id, staff_id, admin_doc_id, role")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (!profile) return null;
  const {data:staff} = await admin.from('admins').select('data').eq('id',profile.admin_doc_id).maybeSingle();
  if(staff?.data?.active !== true) return null;
  return { authUser: userData.user, ...profile };
}

export function staffIdToEmail(staffId: string) {
  return `${staffId.trim().toLowerCase()}@staff.stallionking.internal`;
}
