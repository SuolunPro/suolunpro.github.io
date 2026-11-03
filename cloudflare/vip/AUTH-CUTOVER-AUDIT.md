# Cloudflare VIP cutover — verified auth boundary (staging audit)

Audit date: 2026-11-03. No production deployment.

## Confirmed legacy function
- Project: ttydbcejxqxdkcfoizkj (old Suolun only).
- Function: `soren-public-api-v1`, observed active version **248**, `verify_jwt=false`.
- It manually extracts `Authorization: Bearer ...` and calls the legacy Supabase `/auth/v1/user` endpoint. Cloudflare VIP tokens are **not** accepted.
- `view=membership` returns the membership object *after* this Supabase user check.
- `vipAccessStatus(userId)` queries `soren_vip_members_v1`, so the old Supabase membership row remains the authoritative VIP check for this function.
- Client `membershipFetch()` calls `soren-public-api-v1?view=membership` via `authorizedApiFetch`; it cannot simply be pointed at Cloudflare `/auth/me` without mapping fields and reworking other protected requests.

## Security and cutover gates
1. Never accept client-supplied `user_id`, email or `vipActive` as proof of authorization.
2. Add a server-to-server VIP verification route that validates Cloudflare session signature, expiry, and current D1 member status; keep shared secrets out of frontend code.
3. Legacy function must distinguish Cloudflare vs Supabase tokens and verify both securely during transition. Do **not** pass Cloudflare token to Supabase `/auth/v1/user` and assume success.
4. Replace the legacy membership lookup for Cloudflare-authenticated sessions with an authoritative D1 result. For any remaining protected functions, audit their token checks independently.
5. Verify VIP and expired/revoked users, cross-origin behavior, all seven football modules, and rollback before modifying production `index.html`.
6. Do not touch Singapore Supabase project or existing `football-ai` Worker.

## Current state
Staging auth adapter and isolated test page exist on this branch. This audit documents the confirmed blocker; **the authorization bridge is not yet implemented or deployed**.
