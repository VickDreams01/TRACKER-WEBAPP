import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
let db;
const root='10000000-0000-0000-0000-000000000001';
const staff='10000000-0000-0000-0000-000000000002';
const outsider='10000000-0000-0000-0000-000000000003';
async function asUser(id, sql, params=[]){
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${id}',false);`);
  try { return await db.query(sql,params); } finally { await db.exec('reset role'); }
}
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated; create publication supabase_realtime;`);
  for(const file of ['0001_init.sql','0002_workflows.sql']){
    const sql=(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8')).replace('create extension if not exists pgcrypto;','');
    await db.exec(sql);
  }
  await db.exec('grant usage on schema public to authenticated; grant select, insert, update, delete on all tables in schema public to authenticated;');
  for(const [id,sid,role] of [[root,'SK-0001','superadmin'],[staff,'SK-0002','staff']]){
    await db.query('insert into auth.users values($1)',[id]);
    await db.query('select provision_staff($1,$2,$2,$3)',[id,sid,role]);
  }
  await db.query('insert into auth.users values($1)',[outsider]);
  await db.exec(`insert into riders(id,data) values('r1','{"name":"Rider One","phone":"08012345678","active":true}'); insert into parcels(id,data) values('STK-TEST','{"trackingNumber":"STK-TEST","status":"booked","history":[]}');`);
});
after(async()=>db?.close());
test('unaffiliated authenticated users cannot read business data or transition parcels',async()=>{
  assert.equal((await asUser(outsider,'select * from parcels')).rows.length,0);
  await assert.rejects(asUser(outsider,"select transition_parcel('STK-TEST','scanned')"),/Active staff/);
});
test('staff cannot bypass workflow rules with direct writes or create staff',async()=>{
  assert.equal((await asUser(staff,"update parcels set data='{}' where id='STK-TEST' returning id")).rows.length,0);
  await assert.rejects(asUser(staff,'select provision_staff($1,$2,$3,$4)',[outsider,'EVIL','Bad','superadmin']),/permission denied/);
});
test('warehouse, dispatch, exception, rebooking and delivery preserve complete history',async()=>{
  await assert.rejects(asUser(staff,"select transition_parcel('STK-TEST','delivered')"),/Invalid transition/);
  let result=await asUser(staff,"select transition_parcel('STK-TEST','scanned') as p");
  assert.deepEqual(result.rows[0].p.history.map(x=>x.status),['received','packaged','scanned']);
  await assert.rejects(asUser(staff,"select transition_parcel('STK-TEST','scanned')"),/Invalid transition/);
  await assert.rejects(asUser(staff,"select transition_parcel('STK-TEST','out_for_delivery')"),/active rider/);
  await asUser(staff,"select transition_parcel('STK-TEST','out_for_delivery','{\"riderId\":\"r1\"}')");
  await assert.rejects(asUser(staff,"select transition_parcel('STK-TEST','exception')"),/reason required/);
  await asUser(staff,"select transition_parcel('STK-TEST','exception','{\"note\":\"Recipient unavailable\"}')");
  result=await asUser(staff,"select transition_parcel('STK-TEST','booked') as p");
  assert.equal(result.rows[0].p.rider,null);
  await asUser(staff,"select transition_parcel('STK-TEST','scanned')");
  await asUser(staff,"select transition_parcel('STK-TEST','out_for_delivery','{\"riderId\":\"r1\"}')");
  result=await asUser(staff,"select transition_parcel('STK-TEST','delivered') as p");
  assert.equal(result.rows[0].p.history.length,11);
  assert.equal(result.rows[0].p.status,'delivered');
});
test('deletion approval is admin-only and cannot be replayed',async()=>{
  const actor=(await db.query('select admin_doc_id from profiles where user_id=$1',[staff])).rows[0].admin_doc_id;
  await asUser(staff,'insert into deletion_requests(id,data) values($1,$2)',['request-1',{status:'pending',trackingNumber:'STK-TEST',requestedBy:{id:actor}}]);
  await assert.rejects(asUser(staff,"select resolve_deletion('request-1','approved')"),/Administrator/);
  await asUser(root,"select resolve_deletion('request-1','approved')");
  assert.equal((await db.query("select * from parcels where id='STK-TEST'")).rows.length,0);
  await assert.rejects(asUser(root,"select resolve_deletion('request-1','approved')"),/no longer pending/);
});
test('staff deactivation immediately blocks existing sessions and last superadmin is protected',async()=>{
  await db.query("select modify_staff('SK-0002','{\"active\":false}')");
  assert.equal((await asUser(staff,'select * from clients')).rows.length,0);
  await assert.rejects(asUser(staff,"select transition_parcel('STK-TEST','scanned')"),/Active staff/);
  await assert.rejects(db.query("select modify_staff('SK-0001','{\"active\":false}')"),/At least one/);
  await assert.rejects(db.query("select modify_staff('SK-0001','{\"role\":\"staff\"}')"),/At least one/);
});
test('notification records cannot overwrite parcel status and booking request IDs are unique',async()=>{
  const key='20000000-0000-0000-0000-000000000001';
  await db.query('insert into parcels(id,data,booking_key) values($1,$2,$3)',['STK-ATOMIC',{status:'delivered',history:[{status:'delivered'}]},key]);
  await db.query("select record_parcel_notifications('STK-ATOMIC','[{\"delivered\":false}]')");
  const p=(await db.query("select data from parcels where id='STK-ATOMIC'")).rows[0].data;
  assert.equal(p.status,'delivered');assert.equal(p.history.length,1);assert.equal(p.notifications.length,1);
  await assert.rejects(db.query('insert into parcels(id,booking_key) values($1,$2)',['STK-DUPLICATE',key]),/unique constraint/);
});
test('client activity is stamped with real identity and cannot be edited',async()=>{
  await asUser(root,"insert into activity_log(id,data) values('audit-test','{\"actorName\":\"Forged name\"}')");
  const row=(await asUser(root,"select data from activity_log where id='audit-test'")).rows[0];
  assert.equal(row.data.actorName,'SK-0001');
  assert.equal((await asUser(root,"update activity_log set data='{}' where id='audit-test' returning id")).rows.length,0);
});
