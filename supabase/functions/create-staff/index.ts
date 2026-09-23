import { supabaseAdmin, callerProfile, staffIdToEmail } from '../_shared/supabaseAdmin.ts';
import { handleOptions, json } from '../_shared/cors.ts';
Deno.serve(async req => {
  const preflight = handleOptions(req); if(preflight) return preflight;
  if(req.method !== 'POST') return json({error:'POST only'},405);
  const caller = await callerProfile(req);
  if(caller?.role !== 'superadmin') return json({error:'Superadmin required'},403);
  const p = await req.json().catch(()=>null);
  if(!p || typeof p.name !== 'string' || !p.name.trim() || typeof p.staffId !== 'string' || !/^[A-Z0-9-]{3,32}$/i.test(p.staffId) || typeof p.password !== 'string' || p.password.length<12 || !['staff','admin','superadmin'].includes(p.role)) return json({error:'Provide a name, valid Staff ID, role and password of at least 12 characters'},400);
  const admin = supabaseAdmin();
  const {data, error} = await admin.auth.admin.createUser({email:staffIdToEmail(p.staffId),password:p.password,email_confirm:true});
  if(error) return json({error:error.message},400);
  const {data:id,error:profileError} = await admin.rpc('provision_staff',{auth_user_id:data.user.id,staff_id_value:p.staffId,display_name:p.name.trim(),staff_role_value:p.role});
  if(profileError){ await admin.auth.admin.deleteUser(data.user.id); return json({error:profileError.message},400); }
  return json({id},201);
});
