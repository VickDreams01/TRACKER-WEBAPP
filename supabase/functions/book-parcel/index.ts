// Authenticated parcel booking with optional tracking email notifications.
import { supabaseAdmin, callerProfile } from "../_shared/supabaseAdmin.ts";
import { notifyParcel } from "../_shared/notifyParcel.ts";
import { corsHeaders, handleOptions, json } from "../_shared/cors.ts";

function genTrackingNumber(prefix: string) {
  const rand = crypto.randomUUID().replaceAll('-','').slice(0,16).toUpperCase();
  const stamp = Date.now().toString(36).slice(-4).toUpperCase();
  return `${prefix}-${stamp}${rand}`;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const caller = await callerProfile(req);
  if (!caller) return json({ error: "Not signed in" }, 401);

  const payload = await req.json().catch(() => null);
  if (!payload?.sender?.name || !payload?.receiver?.name) {
    return json({ error: "sender.name and receiver.name are required" }, 400);
  }

  for(const role of ['sender','receiver']) {
    const contact=payload[role];
    if(['name','phone','city'].some(k=>typeof contact[k]!=='string' || !contact[k].trim() || contact[k].length>200)) return json({error:`${role}: name, phone and city are required`},400);
    if(contact.email && (typeof contact.email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))) return json({error:`Invalid ${role} email`},400);
  }
  if(typeof payload.receiver.address!=='string' || !payload.receiver.address.trim()) return json({error:'Delivery address required'},400);
  const weightBands=['Under 1kg','1kg – 3kg','3kg – 5kg','5kg – 10kg','10kg – 20kg','Above 20kg'];
  if(!weightBands.includes(payload.weightKg) && (!Number.isFinite(Number(payload.weightKg)) || Number(payload.weightKg)<=0)) return json({error:'Select a weight range or provide a positive weight'},400);
  if(!['Standard','Express','Same-day'].includes(payload.serviceType)) return json({error:'Invalid service type'},400);
  const admin = supabaseAdmin();

  const { data: settingsRow } = await admin
    .from("settings")
    .select("data")
    .eq("id", "company")
    .maybeSingle();
  const settings = settingsRow?.data || { name: "STALLIONKING TRACKER", prefix: "STK" };

  let tn = genTrackingNumber(/^[A-Z0-9]{1,8}$/.test(settings.prefix) ? settings.prefix : "STK");
  // Vanishingly unlikely to collide, but make sure before we commit to it.
  for (let i = 0; i < 3; i++) {
    const { data: exists } = await admin.from("parcels").select("id").eq("id", tn).maybeSingle();
    if (!exists) break;
    tn = genTrackingNumber(/^[A-Z0-9]{1,8}$/.test(settings.prefix) ? settings.prefix : "STK");
  }

  if(typeof payload.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.requestId)) return json({error:'Booking request ID required'},400);
  const {data:existing}=await admin.from('parcels').select('id,data').eq('booking_key',payload.requestId).maybeSingle();
  if(existing) return json({tn:existing.id,notifications:existing.data.notifications||[],notificationsSkipped:payload.sendNotification===false});
  const now = new Date().toISOString();
  const doc = {
    notifications: [] as Record<string, unknown>[],
    trackingNumber: tn,
    createdAt: now,
    updatedAt: now,
    sender: payload.sender,
    receiver: payload.receiver,
    senderClientId: payload.clientId || null,
    rebookedFrom: null,
    rebookedTo: null,
    description: payload.description || "",
    weightKg: payload.weightKg || "",
    serviceType: payload.serviceType || "Standard",
    status: "booked",
    rider: null,
    history: [
      {
        status: "booked",
        label: "Booked",
        timestamp: now,
        location: payload.sender.city ? `${payload.sender.city} Hub` : "",
        actor: caller.staff_id,
        note: "",
      },
    ],
  };

  const { error: insertErr } = await admin.from("parcels").insert({ id: tn, data: doc, created_at: now, booking_key:payload.requestId });
  if (insertErr) {
    if(insertErr.code==='23505'){
      const {data:previous}=await admin.from('parcels').select('id,data').eq('booking_key',payload.requestId).maybeSingle();
      if(previous) return json({tn:previous.id,notifications:previous.data.notifications||[],notificationsSkipped:payload.sendNotification===false});
    }
    return json({ error: insertErr.message }, 500);
  }

  const wantsSend = payload.sendNotification !== false;
  const notifications = wantsSend ? await notifyParcel(admin, tn, doc, settings) : [];

  await admin.from("activity_log").insert({
    id: crypto.randomUUID(),
    data: {
      action: "parcel_booked",
      actorId: caller.admin_doc_id, actorStaffId:caller.staff_id, actorRole:caller.role, actorName:caller.staff_id,
      summary: `Booked parcel ${tn} for ${doc.receiver.name}`,
      targetType: "parcel",
      targetId: tn,
      actor: caller.staff_id,
      createdAt: new Date().toISOString(),
    },
  });

  if (notifications.length) {
    await admin.from("activity_log").insert({
      id: crypto.randomUUID(),
      data: {
        action: "tracking_notified",
        actorId: caller.admin_doc_id, actorStaffId:caller.staff_id, actorRole:caller.role, actorName:caller.staff_id,
        summary: `Attempted tracking ID ${tn} to ${notifications.length} recipient${notifications.length === 1 ? "" : "s"} by email`,
        targetType: "parcel",
        targetId: tn,
        actor: caller.staff_id,
        createdAt: new Date().toISOString(),
      },
    });
  }

  return json({ tn, notifications, notificationsSkipped: !wantsSend }, 200);
});
