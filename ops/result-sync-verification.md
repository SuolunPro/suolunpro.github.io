# Result sync verification

Production project: `ttydbcejxqxdkcfoizkj`

- Collector: `soren-core-collector-v1` v5
- Public API: `soren-public-api-v1` v17
- Cron: `soren_results_settlement_v1`, every 10 minutes
- Result acceptance: exact upstream match ID, exact canonical home/away teams, finished state, valid non-negative integer score
- Prediction discipline: result sync writes only `soren_results` and `soren_settlements`; it does not regenerate or alter `soren_predictions`

Initial production replay at 2026-09-21 09:24 UTC checked 240 matches, verified 102 finished matches, inserted or changed 31 results, and settled runs 20, 21, 22, 23, and 28.

Acceptance match:

- Match ID 4458 / prediction ID 382
- China Women 5-1 Philippines Women
- FT result H, handicap result HWIN
- Top1 hit: true
- Handicap hit: true
