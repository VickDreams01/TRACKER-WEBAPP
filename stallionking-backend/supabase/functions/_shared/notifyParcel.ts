import { sendEmail, sendSms } from './notify.ts';
import { supabaseAdmin } from './supabaseAdmin.ts';
export async function notifyParcel(admin:ReturnType<typeof supabaseAdmin>, tn:string, parcel:Record<string,any>, settings:Record<string,any>) {
  const notifications:Record<string,unknown>[]=[];
  for(const [role,contact] of [['Sender',parcel.sender],['Receiver',parcel.receiver]] as const){
    for(const channel of ['email','sms']){
      const to=channel==='email' ? contact.email : contact.phone;
      if(!to) continue;
      const subject=`Parcel tracking: ${tn}`;
      const body=`${settings.name || 'Stallionking Tracker'}: Your tracking number is ${tn}. Track your parcel on our Track a Parcel page.`;
      const result=channel==='email' ? await sendEmail({to,subject,body}) : await sendSms({to,body});
      const n={channel,recipientRole:role,to,subject,body,sentAt:new Date().toISOString(),delivered:result.ok};
      notifications.push(n);
      const {error}=await admin.from('notifications').insert({data:{...n,kind:'tracking_notification',trackingNumber:tn,audience:{type:'role',roles:['admin','superadmin']},title:result.ok ? 'Tracking message accepted' : 'Tracking message failed',refType:'parcel',refId:tn,createdAt:new Date().toISOString(),readBy:[]}});
      if(error) console.error('Notification log failed',error.message);
    }
  }
  const {error}=await admin.rpc('record_parcel_notifications',{tracking_number:tn,attempts:notifications});
  if(error) console.error('Parcel notification record failed',error.message);
  return notifications;
}
