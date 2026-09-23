import { supabaseAdmin, callerProfile } from '../_shared/supabaseAdmin.ts';
import { handleOptions, json } from '../_shared/cors.ts';
Deno.serve(async req => {
  const preflight=handleOptions(req); if(preflight) return preflight;
  if(req.method!=='POST') return json({error:'POST only'},405);
  const caller=await callerProfile(req);
  if(caller?.role!=='superadmin') return json({error:'Superadmin required'},403);
  const p=await req.json().catch(()=>null);
  if(typeof p?.staffId!=='string') return json({error:'Staff ID required'},400);
  if(p.active!==undefined && typeof p.active!=='boolean') return json({error:'Invalid active flag'},400);
  if(p.role!==undefined && !['staff','admin','superadmin'].includes(p.role)) return json({error:'Invalid role'},400);
  if(p.name!==undefined && (typeof p.name!=='string' || !p.name.trim())) return json({error:'Name required'},400);
  if(p.newPassword!==undefined && (typeof p.newPassword!=='string' || p.newPassword.length<12)) return json({error:'Password must have at least 12 characters'},400);
  const admin=supabaseAdmin();
  const {data:profile}=await admin.from('profiles').select('user_id,admin_doc_id').eq('staff_id',p.staffId.trim().toUpperCase()).maybeSingle();
  if(!profile) return json({error:'Staff login not found'},404);
  const patch:Record<string,unknown>={};
  for(const key of ['role','active','name']) if(p[key]!==undefined) patch[key]=p[key];
  const {error}=await admin.rpc('modify_staff',{staff_id_value:p.staffId,patch,remove_staff:p.delete===true});
  if(error) return json({error:error.message},400);
  if(p.delete===true){
    const {error:deleteError}=await admin.auth.admin.deleteUser(profile.user_id);
    if(deleteError) return json({error:'Account disabled, but Auth deletion failed. Retry deletion.'},500);
    const {error:rowError}=await admin.from('admins').delete().eq('id',profile.admin_doc_id);
    if(rowError) return json({error:rowError.message},500);
  } else if(p.newPassword){
    const {error:passwordError}=await admin.auth.admin.updateUserById(profile.user_id,{password:p.newPassword});
    if(passwordError) return json({error:'Profile updated, but password change failed: '+passwordError.message},400);
  }
  return json({ok:true});
});
