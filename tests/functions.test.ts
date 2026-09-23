// Real handlers and Supabase SDK with deterministic HTTP fixtures; no live secrets.
const handlers=new Map<string,(req:Request)=>Promise<Response>>();
let current='';
const originalServe=Deno.serve;
Object.defineProperty(Deno,'serve',{value:(handler:(req:Request)=>Promise<Response>)=>{handlers.set(current,handler); return {};},configurable:true});
Deno.env.set('SUPABASE_URL','https://fixture.supabase.co');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','fixture-service-key');
for(const name of ['track','book-parcel','create-staff','update-staff','notify-parcel']){
  current=name; await import(`../supabase/functions/${name}/index.ts`);
}
Object.defineProperty(Deno,'serve',{value:originalServe,configurable:true});
function assert(value:unknown,message='Assertion failed'){if(!value) throw new Error(message);}
const originalFetch=globalThis.fetch;
const parcel={trackingNumber:'STK-PRIVATE',status:'scanned',sender:{name:'Private Sender',phone:'08011111111',city:'Lagos'},receiver:{name:'Private Recipient',phone:'08022222222',email:'private@example.com',address:'Private address',city:'Abuja'},notifications:[{body:'Private message'}],history:[{status:'booked',label:'Booked',timestamp:'2026-01-01',actor:'Private Employee',note:'Internal note'}]};
function fixtures(active=true){
  globalThis.fetch=async(input:RequestInfo|URL)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    let data:unknown=null;
    if(url.pathname==='/auth/v1/user') data={id:'10000000-0000-0000-0000-000000000001'};
    if(url.pathname.endsWith('/profiles')) data={user_id:'10000000-0000-0000-0000-000000000001',admin_doc_id:'a1',staff_id:'SK-0001',role:'staff'};
    if(url.pathname.endsWith('/admins')) data={data:{active}};
    if(url.pathname.endsWith('/parcels')) data={data:parcel};
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  };
}
Deno.test('all private endpoints reject anonymous requests, including empty-project bootstrap',async()=>{
  for(const name of ['book-parcel','create-staff','update-staff','notify-parcel']){
    const result=await handlers.get(name)!(new Request('https://fixture/'+name,{method:'POST',body:'{}'}));
    assert([401,403].includes(result.status),name+' allowed anonymous access');
  }
});
Deno.test('public tracking strips contacts, notes, actors and notification bodies',async()=>{
  fixtures();
  try{
    const result=await handlers.get('track')!(new Request('https://fixture/track?tn=STK-PRIVATE'));
    assert(result.status===200);
    const body=await result.text();
    for(const secret of ['Private Sender','Private Recipient','Private address','private@example.com','Private Employee','Internal note','Private message','08011111111']) assert(!body.includes(secret),'Leaked '+secret);
    assert(body.includes('Lagos') && body.includes('Abuja'));
  }finally{globalThis.fetch=originalFetch;}
});
Deno.test('public tracking validates method and tracking number',async()=>{
  assert((await handlers.get('track')!(new Request('https://fixture/track?tn=bad!',{method:'GET'}))).status===400);
  assert((await handlers.get('track')!(new Request('https://fixture/track?tn=STK-1234',{method:'POST'}))).status===405);
});
Deno.test('disabled staff JWT cannot book or send notifications',async()=>{
  fixtures(false);
  try{
    for(const name of ['book-parcel','notify-parcel']){
      const result=await handlers.get(name)!(new Request('https://fixture/'+name,{method:'POST',headers:{Authorization:'Bearer valid-but-disabled'},body:'{}'}));
      assert(result.status===401);
    }
  }finally{globalThis.fetch=originalFetch;}
});
Deno.test('booking rejects incomplete contact data before database insertion',async()=>{
  fixtures();
  try{
    const result=await handlers.get('book-parcel')!(new Request('https://fixture/book-parcel',{method:'POST',headers:{Authorization:'Bearer staff-session'},body:JSON.stringify({sender:{name:'A'},receiver:{name:'B'}})}));
    assert(result.status===400);
  }finally{globalThis.fetch=originalFetch;}
});
Deno.test('ordinary staff cannot manage accounts',async()=>{
  fixtures();
  try{
    for(const name of ['create-staff','update-staff']){
      const result=await handlers.get(name)!(new Request('https://fixture/'+name,{method:'POST',headers:{Authorization:'Bearer staff-session'},body:'{}'}));
      assert(result.status===403);
    }
  }finally{globalThis.fetch=originalFetch;}
});
Deno.test('booking retries return the existing parcel without inserting another',async()=>{
  fixtures();
  const base=globalThis.fetch;
  let writes=0;
  globalThis.fetch=async(input,options)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(options?.method==='POST') writes++;
    if(url.pathname.endsWith('/settings')) return new Response(JSON.stringify({data:{prefix:'STK'}}));
    if(url.pathname.endsWith('/parcels')) return new Response(JSON.stringify(url.searchParams.has('booking_key') ? {id:'STK-EXISTING',data:{notifications:[]}} : null));
    return base(input,options);
  };
  try{
    const payload={requestId:'20000000-0000-0000-0000-000000000001',sender:{name:'Sender',phone:'08012345678',city:'Lagos'},receiver:{name:'Receiver',phone:'08023456789',city:'Abuja',address:'10 Example Street'},serviceType:'Standard',weightKg:'1kg – 3kg',sendNotification:false};
    const result=await handlers.get('book-parcel')!(new Request('https://fixture/book-parcel',{method:'POST',headers:{Authorization:'Bearer staff-session'},body:JSON.stringify(payload)}));
    assert(result.status===200);assert((await result.json()).tn==='STK-EXISTING');assert(writes===0);
  }finally{globalThis.fetch=originalFetch;}
});
Deno.test('tracking notifications email contacts only and skip phone-only bookings',async()=>{
  const {notifyParcel}=await import('../supabase/functions/_shared/notifyParcel.ts');
  const savedKey=Deno.env.get('RESEND_API_KEY');
  const savedFrom=Deno.env.get('RESEND_FROM');
  Deno.env.set('RESEND_API_KEY','fixture-email-key');
  Deno.env.set('RESEND_FROM','tracking@example.com');
  const requests:{url:string;to:string[]}[]=[];
  const logs:Record<string,unknown>[]=[];
  const admin={
    from:()=>({insert:async(row:{data:Record<string,unknown>})=>{logs.push(row.data);return {error:null};}}),
    rpc:async()=>({error:null}),
  } as unknown as Parameters<typeof notifyParcel>[0];
  globalThis.fetch=async(input,options)=>{
    const body=JSON.parse(String(options?.body));
    requests.push({url:String(input),to:body.to});
    return new Response(JSON.stringify({id:'email-id'}),{status:200});
  };
  try{
    const sent=await notifyParcel(admin,'STK-EMAIL',{
      sender:{email:'sender@example.com',phone:'08012345678'},
      receiver:{email:'receiver@example.com',phone:'08023456789'},
    },{});
    assert(sent.length===2);
    assert(sent.every(n=>n.channel==='email' && n.delivered===true));
    assert(requests.length===2 && requests.every(r=>r.url==='https://api.resend.com/emails'));
    assert(requests[0].to[0]==='sender@example.com' && requests[1].to[0]==='receiver@example.com');
    assert(logs.length===2 && logs.every(n=>n.channel==='email'));
    const skipped=await notifyParcel(admin,'STK-PHONE',{
      sender:{phone:'08012345678'},receiver:{phone:'08023456789'},
    },{});
    assert(skipped.length===0 && requests.length===2 && logs.length===2);
  }finally{
    globalThis.fetch=originalFetch;
    if(savedKey===undefined) Deno.env.delete('RESEND_API_KEY'); else Deno.env.set('RESEND_API_KEY',savedKey);
    if(savedFrom===undefined) Deno.env.delete('RESEND_FROM'); else Deno.env.set('RESEND_FROM',savedFrom);
  }
});
Deno.test('email failures explain missing hosted settings and provider restrictions without leaking credentials',async()=>{
  const {sendEmail}=await import('../supabase/functions/_shared/notify.ts');
  const savedKey=Deno.env.get('RESEND_API_KEY');
  const savedFrom=Deno.env.get('RESEND_FROM');
  try{
    Deno.env.delete('RESEND_API_KEY');Deno.env.delete('RESEND_FROM');
    let calls=0;
    globalThis.fetch=async()=>{calls++;throw new Error('should not fetch');};
    const missing=await sendEmail({to:'recipient@example.com',subject:'Test',body:'Test'});
    assert(!missing.ok && missing.error?.includes('Supabase secrets') && calls===0);
    Deno.env.set('RESEND_API_KEY','re_fixture_secret');Deno.env.set('RESEND_FROM','sender@example.com');
    for(const [status,message,expected] of [
      [403,'You can only send testing emails to your own email address','test sending'],
      [403,'The example.com domain is not verified','domain is not verified'],
      [401,'API key is invalid re_fixture_secret','rejected the API key'],
      [429,'Too many requests','sending limit'],
    ] as const){
      globalThis.fetch=async()=>new Response(JSON.stringify({message}),{status});
      const result=await sendEmail({to:'recipient@example.com',subject:'Test',body:'Test'});
      assert(!result.ok && result.error?.includes(expected));
      assert(!result.error?.includes('re_fixture_secret'));
    }
  }finally{
    globalThis.fetch=originalFetch;
    if(savedKey===undefined) Deno.env.delete('RESEND_API_KEY'); else Deno.env.set('RESEND_API_KEY',savedKey);
    if(savedFrom===undefined) Deno.env.delete('RESEND_FROM'); else Deno.env.set('RESEND_FROM',savedFrom);
  }
});
