-- Internal provenance ledger; only service role should read or write.
alter table ninety_core.soren_daily_selection_history_rebuild_v1 enable row level security;
