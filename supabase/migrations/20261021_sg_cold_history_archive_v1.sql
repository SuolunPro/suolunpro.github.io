create table if not exists ninety_core.soren_cold_history_import_v1 (
  pool_date date not null,
  match_no text not null,
  source_record jsonb not null,
  result_record jsonb,
  imported_at timestamptz not null default now(),
  primary key(pool_date,match_no)
);
alter table ninety_core.soren_cold_history_import_v1 enable row level security;
grant select on ninety_core.soren_cold_history_import_v1 to service_role;
comment on table ninety_core.soren_cold_history_import_v1 is
  'Read-only customer archive of source-verified old Soren prematch directional cold warnings; no result-based prediction generation.';