-- Singapore result self-healing, 2026-10-21.
-- Existing jobs: FotMob FT at :00/:10; dual-source verifier at :02,
-- halftime event at :04, module settlement at :06, HJ38 at :07.
select cron.alter_job(15, schedule := '2,12,22,32,42,52 * * * *');
select cron.alter_job(21, schedule := '4,14,24,34,44,54 * * * *');
select cron.alter_job(45, schedule := '6,16,26,36,46,56 * * * *');
select cron.alter_job(26, schedule := '7,17,27,37,47,57 * * * *');
-- Jobs 65-67 replay the three-day window at 12:25, 12:28, 12:31 Beijing.
-- Commands are copied from existing Vault-backed jobs and append lookback_days=3.
select cron.schedule('ninety-results-selfheal-3day-fotmob','25 4 * * *',
  replace((select command from cron.job where jobid=49),'/functions/v1/ninety-fotmob-results-v1',
    '/functions/v1/ninety-fotmob-results-v1?lookback_days=3'));
select cron.schedule('ninety-results-selfheal-3day-verifier','28 4 * * *',
  replace((select command from cron.job where jobid=15),'/functions/v1/ninety-result-verifier-v1',
    '/functions/v1/ninety-result-verifier-v1?lookback_days=3'));
select cron.schedule('ninety-results-selfheal-3day-halftime','31 4 * * *',
  replace((select command from cron.job where jobid=21),'/functions/v1/ninety-halftime-result-v1',
    '/functions/v1/ninety-halftime-result-v1?lookback_days=3'));
-- Verified alias variants inherited from the existing independent FotMob map:
insert into ninety_core.hao_team_alias_fotmob_v01
  (league_cn,jc_team,fotmob_team_id,fotmob_team,evidence_n,confidence,updated_at)
select league_cn,'FC东京',fotmob_team_id,fotmob_team,evidence_n,
  'verified_existing_alias_variant',now()
from ninety_core.hao_team_alias_fotmob_v01
where jc_team='东京FC' and fotmob_team_id=4399 and fotmob_team='FC Tokyo'
on conflict do nothing;
insert into ninety_core.hao_team_alias_fotmob_v01
  (league_cn,jc_team,fotmob_team_id,fotmob_team,evidence_n,confidence,updated_at)
select league_cn,'RB大宫松鼠',fotmob_team_id,fotmob_team,evidence_n,
  'verified_existing_alias_variant',now()
from ninety_core.hao_team_alias_fotmob_v01
where jc_team='大宫松鼠' and fotmob_team_id=4398 and fotmob_team='RB Omiya Ardija'
on conflict do nothing;
