-- Recheck existing Singapore prematch publications without rewriting their publication time.
-- This is a visibility restoration ledger, not a claim of an original Soren publication.
create table if not exists ninety_core.soren_daily_selection_history_rebuild_v1 (
  pool_date date not null,
  match_no text not null check (match_no ~ '^[0-9]{3}$'),
  publication_origin text not null,
  source_model_run_id bigint not null,
  source_model_frozen_at timestamptz not null,
  original_published_at timestamptz not null,
  reconstructed_at timestamptz not null default now(),
  historical_rebuild boolean not null default true check (historical_rebuild),
  rebuild_kind text not null check (rebuild_kind = 'VERIFIED_PUBLICATION_VISIBILITY_RECHECK'),
  evidence jsonb not null,
  primary key (pool_date,match_no)
);
insert into ninety_core.soren_daily_selection_history_rebuild_v1
  (pool_date,match_no,publication_origin,source_model_run_id,source_model_frozen_at,
   original_published_at,rebuild_kind,evidence)
select p.pool_date,p.match_no,p.publication_origin,h.run_id,h.frozen_at,
  p.published_at,'VERIFIED_PUBLICATION_VISIBILITY_RECHECK',
  jsonb_build_object(
    'source_project','zssourkgabcxibggwhqm',
    'source_prediction_id',h.id,
    'source_publication_table','ninety_core.soren_daily_selection_publications_v1',
    'selector_version',p.selector_version,
    'original_published_at',p.published_at,
    'publication_evidence',p.evidence,
    'historical_rebuild',true,
    'rebuild_scope','read_visibility_of_existing_prematch_publication')
from ninety_core.soren_daily_selection_publications_v1 p
join ninety_core.soren_matches m on m.id=p.match_id and m.pool_date=p.pool_date and m.match_no=p.match_no
join ninety_core.hao_console_predictions h
  on h.pool_date=p.pool_date and h.match_no=p.match_no and h.run_id=p.hj38_model_run_id
join ninety_core.hao_console_model_runs r on r.id=h.run_id
where p.pool_date between date '2026-10-21' and (now() at time zone 'Asia/Shanghai')::date-1
  and p.publication_origin='SG_FORMAL_HJ38_ADAPTED'
  and p.evidence->>'fullOriginalVipGateVerified'='true'
  and h.model_version='3.8' and r.formal_allowed=true and r.data_complete=true
  and h.home_team=m.home_team and h.away_team=m.away_team
  and h.kickoff_bjt=m.kickoff_at and h.frozen_at=p.model_frozen_at
  and (case h.top1 when '主胜' then 'H' when '平' then 'D' when '客胜' then 'A' end)=p.model_top1
  and h.frozen_at<p.published_at
  and p.published_at<least(m.kickoff_at,coalesce(m.cutoff_at,'infinity'::timestamptz),
    ((p.pool_date+case when extract(isodow from p.pool_date) in (6,7)
      then time '23:00' else time '22:00' end) at time zone 'Asia/Shanghai'))
  and not exists (
    select 1 from ninety_core.soren_daily_selection_locks_v1 l
    where l.pool_date=p.pool_date and l.match_no=p.match_no)
on conflict (pool_date,match_no) do nothing;
