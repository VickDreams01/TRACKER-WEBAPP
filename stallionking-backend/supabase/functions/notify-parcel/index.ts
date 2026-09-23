import { callerProfile, supabaseAdmin } from '../_shared/supabaseAdmin.ts';
import { notifyParcel } from '../_shared/notifyParcel.ts';
import { handleOptions, json } from '../_shared/cors.ts';
Deno.serve(async req=>{
  const preflight=handleOptions(req); if(preflight) return preflight;
  if(req.method!=='POST') return json({error:'POST only'},405);
  const caller=await callerProfile(req); if(!caller) return json({error:'Active staff login required'},401);
  const payload=await req.json().catch(()=>null);
  if(typeof payload?.tn!=='string') return json({error:'Tracking number required'},400);
  const admin=supabaseAdmin();
  const {data:parcel,error}=await admin.from('parcels').select('data').eq('id',payload.tn).maybeSingle();
  if(error) return json({error:error.message},500);
  if(!parcel) return json({error:'Parcel not found'},404);
  const {data:settings}=await admin.from('settings').select('data').eq('id','company').maybeSingle();
  const notifications=await notifyParcel(admin,payload.tn,parcel.data,settings?.data||{});
  return json({tn:payload.tn,notifications});
});
