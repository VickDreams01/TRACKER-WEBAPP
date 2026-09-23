import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../frontend/supabase-adapter.js',import.meta.url),'utf8');
function adapter(client){const context=vm.createContext({window:{supabase:{createClient:()=>client}},crypto,console});vm.runInContext(source,context);return context.createSupabaseAdapter('fixture','key');}
test('unlimited collections page through more than the hosted default row limit',async()=>{
  const records=Array.from({length:1207},(_,i)=>({id:String(i),data:{number:i}}));
  const ranges=[];
  const db=adapter({from:()=>({select(){return this},order(){return this},range(a,b){ranges.push([a,b]);return Promise.resolve({data:records.slice(a,b+1)})}})});
  const result=await db.collection('parcels').orderBy('createdAt','desc').get();
  assert.equal(result.docs.length,1207);assert.equal(ranges.length,3);
});
test('updates delegate to atomic database patch rather than reading and replacing records',async()=>{
  let args;
  const db=adapter({rpc:async(name,payload)=>{args={name,...payload};return {error:null};}});
  await db.doc('clients/client-1').update({city:'Abuja'});
  assert.equal(args.name,'patch_document');assert.equal(args.collection_name,'clients');assert.equal(args.document_id,'client-1');assert.equal(args.patch.city,'Abuja');
});
test('query subscriptions forward errors and cancel cleanly',async()=>{
  let removed=false;let errorReceived;
  const client={from:()=>({select(){return this},order(){return this},range(){return Promise.resolve({error:new Error('Offline')})}}),channel:()=>({on(){return this},subscribe(){return this}}),removeChannel:()=>{removed=true}};
  const stop=adapter(client).collection('parcels').onSnapshot(()=>assert.fail('must not emit failed query'),error=>errorReceived=error);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(errorReceived.message,'Offline');stop();assert.equal(removed,true);
});
