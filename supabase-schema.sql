create table if not exists public.responses (
  question_id text not null,
  question_text text not null,
  option_index integer not null check (option_index >= 0),
  option_text text not null,
  respondent_id uuid not null,
  submitted_at timestamptz not null default now(),
  primary key (question_id, respondent_id)
);

alter table public.responses enable row level security;

create table if not exists public.form_submissions (
  respondent_id uuid primary key,
  name text not null,
  surname text not null,
  phone text not null check (phone ~ '^[0-9]{8}$'),
  email text not null,
  certificate_of_attendance boolean not null,
  topic text not null,
  topic_other text,
  submitted_at timestamptz not null default now(),
  check ((topic = 'غيره، حدد:' and topic_other is not null and length(trim(topic_other)) > 0)
      or (topic <> 'غيره، حدد:' and topic_other is null))
);

alter table public.form_submissions enable row level security;
