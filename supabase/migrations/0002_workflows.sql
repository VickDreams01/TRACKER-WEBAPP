-- Enforce staff membership even for previously issued JWTs and disabled accounts.
create or replace function public.staff_role() returns text
language sql stable security definer set search_path = public as $$
  select p.role from profiles p join admins a on a.id = p.admin_doc_id
  where p.user_id = auth.uid() and a.data->>'active' = 'true';
$$;
create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.staff_role() = 'superadmin', false);
$$;

do $$ declare t text; begin
  foreach t in array array['settings','riders','clients','parcels','notifications','activity_log','deletion_requests'] loop
    execute format('drop policy if exists staff_full_access on public.%I', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.staff_role() is not null)', t);
  end loop;
  foreach t in array array['settings','riders','clients','notifications'] loop
    execute format('create policy staff_write on public.%I for all to authenticated using (public.staff_role() is not null) with check (public.staff_role() is not null)', t);
  end loop;
end $$;
drop policy admins_read_all_staff on public.admins;
drop policy admins_write_superadmin_only on public.admins;
create policy admins_read on public.admins for select to authenticated using (public.staff_role() is not null);
-- Staff changes only through the privileged functions below, never document writes.
create policy activity_append on public.activity_log for insert to authenticated
with check (public.staff_role() is not null);
create policy deletion_request on public.deletion_requests for insert to authenticated
with check (public.staff_role() is not null and data->>'status' = 'pending'
  and data->'requestedBy'->>'id' = (select admin_doc_id from profiles where user_id = auth.uid()));

insert into settings(id,data) values ('company', '{"name":"STALLIONKING TRACKER","tagline":"Parcel tracking, from hub to doorstep","prefix":"STK"}') on conflict do nothing;

-- Atomic patches avoid read/replace races in client and notification edits.
create or replace function public.patch_document(collection_name text, document_id text, patch jsonb)
returns void language plpgsql set search_path = public as $$
declare affected int;
begin
  if collection_name not in ('settings','riders','clients','notifications') then raise exception 'Unsupported collection'; end if;
  execute format('update public.%I set data = data || $1 where id = $2', collection_name) using patch, document_id;
  get diagnostics affected = row_count;
  if affected = 0 then raise exception 'Record not found or access denied'; end if;
end $$;

create or replace function public.transition_parcel(tracking_number text, next_status text, details jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public as $$
declare p jsonb; old_status text; steps text[]; step text; entry jsonb; actor jsonb; rider jsonb; stamp text;
begin
  if public.staff_role() is null then raise exception 'Active staff login required'; end if;
  select a.data || jsonb_build_object('id',a.id) into actor from profiles pr join admins a on a.id=pr.admin_doc_id where pr.user_id=auth.uid();
  select data into p from parcels where id=tracking_number for update;
  if p is null then raise exception 'Parcel not found'; end if;
  old_status := p->>'status';
  if next_status='scanned' and old_status in ('booked','received','packaged') then
    steps := case old_status when 'booked' then array['received','packaged','scanned'] when 'received' then array['packaged','scanned'] else array['scanned'] end;
  elsif (next_status='out_for_delivery' and old_status='scanned')
     or (next_status in ('delivered','exception') and old_status='out_for_delivery')
     or (next_status='booked' and old_status='exception') then steps := array[next_status];
  else raise exception 'Invalid transition from % to %; refresh the parcel', old_status, next_status;
  end if;
  if next_status='out_for_delivery' then
    select data || jsonb_build_object('id',id) into rider from riders where id=details->>'riderId' and coalesce(data->>'active','true')='true';
    if rider is null then raise exception 'Choose an active rider'; end if;
    p := p || jsonb_build_object('rider',rider);
  end if;
  if next_status='exception' and length(trim(coalesce(details->>'note',''))) = 0 then raise exception 'Exception reason required'; end if;
  if next_status='booked' then p := p || '{"rider":null}'::jsonb; end if;
  stamp := to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  foreach step in array steps loop
    entry := jsonb_build_object('status',step,'label',case step when 'booked' then 'Order Booked' when 'received' then 'Received In-Store' when 'packaged' then 'Packaged' when 'scanned' then 'Scanned / In Transit' when 'out_for_delivery' then 'Out for Delivery' when 'delivered' then 'Delivered' else 'Delivery Exception' end,
      'timestamp',stamp,'location',coalesce(details->>'location',''),'actor',actor->>'name',
      'note',case when next_status='booked' then 'Re-booked after a delivery exception' else coalesce(details->>'note','') end);
    p := jsonb_set(p,'{history}',coalesce(p->'history','[]') || jsonb_build_array(entry));
  end loop;
  p := p || jsonb_build_object('status',next_status,'updatedAt',stamp);
  update parcels set data=p where id=tracking_number;
  insert into activity_log(data) values(jsonb_build_object('action','parcel_'||next_status,'summary',tracking_number||': '||old_status||' → '||next_status,'actorId',actor->>'id','actorName',actor->>'name','actorStaffId',actor->>'staffId','actorRole',actor->>'role','targetType','parcel','targetId',tracking_number,'createdAt',stamp));
  return p;
end $$;

create or replace function public.resolve_deletion(request_id text, decision text, note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r jsonb; actor jsonb;
begin
  if coalesce(public.staff_role(),'') not in ('admin','superadmin') then raise exception 'Administrator required'; end if;
  if decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  select data into r from deletion_requests where id=request_id for update;
  if r is null or r->>'status'<>'pending' then raise exception 'Request is no longer pending'; end if;
  select a.data || jsonb_build_object('id',a.id) into actor from profiles p join admins a on a.id=p.admin_doc_id where p.user_id=auth.uid();
  if decision='approved' then delete from parcels where id=r->>'trackingNumber'; end if;
  update deletion_requests set data=data || jsonb_build_object('status',decision,'resolvedBy',actor,'resolvedAt',now(),'resolutionNote',note) where id=request_id;
end $$;

-- Auth user creation/deletion remains in the edge function; profile changes are transactional.
create or replace function public.provision_staff(auth_user_id uuid, staff_id_value text, display_name text, staff_role_value text)
returns text language plpgsql security definer set search_path = public as $$
declare doc_id text := gen_random_uuid()::text;
begin
  if staff_role_value not in ('staff','admin','superadmin') then raise exception 'Invalid role'; end if;
  insert into admins(id,data) values(doc_id,jsonb_build_object('name',display_name,'staffId',upper(trim(staff_id_value)),'role',staff_role_value,'active',true,'createdAt',now()));
  insert into profiles(user_id,staff_id,admin_doc_id,role) values(auth_user_id,upper(trim(staff_id_value)),doc_id,staff_role_value);
  return doc_id;
end $$;
create or replace function public.modify_staff(staff_id_value text, patch jsonb, remove_staff boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare p profiles; a jsonb; new_role text;
begin
  -- Serializes roster changes, including simultaneous last-superadmin removal.
  perform pg_advisory_xact_lock(845192);
  select * into p from profiles where staff_id=upper(trim(staff_id_value)) for update;
  if p.user_id is null then raise exception 'Staff login not found'; end if;
  select data into a from admins where id=p.admin_doc_id for update;
  new_role := coalesce(patch->>'role',p.role);
  if new_role not in ('staff','admin','superadmin') then raise exception 'Invalid role'; end if;
  if p.role='superadmin' and a->>'active'='true' and (remove_staff or new_role<>'superadmin' or patch->>'active'='false') then
    if not exists(select 1 from profiles x join admins y on y.id=x.admin_doc_id where x.user_id<>p.user_id and x.role='superadmin' and y.data->>'active'='true') then raise exception 'At least one active superadmin is required'; end if;
  end if;
  if remove_staff then
    -- Disable immediately; caller deletes Auth user and then its roster row.
    update admins set data=data || '{"active":false}' where id=p.admin_doc_id;
  else
    update profiles set role=new_role where user_id=p.user_id;
    update admins set data=data || patch || jsonb_build_object('role',new_role) where id=p.admin_doc_id;
  end if;
  return p.user_id;
end $$;
revoke all on function public.provision_staff(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.modify_staff(text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.provision_staff(uuid,text,text,text), public.modify_staff(text,jsonb,boolean) to service_role;
revoke all on function public.transition_parcel(text,text,jsonb), public.resolve_deletion(text,text,text), public.patch_document(text,text,jsonb) from public, anon;
grant execute on function public.transition_parcel(text,text,jsonb), public.resolve_deletion(text,text,text), public.patch_document(text,text,jsonb) to authenticated;

alter table public.parcels add column booking_key uuid unique;
create or replace function public.record_parcel_notifications(tracking_number text, attempts jsonb)
returns void language sql security definer set search_path = public as $$
  update parcels set data=jsonb_set(data,'{notifications}',coalesce(data->'notifications','[]') || attempts) where id=tracking_number;
$$;
revoke all on function public.record_parcel_notifications(text,jsonb) from public, anon, authenticated;
grant execute on function public.record_parcel_notifications(text,jsonb) to service_role;

alter table public.settings add constraint company_prefix_valid check (id <> 'company' or data->>'prefix' ~ '^[A-Z0-9]{1,8}$');
create unique index one_pending_deletion_per_parcel on public.deletion_requests ((data->>'trackingNumber')) where data->>'status'='pending';
-- Bind client-generated activity records to the real caller; clients cannot impersonate a colleague.
create or replace function public.stamp_activity_actor() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor jsonb;
begin
  if auth.uid() is not null then
    select a.data || jsonb_build_object('id',a.id) into actor from profiles p join admins a on a.id=p.admin_doc_id where p.user_id=auth.uid();
    new.data := new.data || jsonb_build_object('actorId',actor->>'id','actorName',actor->>'name','actorStaffId',actor->>'staffId','actorRole',actor->>'role','createdAt',now());
  end if;
  return new;
end $$;
create trigger activity_actor before insert on public.activity_log for each row execute function public.stamp_activity_actor();
drop policy staff_read on public.activity_log;
create policy activity_superadmin_read on public.activity_log for select to authenticated using (public.is_superadmin());
