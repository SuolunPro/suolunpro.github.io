# Official fixtures/SP ingestion: phase 1

The module `official_ingest.py` validates an **externally supplied** JSON capture containing official match IDs, sale-end timestamps, handicap and both sets of SP odds. It does not fetch data or certify that the source is genuinely official.

Usage: `python haozhi-ai/collectors/official_ingest.py /path/to/capture.json`

The capture must include a source URL and retrieval time; successful validation means only that the data is structurally usable, **not** that it has been independently verified against China Sports Lottery. An empty fixtures array is not proof that there are no games.

Next: build and verify an actual data retrieval adapter, independent source cross-check, full-pool reconciliation and immutable capture archival. Never invent fixtures, odds or timestamps. Do not run collectors against the old Supabase production databases.
