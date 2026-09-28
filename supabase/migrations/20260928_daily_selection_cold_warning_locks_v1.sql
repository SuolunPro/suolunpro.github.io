create table if not exists public.soren_daily_selection_locks_v1 (
  pool_date date not null,
  match_no text not null check (match_no ~ '^[0-9]{3}$'),
  lock_type text not null,
  source text not null,
  locked_at timestamptz not null default now(),
  source_payload jsonb not null default '{}'::jsonb,
  primary key (pool_date, match_no, lock_type)
);

comment on table public.soren_daily_selection_locks_v1 is
'One-way customer publication locks for 今日优选. A published VIP cold warning can permanently exclude the match from that pool date without mutating the frozen prediction snapshot.';

alter table public.soren_daily_selection_locks_v1 enable row level security;

revoke all on table public.soren_daily_selection_locks_v1 from anon, authenticated;
grant select, insert, update, delete on table public.soren_daily_selection_locks_v1 to service_role;

create index if not exists soren_daily_selection_locks_v1_date_type_idx
  on public.soren_daily_selection_locks_v1(pool_date, lock_type);
