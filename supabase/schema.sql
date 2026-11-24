-- 1. User profiles (no email column; timezone only for 08:00 local reminders)
create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

alter table public.user_profiles drop column if exists email;

alter table public.user_profiles enable row level security;

drop policy if exists "Users can view own profile" on public.user_profiles;
create policy "Users can view own profile"
  on public.user_profiles for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own profile" on public.user_profiles;
create policy "Users can insert own profile"
  on public.user_profiles for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can update own profile"
  on public.user_profiles for update
  using (auth.uid() = user_id);

-- 2. Items table (no user_email column; recipients resolved from auth.users)
create table if not exists public.nudge_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  type text not null default 'other'
    check (type in ('subscription_trial', 'return_window', 'bill', 'official_letter', 'other')),
  amount numeric null,
  currency text null,
  deadline date null,
  next_action text not null,
  status text not null default 'active'
    check (status in ('active', 'done', 'waiting_room')),
  snoozed_until date null,
  sent_steps integer[] not null default '{}',
  unresponded_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nudge_items drop column if exists user_email;

alter table public.nudge_items drop constraint if exists chk_nudge_items_title_len;
alter table public.nudge_items
  add constraint chk_nudge_items_title_len check (char_length(title) <= 200);

alter table public.nudge_items drop constraint if exists chk_nudge_items_next_action_len;
alter table public.nudge_items
  add constraint chk_nudge_items_next_action_len check (char_length(next_action) <= 500);

create index if not exists idx_nudge_items_active_deadline
  on public.nudge_items (status, deadline);

create index if not exists idx_nudge_items_user_updated
  on public.nudge_items (user_id, updated_at desc);

alter table public.nudge_items enable row level security;

drop policy if exists "Users can view own items" on public.nudge_items;
create policy "Users can view own items"
  on public.nudge_items for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own items" on public.nudge_items;
create policy "Users can insert own items"
  on public.nudge_items for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own items" on public.nudge_items;
create policy "Users can update own items"
  on public.nudge_items for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete own items" on public.nudge_items;
create policy "Users can delete own items"
  on public.nudge_items for delete
  using (auth.uid() = user_id);

-- Enforce max 200 rows per user in nudge_items (upsert-safe)
create or replace function public.enforce_nudge_items_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- Allow upserts targeting an existing row
  if exists (select 1 from public.nudge_items where id = new.id) then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext(new.user_id::text));

  select count(*) into v_count
  from public.nudge_items
  where user_id = new.user_id;

  if v_count >= 200 then
    raise exception 'Maximum limit of 200 items per user reached.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_nudge_items_limit on public.nudge_items;
create trigger trg_nudge_items_limit
  before insert on public.nudge_items
  for each row
  execute function public.enforce_nudge_items_limit();

-- 3. Per-user daily rate limit tracking for extract-nudge
create table if not exists public.extract_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null default (now() at time zone 'UTC')::date,
  request_count integer not null default 0,
  primary key (user_id, usage_date)
);

alter table public.extract_usage enable row level security;

create or replace function public.consume_extract_quota(
  p_user_id uuid,
  p_limit integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.extract_usage (user_id, usage_date, request_count)
  values (p_user_id, (now() at time zone 'UTC')::date, 1)
  on conflict (user_id, usage_date)
  do update set request_count = extract_usage.request_count + 1
  where extract_usage.request_count < p_limit
  returning request_count into v_count;

  return v_count is not null;
end;
$$;

revoke all on function public.consume_extract_quota(uuid, integer) from public;
grant execute on function public.consume_extract_quota(uuid, integer) to service_role;

-- 4. Hourly Cron Job
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'nudge-hourly-reminders',
  '0 * * * *',
  $$
  select
    net.http_post(
      url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', 'YOUR_CRON_SECRET'
      ),
      body := '{}'::jsonb
    ) as request_id;
  $$
);
