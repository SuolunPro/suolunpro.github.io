-- Applied to zssourkgabcxibggwhqm on 2026-11-20.
-- Match-level audit trail for retries after kickoff + 120 minutes.
create table if not exists ninety_core.engine4_result_attempts (
 sale_day date not null,
 match_no text not null,
 fotmob_match_id bigint,
 status text not null,
 detail jsonb not null default '{}'::jsonb,
 attempts integer not null default 0,
 first_checked_at timestamptz not null default now(),
 last_checked_at timestamptz not null default now(),
 primary key (sale_day, match_no)
);
alter table ninety_core.engine4_result_attempts enable row level security;
revoke all on ninety_core.engine4_result_attempts from anon, authenticated;
grant select, insert, update on ninety_core.engine4_result_attempts to service_role;
