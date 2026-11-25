create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  username text not null default '',
  role text not null default 'student' check (role in ('student', 'teacher', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists username text not null default '';

update public.profiles
set username = coalesce(nullif(left(split_part(email, '@', 1), 40), ''), 'Student')
where trim(username) = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_username_length_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_username_length_check
      check (length(trim(username)) between 1 and 40);
  end if;
end;
$$;

create or replace function public.is_examwatch_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role in ('teacher', 'admin')
  );
$$;

create or replace function public.create_examwatch_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, username)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(left(trim(new.raw_user_meta_data ->> 'username'), 40), ''),
      nullif(left(split_part(coalesce(new.email, ''), '@', 1), 40), ''),
      'Student'
    )
  );
  return new;
end;
$$;

drop trigger if exists on_examwatch_auth_user_created on auth.users;
create trigger on_examwatch_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_examwatch_profile();

insert into public.profiles (id, email, username)
select
  id,
  coalesce(email, ''),
  coalesce(
    nullif(left(trim(raw_user_meta_data ->> 'username'), 40), ''),
    nullif(left(split_part(coalesce(email, ''), '@', 1), 40), ''),
    'Student'
  )
from auth.users
on conflict (id) do nothing;

update public.profiles
set username = coalesce(nullif(left(split_part(email, '@', 1), 40), ''), 'Student')
where trim(username) = '';

create table if not exists public.assessment_results (
  id uuid primary key default gen_random_uuid(),
  attempt_id text not null unique,
  student_id uuid not null references auth.users (id) on delete cascade,
  student_username text not null default '',
  student_email text not null,
  subject text not null,
  score integer not null check (score >= 0),
  total integer not null check (total > 0 and score <= total),
  violations integer not null default 0 check (violations >= 0),
  submitted_at timestamptz not null default now()
);

create table if not exists public.live_sessions (
  id text primary key,
  student_id uuid not null references auth.users (id) on delete cascade,
  student_username text not null default '',
  student_email text not null,
  subject text not null,
  status text not null check (status in ('active', 'hidden', 'paused', 'submitted', 'disconnected')),
  violations integer not null default 0 check (violations >= 0),
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.activity_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id text,
  assessment_id uuid,
  assessment_title text,
  student_id uuid not null references auth.users (id) on delete cascade,
  student_username text not null default '',
  student_email text not null,
  subject text not null,
  event_type text not null,
  label text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

alter table public.activity_events
  add column if not exists attempt_id text;

alter table public.assessment_results
  add column if not exists student_username text not null default '';
alter table public.live_sessions
  add column if not exists student_username text not null default '';
alter table public.activity_events
  add column if not exists student_username text not null default '';

update public.assessment_results result
set student_username = profile.username
from public.profiles profile
where profile.id = result.student_id
  and trim(result.student_username) = '';
update public.live_sessions session
set student_username = profile.username
from public.profiles profile
where profile.id = session.student_id
  and trim(session.student_username) = '';
update public.activity_events evt
set student_username = profile.username
from public.profiles profile
where profile.id = evt.student_id
  and trim(evt.student_username) = '';

create or replace function public.set_examwatch_record_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  select coalesce(email, '')
  into new.student_email
  from auth.users
  where id = new.student_id;

  select username
  into new.student_username
  from public.profiles
  where id = new.student_id;
  new.student_username := coalesce(nullif(trim(new.student_username), ''), 'Student');

  if tg_table_name = 'live_sessions' then
    new.last_seen := now();
  elsif tg_table_name = 'assessment_results' then
    new.submitted_at := now();
  elsif tg_table_name = 'activity_events' then
    new.created_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists set_examwatch_live_session_identity on public.live_sessions;
create trigger set_examwatch_live_session_identity
  before insert or update on public.live_sessions
  for each row execute procedure public.set_examwatch_record_identity();
drop trigger if exists set_examwatch_result_identity on public.assessment_results;
create trigger set_examwatch_result_identity
  before insert on public.assessment_results
  for each row execute procedure public.set_examwatch_record_identity();
drop trigger if exists set_examwatch_activity_identity on public.activity_events;
create trigger set_examwatch_activity_identity
  before insert on public.activity_events
  for each row execute procedure public.set_examwatch_record_identity();

create index if not exists assessment_results_submitted_at_idx
  on public.assessment_results (submitted_at desc);
create index if not exists live_sessions_last_seen_idx
  on public.live_sessions (last_seen desc);
create index if not exists activity_events_created_at_idx
  on public.activity_events (created_at desc);

alter table public.profiles enable row level security;
alter table public.assessment_results enable row level security;
alter table public.live_sessions enable row level security;
alter table public.activity_events enable row level security;

drop policy if exists "Users can read own profile, teachers can read all" on public.profiles;
create policy "Users can read own profile, teachers can read all"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_examwatch_teacher()));

drop policy if exists "Students update their own username" on public.profiles;
create policy "Students update their own username"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "Students submit their own results" on public.assessment_results;
create policy "Students submit their own results"
  on public.assessment_results for insert to authenticated
  with check (student_id = (select auth.uid()));
drop policy if exists "Teachers read assessment results" on public.assessment_results;
create policy "Teachers read assessment results"
  on public.assessment_results for select to authenticated
  using ((select public.is_examwatch_teacher()));

drop policy if exists "Students manage their own live sessions" on public.live_sessions;
create policy "Students manage their own live sessions"
  on public.live_sessions for all to authenticated
  using (student_id = (select auth.uid()))
  with check (student_id = (select auth.uid()));
drop policy if exists "Teachers read live sessions" on public.live_sessions;
create policy "Teachers read live sessions"
  on public.live_sessions for select to authenticated
  using ((select public.is_examwatch_teacher()));

drop policy if exists "Students add their own activity" on public.activity_events;
create policy "Students add their own activity"
  on public.activity_events for insert to authenticated
  with check (
    student_id = (select auth.uid())
    and (
      attempt_id is null
      or exists (
        select 1
        from public.live_sessions session
        where session.id = activity_events.attempt_id
          and session.student_id = (select auth.uid())
      )
    )
  );
drop policy if exists "Teachers read activity" on public.activity_events;
create policy "Teachers read activity"
  on public.activity_events for select to authenticated
  using ((select public.is_examwatch_teacher()));

grant select on public.profiles to authenticated;
grant update (username) on public.profiles to authenticated;
grant select, insert on public.assessment_results to authenticated;
grant select, insert, update, delete on public.live_sessions to authenticated;
grant select, insert on public.activity_events to authenticated;

-- After creating the teacher account in Supabase Authentication, promote it:
-- update public.profiles set role = 'admin' where email = 'teacher@school.edu';
