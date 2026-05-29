-- Lingua Viva — Supabase Schema (Phase 1)
-- Run this in the Supabase SQL editor for both dev and prod projects.

-- Users table (extends Supabase auth.users)
create table if not exists public.users (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  stripe_customer_id  text unique,
  subscription_status text default 'free',  -- 'free' | 'active' | 'past_due' | 'canceled'
  created_at          timestamptz default now()
);

-- Auto-create a users row when someone signs up via Supabase Auth
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Usage table (tracks narrations per identity per day)
-- identity_key is either an anon UUID or a Supabase user UUID
create table if not exists public.usage (
  identity_key  text        not null,
  date          date        not null,
  narration_count integer   not null default 0,
  primary key (identity_key, date)
);

-- RPC function for atomic usage increment (upsert + increment)
create or replace function public.increment_usage(p_identity_key text, p_date date)
returns void as $$
begin
  insert into public.usage (identity_key, date, narration_count)
  values (p_identity_key, p_date, 1)
  on conflict (identity_key, date)
  do update set narration_count = public.usage.narration_count + 1;
end;
$$ language plpgsql security definer;

-- Row-level security
alter table public.users enable row level security;
alter table public.usage enable row level security;

-- Users can read/update their own row
create policy "users_own_row" on public.users
  for all using (auth.uid() = id);

-- Usage rows are managed by the Worker (service role key bypasses RLS)
-- No direct client access needed
