-- EWGF Practice leaderboard: run this once in Supabase (SQL Editor -> New query -> paste -> Run).
-- Safe to run again: it drops and recreates the leaderboard objects (scores are kept only if
-- you comment out the two "drop table" lines).

-- ---------------------------------------------------------------------------
-- Players: one row per account, created automatically when someone signs up.
-- ---------------------------------------------------------------------------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.submit_score(text, integer);
drop function if exists public.add_to_counter(text, integer);
drop table if exists public.scores;
drop table if exists public.profiles;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,16}$'),
  created_at timestamptz not null default now()
);
create unique index profiles_username_lower on public.profiles (lower(username));

alter table public.profiles enable row level security;
create policy "anyone can see player names" on public.profiles for select using (true);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;

-- Only the trigger should run this, not visitors through the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Scores: each player's best result (or running total) per board.
--   i13_count    - total i13 (13-frame) Electrics ever landed       running total
--   ewgf_streak  - most Electrics in a row (EWGF Trainer)          higher is better
--   ewgf_rate50  - most Electrics in any 50 attempts in a row      higher is better
--   rhythm_combo - longest combo at real speed (Rhythm Game)       higher is better
--   df_streak    - most df+2 hits in a row at level 1 (real speed) higher is better
-- ---------------------------------------------------------------------------
create table public.scores (
  user_id uuid not null references public.profiles (id) on delete cascade,
  category text not null check (category in ('i13_count', 'ewgf_streak', 'ewgf_rate50', 'rhythm_combo', 'df_streak')),
  value integer not null check (value > 0),
  achieved_at timestamptz not null default now(),
  primary key (user_id, category)
);
create index scores_board on public.scores (category, value desc, achieved_at);

alter table public.scores enable row level security;
create policy "anyone can see scores" on public.scores for select using (true);
-- No insert/update policies on purpose: scores only change through submit_score below,
-- which only ever raises your own best.

create function public.submit_score(p_category text, p_value integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  max_value integer;
begin
  if uid is null then
    raise exception 'Sign in to submit scores';
  end if;
  max_value := case p_category
    when 'ewgf_streak' then 10000
    when 'ewgf_rate50' then 50
    when 'rhythm_combo' then 10000
    when 'df_streak' then 10000
  end;
  if max_value is null or p_value is null or p_value < 1 or p_value > max_value then
    raise exception 'Invalid score';
  end if;

  insert into public.scores (user_id, category, value)
  values (uid, p_category, p_value)
  on conflict (user_id, category) do update
    set value = excluded.value, achieved_at = now()
    where excluded.value > public.scores.value;
  return found;
end $$;

revoke all on function public.submit_score(text, integer) from public, anon;
grant execute on function public.submit_score(text, integer) to authenticated;

-- Running totals (only the i13 counter for now): adds a small amount to your own total.
create function public.add_to_counter(p_category text, p_amount integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  total integer;
begin
  if uid is null then
    raise exception 'Sign in to submit scores';
  end if;
  if p_category is distinct from 'i13_count' or p_amount is null or p_amount < 1 or p_amount > 20 then
    raise exception 'Invalid score';
  end if;
  insert into public.scores (user_id, category, value)
  values (uid, p_category, p_amount)
  on conflict (user_id, category) do update
    set value = public.scores.value + excluded.value, achieved_at = now()
  returning value into total;
  return total;
end $$;

revoke all on function public.add_to_counter(text, integer) from public, anon;
grant execute on function public.add_to_counter(text, integer) to authenticated;
