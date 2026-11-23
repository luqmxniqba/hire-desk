-- =====================================================================
--  Hire platform: database setup
--
--  Paste this whole file into Supabase > SQL Editor > New query > Run.
--  It is safe to run again later: it only adds what is missing and
--  refreshes the functions and security rules.
--
--  After the first run, set the setup code people need to create a
--  business on the platform (pick something long and random):
--
--    update public.app_config set value = 'your-long-random-code'
--    where key = 'signup_code';
-- =====================================================================

create schema if not exists app;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Settings for the platform itself. Only the database can read these.
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
insert into public.app_config (key, value) values ('signup_code', 'CHANGE-ME')
on conflict (key) do nothing;

-- One row per business on the platform.
create table if not exists public.orgs (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint orgs_slug_format check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  constraint orgs_name_length check (char_length(name) between 1 and 80)
);

-- Who works at which business. owner = runs the business and manages the team; staff = uses the tracker.
create table if not exists public.members (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null,
  email      text,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id),
  constraint members_role check (role in ('owner', 'staff'))
);
create index if not exists members_user on public.members (user_id);

-- People invited to a team who haven't signed in yet.
create table if not exists public.invites (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  email      text not null,
  role       text not null default 'staff',
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, email),
  constraint invites_role check (role in ('owner', 'staff')),
  constraint invites_email_lower check (email = lower(email))
);

-- Everything the tracker stores: cars, customers, bookings, fines and so on.
-- One row per record. Deleting marks the row deleted and empties it, so every
-- open device hears about the delete.
create table if not exists public.records (
  org_id     uuid not null references public.orgs(id) on delete cascade,
  col        text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (org_id, col, id),
  constraint records_col_format check (col ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint records_id_length check (char_length(id) between 1 and 200),
  constraint records_size check (octet_length(data::text) <= 2000000)
);
create index if not exists records_sync on public.records (org_id, updated_at);

-- ---------------------------------------------------------------------
-- 2. Helpers used by the security rules
-- ---------------------------------------------------------------------

create or replace function app.my_role(o uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.members m where m.org_id = o and m.user_id = auth.uid()
$$;

create or replace function app.can_read(o uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.org_id = o and m.user_id = auth.uid())
$$;

create or replace function app.can_write(o uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.org_id = o and m.user_id = auth.uid() and m.role in ('owner', 'staff'))
$$;

create or replace function app.is_owner(o uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m where m.org_id = o and m.user_id = auth.uid() and m.role = 'owner')
$$;

-- The business a stored file belongs to: files live under "<business id>/<file>".
create or replace function app.path_org(p text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p, '/', 1)::uuid end
$$;

create or replace function app.records_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  if new.deleted then new.data := '{}'::jsonb; end if;
  return new;
end
$$;

drop trigger if exists records_touch on public.records;
create trigger records_touch before insert or update on public.records
for each row execute function app.records_touch();

revoke all on all functions in schema app from public;
grant usage on schema app to authenticated;
grant execute on function app.my_role(uuid), app.can_read(uuid), app.can_write(uuid), app.is_owner(uuid), app.path_org(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Security rules (row level security)
-- ---------------------------------------------------------------------

alter table public.app_config enable row level security;
alter table public.orgs       enable row level security;
alter table public.members    enable row level security;
alter table public.invites    enable row level security;
alter table public.records    enable row level security;

-- Nothing is open to the public directly. Customer pages only use the two
-- public functions further down, which return or accept exactly what they need.
revoke all on public.app_config, public.orgs, public.members, public.invites, public.records from anon;
revoke all on public.app_config from authenticated;
revoke all on public.orgs, public.members, public.invites, public.records from authenticated;
grant select on public.orgs, public.members to authenticated;
grant select, insert, update on public.records to authenticated;

drop policy if exists orgs_select on public.orgs;
create policy orgs_select on public.orgs for select to authenticated using (app.can_read(id));

drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated using (app.can_read(org_id));

drop policy if exists records_select on public.records;
create policy records_select on public.records for select to authenticated using (app.can_read(org_id));

drop policy if exists records_insert on public.records;
create policy records_insert on public.records for insert to authenticated with check (app.can_write(org_id));

drop policy if exists records_update on public.records;
create policy records_update on public.records for update to authenticated
  using (app.can_write(org_id)) with check (app.can_write(org_id));

-- Live updates: let open trackers hear about changes straight away.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'records') then
    alter publication supabase_realtime add table public.records;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 4. Functions the staff app calls
-- ---------------------------------------------------------------------

create table if not exists app.setup_attempts (
  user_id uuid not null,
  at      timestamptz not null default now()
);
revoke all on app.setup_attempts from public;

-- Set up a new business. Needs the platform's setup code.
create or replace function public.create_business(p_name text, p_slug text, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_code  text;
  v_org   uuid;
  v_email text;
  v_slug  text := lower(trim(coalesce(p_slug, '')));
  v_name  text := trim(coalesce(p_name, ''));
  v_reserved text[] := array['staff','book','details','vendor','fonts','shared','api','config','admin','app','www',
                             'assets','static','login','signup','index','favicon','robots','help','support','about',
                             'privacy','terms','auth','rest','storage','realtime','demo','new'];
begin
  if v_uid is null then return jsonb_build_object('error', 'signed_out'); end if;
  if (select count(*) from app.setup_attempts a where a.user_id = v_uid and a.at > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  select c.value into v_code from public.app_config c where c.key = 'signup_code';
  if v_code is null or v_code = 'CHANGE-ME' then return jsonb_build_object('error', 'setup_closed'); end if;
  if p_code is distinct from v_code then
    insert into app.setup_attempts (user_id) values (v_uid);
    return jsonb_build_object('error', 'bad_code');
  end if;
  if char_length(v_name) not between 1 and 80 then return jsonb_build_object('error', 'bad_name'); end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' or v_slug = any(v_reserved) then return jsonb_build_object('error', 'bad_slug'); end if;
  if exists (select 1 from public.orgs o where o.slug = v_slug) then return jsonb_build_object('error', 'slug_taken'); end if;
  if (select count(*) from public.members m where m.user_id = v_uid and m.role = 'owner') >= 20 then
    return jsonb_build_object('error', 'too_many');
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  insert into public.orgs (slug, name, created_by) values (v_slug, v_name, v_uid) returning id into v_org;
  insert into public.members (org_id, user_id, role, email) values (v_org, v_uid, 'owner', v_email);
  return jsonb_build_object('ok', true, 'id', v_org, 'slug', v_slug);
end
$$;

-- The businesses the signed-in person belongs to.
create or replace function public.my_businesses()
returns table (id uuid, slug text, name text, role text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.slug, o.name, m.role
  from public.members m join public.orgs o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by o.name
$$;

-- Turn any invites for the signed-in person's (confirmed) email into team places.
create or replace function public.claim_invites()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_email text;
  n       integer := 0;
begin
  if v_uid is null then return 0; end if;
  select lower(u.email) into v_email from auth.users u where u.id = v_uid and u.email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  insert into public.members (org_id, user_id, role, email)
    select i.org_id, v_uid, i.role, v_email from public.invites i where i.email = v_email
  on conflict (org_id, user_id) do nothing;
  get diagnostics n = row_count;
  delete from public.invites i where i.email = v_email;
  return n;
end
$$;

-- The team for a business: people on it, and invites waiting (owners only see invites).
create or replace function public.team(p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.can_read(p_org) then return jsonb_build_object('error', 'not_member'); end if;
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', m.email, 'role', m.role, 'you', m.user_id = auth.uid()) order by m.created_at)
                         from public.members m where m.org_id = p_org), '[]'::jsonb),
    'invites', case when app.is_owner(p_org) then
                 coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role) order by i.created_at)
                           from public.invites i where i.org_id = p_org), '[]'::jsonb)
               else '[]'::jsonb end
  );
end
$$;

create or replace function public.invite_member(p_org uuid, p_email text, p_role text default 'staff')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  if not app.is_owner(p_org) then return jsonb_build_object('error', 'not_owner'); end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200 then return jsonb_build_object('error', 'bad_email'); end if;
  if p_role not in ('owner', 'staff') then return jsonb_build_object('error', 'bad_role'); end if;
  if exists (select 1 from public.members m where m.org_id = p_org and lower(m.email) = v_email) then
    return jsonb_build_object('error', 'already_member');
  end if;
  if (select count(*) from public.invites i where i.org_id = p_org) >= 50 then return jsonb_build_object('error', 'too_many'); end if;
  insert into public.invites (org_id, email, role, invited_by) values (p_org, v_email, p_role, auth.uid())
  on conflict (org_id, email) do update set role = excluded.role, invited_by = excluded.invited_by, created_at = now();
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.cancel_invite(p_org uuid, p_invite uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_owner(p_org) then return jsonb_build_object('error', 'not_owner'); end if;
  delete from public.invites i where i.org_id = p_org and i.id = p_invite;
  return jsonb_build_object('ok', true);
end
$$;

-- Remove someone from the team. Owners can remove anyone; anyone can leave. The last owner can't go.
create or replace function public.remove_member(p_org uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if not (app.is_owner(p_org) or p_user = auth.uid()) then return jsonb_build_object('error', 'not_owner'); end if;
  select m.role into v_role from public.members m where m.org_id = p_org and m.user_id = p_user;
  if v_role is null then return jsonb_build_object('ok', true); end if;
  if v_role = 'owner' and (select count(*) from public.members m where m.org_id = p_org and m.role = 'owner') <= 1 then
    return jsonb_build_object('error', 'last_owner');
  end if;
  delete from public.members m where m.org_id = p_org and m.user_id = p_user;
  return jsonb_build_object('ok', true);
end
$$;

create or replace function public.set_member_role(p_org uuid, p_user uuid, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text;
begin
  if not app.is_owner(p_org) then return jsonb_build_object('error', 'not_owner'); end if;
  if p_role not in ('owner', 'staff') then return jsonb_build_object('error', 'bad_role'); end if;
  select m.role into v_role from public.members m where m.org_id = p_org and m.user_id = p_user;
  if v_role is null then return jsonb_build_object('error', 'not_member'); end if;
  if v_role = 'owner' and p_role <> 'owner' and (select count(*) from public.members m where m.org_id = p_org and m.role = 'owner') <= 1 then
    return jsonb_build_object('error', 'last_owner');
  end if;
  update public.members m set role = p_role where m.org_id = p_org and m.user_id = p_user;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------
-- 5. Functions the customer pages call (no sign-in)
-- ---------------------------------------------------------------------

-- What the booking page shows: the business name and the availability the
-- tracker publishes. No names, numbers or bookings are ever in it.
create or replace function public.public_page(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name', o.name, 'slug', o.slug,
                            'page', case when r.deleted then null else r.data end)
  from public.orgs o
  left join public.records r on r.org_id = o.id and r.col = 'public' and r.id = 'availability'
  where o.slug = lower(trim(p_slug))
$$;

-- A booking request, waiting-list request or hire details form from a customer.
-- It lands in the business's inbox in the tracker. Limits stop floods.
create or replace function public.submit_inbox(p_slug text, p_kind text, p_message text,
                                               p_name text default '', p_phone text default '', p_ref text default '')
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org   uuid;
  v_on    boolean;
  v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_now   timestamptz := now();
  v_id    text;
begin
  select o.id, coalesce((r.data ->> 'on')::boolean, false) into v_org, v_on
  from public.orgs o
  left join public.records r on r.org_id = o.id and r.col = 'public' and r.id = 'availability' and not r.deleted
  where o.slug = lower(trim(coalesce(p_slug, '')));
  if v_org is null then return jsonb_build_object('error', 'not_found'); end if;
  if p_kind is null or p_kind not in ('booking', 'wait', 'details') then return jsonb_build_object('error', 'invalid'); end if;
  if p_message is null or char_length(p_message) not between 10 and 4000
     or char_length(coalesce(p_name, '')) > 100 or char_length(coalesce(p_phone, '')) > 30
     or char_length(coalesce(p_ref, '')) > 12 then
    return jsonb_build_object('error', 'invalid');
  end if;
  if p_kind in ('booking', 'wait') and not v_on then return jsonb_build_object('error', 'page_off'); end if;
  if (select count(*) from public.records x
      where x.org_id = v_org and x.col = 'inbox' and not x.deleted
        and x.updated_at > v_now - interval '1 hour') >= 60 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if char_length(v_phone) = 9 and (select count(*) from public.records x
      where x.org_id = v_org and x.col = 'inbox' and x.data ->> 'phoneKey' = v_phone
        and x.updated_at > v_now - interval '1 hour') >= 6 then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  v_id := 'in' || replace(gen_random_uuid()::text, '-', '');
  insert into public.records (org_id, col, id, data)
  values (v_org, 'inbox', v_id, jsonb_build_object(
    'kind', p_kind,
    'message', p_message,
    'name', left(trim(coalesce(p_name, '')), 100),
    'phone', left(trim(coalesce(p_phone, '')), 30),
    'phoneKey', v_phone,
    'ref', upper(left(trim(coalesce(p_ref, '')), 12)),
    'at', v_now,
    'createdAt', v_now,
    'updatedAt', v_now));
  return jsonb_build_object('ok', true);
end
$$;

-- Who may call what.
revoke all on function public.create_business(text, text, text), public.my_businesses(), public.claim_invites(),
                       public.team(uuid), public.invite_member(uuid, text, text), public.cancel_invite(uuid, uuid),
                       public.remove_member(uuid, uuid), public.set_member_role(uuid, uuid, text),
                       public.public_page(text), public.submit_inbox(text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.create_business(text, text, text), public.my_businesses(), public.claim_invites(),
                          public.team(uuid), public.invite_member(uuid, text, text), public.cancel_invite(uuid, uuid),
                          public.remove_member(uuid, uuid), public.set_member_role(uuid, uuid, text)
  to authenticated;
grant execute on function public.public_page(text), public.submit_inbox(text, text, text, text, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. Photos and documents (private storage, per business)
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('assets', 'assets', false, 20971520, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists hire_assets_read on storage.objects;
create policy hire_assets_read on storage.objects for select to authenticated
  using (bucket_id = 'assets' and app.can_read(app.path_org(name)));

drop policy if exists hire_assets_insert on storage.objects;
create policy hire_assets_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'assets' and app.can_write(app.path_org(name)));

drop policy if exists hire_assets_update on storage.objects;
create policy hire_assets_update on storage.objects for update to authenticated
  using (bucket_id = 'assets' and app.can_write(app.path_org(name)))
  with check (bucket_id = 'assets' and app.can_write(app.path_org(name)));

drop policy if exists hire_assets_delete on storage.objects;
create policy hire_assets_delete on storage.objects for delete to authenticated
  using (bucket_id = 'assets' and app.can_write(app.path_org(name)));
