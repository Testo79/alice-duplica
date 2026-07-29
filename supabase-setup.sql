-- Run once in Supabase: SQL Editor → New query → paste → Run

create table if not exists ionos_sessions (
  id text primary key,
  data jsonb not null,
  updated_at bigint not null
);

create index if not exists ionos_sessions_updated_at_idx on ionos_sessions (updated_at desc);

alter table ionos_sessions enable row level security;

-- No public policies: only server uses service_role key (bypasses RLS)
