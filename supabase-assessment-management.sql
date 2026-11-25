create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 120),
  subject text not null check (length(trim(subject)) between 1 and 120),
  duration_minutes integer not null check (duration_minutes between 1 and 240),
  questions jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) > 0),
  assessment_type text not null default 'multiple_choice'
    check (assessment_type in ('multiple_choice', 'image_based')),
  image_layout text not null default 'per_question'
    check (image_layout in ('per_question', 'worksheet')),
  shuffle_questions boolean not null default false,
  is_open boolean not null default true,
  closed_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assessments_subject_title_unique unique (subject, title)
);

alter table public.assessments
  add column if not exists assessment_type text not null default 'multiple_choice';
alter table public.assessments
  add column if not exists image_layout text not null default 'per_question';
alter table public.assessments
  add column if not exists shuffle_questions boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'assessments_assessment_type_check'
      and conrelid = 'public.assessments'::regclass
  ) then
    alter table public.assessments
      add constraint assessments_assessment_type_check
      check (assessment_type in ('multiple_choice', 'image_based'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'assessments_image_layout_check'
      and conrelid = 'public.assessments'::regclass
  ) then
    alter table public.assessments
      add constraint assessments_image_layout_check
      check (image_layout in ('per_question', 'worksheet'));
  end if;
end;
$$;

create table if not exists public.assessment_answer_keys (
  assessment_id uuid primary key references public.assessments (id) on delete cascade,
  answers jsonb not null check (jsonb_typeof(answers) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.live_sessions
  add column if not exists assessment_id uuid references public.assessments (id) on delete set null;

alter table public.live_sessions
  add column if not exists assessment_title text;

alter table public.assessment_results
  add column if not exists assessment_id uuid references public.assessments (id) on delete set null;

alter table public.assessment_results
  add column if not exists assessment_title text;

alter table public.assessment_results
  add column if not exists submitted_answers jsonb not null default '[]'::jsonb;

alter table public.assessment_results
  add column if not exists submitted_questions jsonb not null default '[]'::jsonb;

alter table public.assessment_results
  add column if not exists started_at timestamptz;

alter table public.assessment_results
  add column if not exists submission_image_path text;
alter table public.assessment_results
  add column if not exists grading_status text not null default 'auto_graded'
  check (grading_status in ('auto_graded', 'needs_review', 'graded'));
alter table public.assessment_results
  alter column score drop not null;

alter table public.activity_events
  add column if not exists attempt_id text;

alter table public.activity_events
  add column if not exists assessment_id uuid;

alter table public.activity_events
  add column if not exists assessment_title text;

create index if not exists assessments_open_updated_idx
  on public.assessments (is_open, updated_at desc);
create index if not exists live_sessions_assessment_student_idx
  on public.live_sessions (assessment_id, student_id, started_at);
create index if not exists activity_events_attempt_created_idx
  on public.activity_events (attempt_id, created_at);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'examwatch-assessment-files',
  'examwatch-assessment-files',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Teachers manage ExamWatch assessment files" on storage.objects;
create policy "Teachers manage ExamWatch assessment files"
  on storage.objects for all to authenticated
  using (
    bucket_id = 'examwatch-assessment-files'
    and (select public.is_examwatch_teacher())
  )
  with check (
    bucket_id = 'examwatch-assessment-files'
    and (select public.is_examwatch_teacher())
  );

drop policy if exists "Students read assigned assessment images" on storage.objects;
create policy "Students read assigned assessment images"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'examwatch-assessment-files'
    and split_part(name, '/', 1) = 'questions'
    and (
      (select public.is_examwatch_teacher())
      or exists (
        select 1
        from public.assessments assessment
        where assessment.id::text = split_part(name, '/', 2)
          and (
            assessment.is_open
            or exists (
              select 1
              from public.live_sessions session
              where session.assessment_id = assessment.id
                and session.student_id = (select auth.uid())
                and (assessment.closed_at is null or session.started_at <= assessment.closed_at)
            )
          )
      )
    )
  );

drop policy if exists "Students upload their own assessment work" on storage.objects;
create policy "Students upload their own assessment work"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'examwatch-assessment-files'
    and split_part(name, '/', 1) = 'submissions'
    and split_part(name, '/', 2) = (select auth.uid())::text
    and exists (
      select 1
      from public.live_sessions session
      where session.id = split_part(name, '/', 3)
        and session.student_id = (select auth.uid())
        and session.status in ('active', 'hidden', 'paused', 'disconnected')
    )
  );

drop policy if exists "Teachers read submitted assessment work" on storage.objects;
create policy "Teachers read submitted assessment work"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'examwatch-assessment-files'
    and split_part(name, '/', 1) = 'submissions'
    and (select public.is_examwatch_teacher())
  );

alter table public.assessments enable row level security;
alter table public.assessment_answer_keys enable row level security;

drop policy if exists "Students see open assessments and their started assessments" on public.assessments;
create policy "Students see open assessments and their started assessments"
  on public.assessments for select to authenticated
  using (
    is_open
    or exists (
      select 1
      from public.live_sessions session
      where session.assessment_id = assessments.id
        and session.student_id = (select auth.uid())
        and (assessments.closed_at is null or session.started_at <= assessments.closed_at)
    )
  );

drop policy if exists "Teachers manage assessments" on public.assessments;
create policy "Teachers manage assessments"
  on public.assessments for all to authenticated
  using ((select public.is_examwatch_teacher()))
  with check ((select public.is_examwatch_teacher()));

drop policy if exists "Teachers manage assessment answer keys" on public.assessment_answer_keys;
create policy "Teachers manage assessment answer keys"
  on public.assessment_answer_keys for all to authenticated
  using ((select public.is_examwatch_teacher()))
  with check ((select public.is_examwatch_teacher()));

grant select on public.assessments to authenticated;
grant select on public.assessment_answer_keys to authenticated;
grant insert, update, delete on public.assessments to authenticated;
grant insert, update, delete on public.assessment_answer_keys to authenticated;

drop function if exists public.save_examwatch_assessment(uuid, text, text, integer, jsonb, jsonb, boolean);

create or replace function public.save_examwatch_assessment(
  p_assessment_id uuid,
  p_title text,
  p_subject text,
  p_duration_minutes integer,
  p_questions jsonb,
  p_answers jsonb,
  p_is_open boolean,
  p_assessment_type text,
  p_image_layout text,
  p_shuffle_questions boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_index integer;
  v_question jsonb;
  v_answer integer;
  v_answer_text text;
begin
  if not public.is_examwatch_teacher() then
    raise exception 'Teacher access required';
  end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 120
    or length(trim(coalesce(p_subject, ''))) not between 1 and 120 then
    raise exception 'Title and subject must be between 1 and 120 characters';
  end if;
  if p_duration_minutes not between 1 and 240 then
    raise exception 'Duration must be between 1 and 240 minutes';
  end if;
  if p_assessment_type not in ('multiple_choice', 'image_based') then
    raise exception 'Invalid assessment type';
  end if;
  if p_image_layout not in ('per_question', 'worksheet') then
    raise exception 'Invalid image layout';
  end if;
  if jsonb_typeof(p_questions) <> 'array'
    or jsonb_typeof(p_answers) <> 'array'
    or jsonb_array_length(p_questions) = 0
    or jsonb_array_length(p_questions) <> jsonb_array_length(p_answers) then
    raise exception 'Questions and answer key must contain the same non-zero number of items';
  end if;

  v_id := coalesce(p_assessment_id, gen_random_uuid());

  if p_assessment_type = 'image_based'
    and p_image_layout = 'worksheet'
    and exists (
      select 1
      from jsonb_array_elements(p_questions) as expanded_questions(question_record)
      where question_record ->> 'image_path' is distinct from p_questions -> 0 ->> 'image_path'
    ) then
    raise exception 'All questions in a worksheet must use the same image';
  end if;

  for v_index in 0 .. jsonb_array_length(p_questions) - 1 loop
    v_question := p_questions -> v_index;
    if p_assessment_type = 'multiple_choice' then
      if jsonb_typeof(v_question -> 'q') <> 'string'
        or length(trim(v_question ->> 'q')) = 0
        or jsonb_typeof(v_question -> 'o') <> 'array'
        or jsonb_array_length(v_question -> 'o') <> 4 then
        raise exception 'Each question needs text and exactly four choices';
      end if;
      if exists (
        select 1
        from jsonb_array_elements(v_question -> 'o') choice
        where jsonb_typeof(choice) <> 'string' or length(trim(choice #>> '{}')) = 0
      ) then
        raise exception 'Every answer choice must have text';
      end if;
      if jsonb_typeof(p_answers -> v_index) <> 'number' then
        raise exception 'Select one correct choice for each question';
      end if;
      v_answer := (p_answers ->> v_index)::integer;
      if v_answer < 0 or v_answer > 3 then
        raise exception 'Correct answer must refer to one of the four choices';
      end if;
    else
      if jsonb_typeof(v_question -> 'image_path') <> 'string'
        or left(v_question ->> 'image_path', length('questions/' || v_id::text || '/'))
          <> ('questions/' || v_id::text || '/')
        or not exists (
          select 1
          from storage.objects stored_file
          where stored_file.bucket_id = 'examwatch-assessment-files'
            and stored_file.name = v_question ->> 'image_path'
        ) then
        raise exception 'Upload an assessment image for every image question';
      end if;
      if jsonb_typeof(p_answers -> v_index) <> 'string' then
        raise exception 'Enter the expected typed answer for each image question';
      end if;
      v_answer_text := trim(p_answers ->> v_index);
      if length(v_answer_text) = 0 then
        raise exception 'Expected typed answers cannot be empty';
      end if;
    end if;
  end loop;

  if p_assessment_id is null then
    insert into public.assessments (
      id, title, subject, duration_minutes, questions, assessment_type, image_layout,
      shuffle_questions, is_open, closed_at, created_by
    ) values (
      v_id, trim(p_title), trim(p_subject), p_duration_minutes, p_questions,
      p_assessment_type, p_image_layout, p_shuffle_questions, p_is_open,
      case when p_is_open then null else now() end, auth.uid()
    )
    returning id into v_id;
  else
    update public.assessments
    set title = trim(p_title),
        subject = trim(p_subject),
        duration_minutes = p_duration_minutes,
        questions = p_questions,
        assessment_type = p_assessment_type,
        image_layout = p_image_layout,
        shuffle_questions = p_shuffle_questions,
        is_open = p_is_open,
        closed_at = case
          when p_is_open then null
          when is_open then now()
          else closed_at
        end,
        updated_at = now()
    where id = p_assessment_id
    returning id into v_id;
    if v_id is null then
      raise exception 'Assessment not found';
    end if;
  end if;

  insert into public.assessment_answer_keys (assessment_id, answers, updated_at)
  values (v_id, p_answers, now())
  on conflict (assessment_id) do update
  set answers = excluded.answers, updated_at = now();

  return v_id;
end;
$$;

create or replace function public.start_examwatch_assessment(
  p_assessment_id uuid,
  p_attempt_id text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment public.assessments%rowtype;
  v_started_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  if length(coalesce(p_attempt_id, '')) not between 8 and 100 then
    raise exception 'Invalid assessment attempt ID';
  end if;

  select * into v_assessment
  from public.assessments
  where id = p_assessment_id and is_open = true;
  if not found then
    raise exception 'This assessment is closed or unavailable';
  end if;

  insert into public.live_sessions (
    id, assessment_id, assessment_title, student_id, student_email, subject, status, violations, started_at, last_seen
  ) values (
    p_attempt_id, v_assessment.id, v_assessment.title, auth.uid(), '', v_assessment.subject, 'active', 0, now(), now()
  )
  on conflict (id) do update
    set status = 'active', last_seen = now()
    where public.live_sessions.student_id = auth.uid()
      and public.live_sessions.assessment_id = v_assessment.id
  returning started_at into v_started_at;

  if v_started_at is null then
    raise exception 'Invalid or conflicting assessment attempt';
  end if;
  return v_started_at;
end;
$$;

create or replace function public.submit_examwatch_assessment(
  p_assessment_id uuid,
  p_attempt_id text,
  p_answers integer[],
  p_violations integer
)
returns table (score integer, total integer, submitted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment public.assessments%rowtype;
  v_answer_key jsonb;
  v_session public.live_sessions%rowtype;
  v_existing_result public.assessment_results%rowtype;
  v_index integer;
  v_choice integer;
  v_score integer := 0;
  v_total integer;
  v_submitted_at timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  select * into v_assessment
  from public.assessments
  where id = p_assessment_id;
  if not found then
    raise exception 'Assessment not found';
  end if;
  if v_assessment.assessment_type <> 'multiple_choice' then
    raise exception 'Use the image assessment submission flow for this assessment';
  end if;
  select * into v_existing_result
  from public.assessment_results
  where attempt_id = p_attempt_id
    and assessment_id = p_assessment_id
    and student_id = auth.uid();
  if found then
    score := v_existing_result.score;
    total := v_existing_result.total;
    submitted_at := v_existing_result.submitted_at;
    return next;
    return;
  end if;
  select * into v_session
  from public.live_sessions
  where id = p_attempt_id
    and assessment_id = p_assessment_id
    and student_id = auth.uid()
    and status in ('active', 'hidden', 'paused', 'disconnected');
  if not found then
    raise exception 'No valid started attempt was found';
  end if;
  if not v_assessment.is_open
    and (v_assessment.closed_at is null or v_session.started_at > v_assessment.closed_at) then
    raise exception 'This assessment is closed';
  end if;

  select answers into v_answer_key
  from public.assessment_answer_keys
  where assessment_id = p_assessment_id;
  if v_answer_key is null then
    raise exception 'Assessment answer key is not configured';
  end if;
  v_total := jsonb_array_length(v_assessment.questions);
  if p_answers is null or cardinality(p_answers) <> v_total then
    raise exception 'Submitted answer count does not match the assessment';
  end if;
  if coalesce(p_violations, 0) < 0 or coalesce(p_violations, 0) > 10000 then
    raise exception 'Invalid activity count';
  end if;

  for v_index in 1 .. v_total loop
    v_choice := p_answers[v_index];
    if v_choice is not null then
      if v_choice < 0 or v_choice >= jsonb_array_length(v_assessment.questions -> (v_index - 1) -> 'o') then
        raise exception 'Submitted choice is invalid';
      end if;
      if v_choice = (v_answer_key ->> (v_index - 1))::integer then
        v_score := v_score + 1;
      end if;
    end if;
  end loop;

  insert into public.assessment_results (
    attempt_id, assessment_id, assessment_title, student_id, student_email, subject,
    score, total, violations, submitted_answers, submitted_questions, started_at, submitted_at
  ) values (
    p_attempt_id, p_assessment_id, v_assessment.title, auth.uid(), '', v_assessment.subject,
    v_score, v_total, p_violations, to_jsonb(p_answers), v_assessment.questions, v_session.started_at, v_submitted_at
  );

  update public.live_sessions
  set status = 'submitted', violations = p_violations, last_seen = v_submitted_at
  where id = p_attempt_id and student_id = auth.uid();

  score := v_score;
  total := v_total;
  submitted_at := v_submitted_at;
  return next;
end;
$$;

create or replace function public.submit_examwatch_image_assessment(
  p_assessment_id uuid,
  p_attempt_id text,
  p_text_answers jsonb,
  p_submission_image_path text,
  p_violations integer
)
returns table (score integer, total integer, submitted_at timestamptz, grading_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assessment public.assessments%rowtype;
  v_answer_key jsonb;
  v_session public.live_sessions%rowtype;
  v_existing_result public.assessment_results%rowtype;
  v_index integer;
  v_score integer := 0;
  v_total integer;
  v_submitted_at timestamptz := now();
  v_grading_status text;
  v_student_answer text;
  v_expected_answer text;
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  select * into v_assessment
  from public.assessments
  where id = p_assessment_id and assessment_type = 'image_based';
  if not found then
    raise exception 'Image assessment not found';
  end if;

  select * into v_existing_result
  from public.assessment_results
  where attempt_id = p_attempt_id
    and assessment_id = p_assessment_id
    and student_id = auth.uid();
  if found then
    score := v_existing_result.score;
    total := v_existing_result.total;
    submitted_at := v_existing_result.submitted_at;
    grading_status := v_existing_result.grading_status;
    return next;
    return;
  end if;

  select * into v_session
  from public.live_sessions
  where id = p_attempt_id
    and assessment_id = p_assessment_id
    and student_id = auth.uid()
    and status in ('active', 'hidden', 'paused', 'disconnected');
  if not found then
    raise exception 'No valid started attempt was found';
  end if;
  if not v_assessment.is_open
    and (v_assessment.closed_at is null or v_session.started_at > v_assessment.closed_at) then
    raise exception 'This assessment is closed';
  end if;
  if coalesce(p_violations, 0) < 0 or coalesce(p_violations, 0) > 10000 then
    raise exception 'Invalid activity count';
  end if;

  v_total := jsonb_array_length(v_assessment.questions);
  if p_submission_image_path is not null then
    if p_text_answers is not null and p_text_answers <> '[]'::jsonb then
      raise exception 'Submit either typed answers or a work image, not both';
    end if;
    if left(
      p_submission_image_path,
      length('submissions/' || auth.uid()::text || '/' || p_attempt_id || '/')
    ) <> ('submissions/' || auth.uid()::text || '/' || p_attempt_id || '/')
      or not exists (
        select 1
        from storage.objects stored_file
        where stored_file.bucket_id = 'examwatch-assessment-files'
          and stored_file.name = p_submission_image_path
      ) then
      raise exception 'Submitted work image is invalid';
    end if;
    v_grading_status := 'needs_review';
  else
    if jsonb_typeof(p_text_answers) <> 'array'
      or jsonb_array_length(p_text_answers) <> v_total then
      raise exception 'Typed answer count does not match the assessment';
    end if;
    select answers into v_answer_key
    from public.assessment_answer_keys
    where assessment_id = p_assessment_id;
    if v_answer_key is null then
      raise exception 'Assessment answer key is not configured';
    end if;

    for v_index in 0 .. v_total - 1 loop
      if jsonb_typeof(p_text_answers -> v_index) <> 'string' then
        raise exception 'Typed answers must be text';
      end if;
      v_student_answer := lower(regexp_replace(trim(p_text_answers ->> v_index), '\s+', ' ', 'g'));
      v_expected_answer := lower(regexp_replace(trim(v_answer_key ->> v_index), '\s+', ' ', 'g'));
      if length(v_student_answer) > 0 and v_student_answer = v_expected_answer then
        v_score := v_score + 1;
      end if;
    end loop;
    v_grading_status := 'auto_graded';
  end if;

  insert into public.assessment_results (
    attempt_id, assessment_id, assessment_title, student_id, student_email, subject,
    score, total, violations, submitted_answers, submitted_questions, started_at,
    submitted_at, submission_image_path, grading_status
  ) values (
    p_attempt_id, p_assessment_id, v_assessment.title, auth.uid(), '', v_assessment.subject,
    case when v_grading_status = 'needs_review' then null else v_score end,
    v_total, p_violations, coalesce(p_text_answers, '[]'::jsonb), v_assessment.questions,
    v_session.started_at, v_submitted_at, p_submission_image_path, v_grading_status
  );

  update public.live_sessions
  set status = 'submitted', violations = p_violations, last_seen = v_submitted_at
  where id = p_attempt_id and student_id = auth.uid();

  score := case when v_grading_status = 'needs_review' then null else v_score end;
  total := v_total;
  submitted_at := v_submitted_at;
  grading_status := v_grading_status;
  return next;
end;
$$;

create or replace function public.grade_examwatch_submission(
  p_result_id uuid,
  p_score integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_examwatch_teacher() then
    raise exception 'Teacher access required';
  end if;

  update public.assessment_results
  set score = p_score, total = 50, grading_status = 'graded'
  where id = p_result_id
    and grading_status = 'needs_review'
    and submission_image_path is not null
    and p_score between 0 and 50;
  if not found then
    raise exception 'Submission not found or score is outside the allowed range';
  end if;
end;
$$;

drop policy if exists "Students submit their own results" on public.assessment_results;
revoke insert on public.assessment_results from authenticated;

drop policy if exists "Students read their own graded results" on public.assessment_results;
create policy "Students read their own graded results"
  on public.assessment_results for select to authenticated
  using (
    student_id = (select auth.uid())
    and score is not null
    and grading_status in ('auto_graded', 'graded')
  );

grant execute on function public.save_examwatch_assessment(uuid, text, text, integer, jsonb, jsonb, boolean, text, text, boolean) to authenticated;
grant execute on function public.start_examwatch_assessment(uuid, text) to authenticated;
grant execute on function public.submit_examwatch_assessment(uuid, text, integer[], integer) to authenticated;
grant execute on function public.submit_examwatch_image_assessment(uuid, text, jsonb, text, integer) to authenticated;
grant execute on function public.grade_examwatch_submission(uuid, integer) to authenticated;

insert into public.assessments (title, subject, duration_minutes, questions)
values
(
  'Online Assessment', 'Personal Development', 45,
  '[{"q":"Which of the following best describes self-concept?","o":["How you see and understand yourself","Your grades in school","What others own","Your daily schedule"]},{"q":"Which is an example of a long-term goal?","o":["Finishing today''s homework","Graduating college","Eating lunch","Sleeping early tonight"]},{"q":"Stress that motivates you to perform better is called:","o":["Distress","Burnout","Eustress","Anxiety"]}]'::jsonb
),
(
  'Online Assessment', 'General Physics', 45,
  '[{"q":"A ball is dropped from a height of 20 m. Ignoring air resistance, what is its speed just before it hits the ground?","o":["9.8 m/s","14.0 m/s","19.8 m/s","28.0 m/s"]},{"q":"What is the SI unit of force?","o":["Joule","Newton","Watt","Pascal"]},{"q":"Which law states that an object at rest stays at rest unless acted upon by a net force?","o":["Newton''s First Law","Newton''s Second Law","Newton''s Third Law","Law of Gravitation"]},{"q":"A 2 kg object accelerates at 3 m/s². What is the net force?","o":["1.5 N","5 N","6 N","9 N"]},{"q":"Which quantity has both magnitude and direction?","o":["Speed","Distance","Mass","Velocity"]}]'::jsonb
),
(
  'Online Assessment', 'Oral Communication', 45,
  '[{"q":"Which element of communication is the person who sends the message?","o":["Receiver","Speaker","Channel","Feedback"]},{"q":"Which is an example of nonverbal communication?","o":["Writing a letter","Facial expression","Reading aloud","Texting"]},{"q":"A speech meant to persuade the audience is called:","o":["Informative speech","Entertainment speech","Persuasive speech","Impromptu speech"]}]'::jsonb
),
(
  'Online Assessment', 'HOPE', 45,
  '[{"q":"What does HOPE stand for?","o":["Health Optimizing Physical Education","Home Overall Physical Exercise","Health Organized Public Education","Healthy Options for Physical Energy"]},{"q":"Which is a health-related fitness component?","o":["Agility","Cardiovascular endurance","Speed","Balance"]},{"q":"How long should a proper warm-up generally last?","o":["1 minute","5–10 minutes","45 minutes","2 hours"]}]'::jsonb
),
(
  'Online Assessment', '3 I''s', 45,
  '[{"q":"Placeholder question for 3 I''s — palitan mo ito. Pick any option.","o":["Option A","Option B","Option C","Option D"]},{"q":"Placeholder question 2 for 3 I''s — palitan mo ito.","o":["Option A","Option B","Option C","Option D"]},{"q":"Placeholder question 3 for 3 I''s — palitan mo ito.","o":["Option A","Option B","Option C","Option D"]}]'::jsonb
)
on conflict (subject, title) do nothing;

insert into public.assessment_answer_keys (assessment_id, answers)
select assessment.id, seed.answers
from (values
  ('Personal Development', '[0,1,2]'::jsonb),
  ('General Physics', '[2,1,0,2,3]'::jsonb),
  ('Oral Communication', '[1,1,2]'::jsonb),
  ('HOPE', '[0,1,1]'::jsonb),
  ('3 I''s', '[0,1,2]'::jsonb)
) as seed(subject, answers)
join public.assessments assessment
  on assessment.subject = seed.subject and assessment.title = 'Online Assessment'
on conflict (assessment_id) do nothing;
