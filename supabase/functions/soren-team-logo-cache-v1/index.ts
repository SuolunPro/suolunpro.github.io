import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const BUCKET = "team-logos";
const PUBLIC_BASE = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/`;
const SOURCE_BASE = "https://images.fotmob.com/image_resources/logo/teamlogo/";

type Alias = { jc_team: string; fotmob_team_id: number; fotmob_team: string };
type CacheRow = { fotmob_team_id: number; cache_status: string; object_path: string | null; fetched_at: string | null };

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});

function extension(contentType: string) {
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("jpeg")) return "jpg";
  return "png";
}

async function loadAliases() {
  const { data, error } = await db.from("soren_team_alias_fotmob")
    .select("jc_team,fotmob_team_id,fotmob_team")
    .not("fotmob_team_id", "is", null)
    .order("fotmob_team_id", { ascending: true });
  if (error) throw error;
  const grouped = new Map<number, { canonicalName: string; chineseNames: Set<string> }>();
  for (const row of (data ?? []) as Alias[]) {
    const id = Number(row.fotmob_team_id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const current = grouped.get(id) ?? { canonicalName: String(row.fotmob_team || id), chineseNames: new Set<string>() };
    current.chineseNames.add(String(row.jc_team));
    if (!current.canonicalName && row.fotmob_team) current.canonicalName = String(row.fotmob_team);
    grouped.set(id, current);
  }
  return grouped;
}

async function cacheOne(id: number, canonicalName: string, chineseNames: string[]) {
  const sourceUrl = `${SOURCE_BASE}${id}.png`;
  try {
    const response = await fetch(sourceUrl, {
      headers: { accept: "image/avif,image/webp,image/png,image/*" },
      signal: AbortSignal.timeout(15_000),
    });
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!response.ok || !contentType.startsWith("image/")) {
      throw new Error(`SOURCE_${response.status}_${contentType || "unknown"}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 100 || bytes.byteLength > 1_048_576) throw new Error(`INVALID_IMAGE_SIZE_${bytes.byteLength}`);
    const objectPath = `fotmob/${id}.${extension(contentType)}`;
    const { error: uploadError } = await db.storage.from(BUCKET).upload(objectPath, bytes, {
      contentType,
      cacheControl: "2592000",
      upsert: true,
    });
    if (uploadError) throw uploadError;
    const now = new Date().toISOString();
    const { error: upsertError } = await db.from("soren_team_logo_cache").upsert({
      fotmob_team_id: id,
      source: "fotmob",
      canonical_name: canonicalName,
      chinese_names: chineseNames,
      bucket_id: BUCKET,
      object_path: objectPath,
      mime_type: contentType,
      byte_size: bytes.byteLength,
      etag: response.headers.get("etag"),
      cache_status: "cached",
      source_url: sourceUrl,
      last_error: null,
      fetched_at: now,
      updated_at: now,
    }, { onConflict: "fotmob_team_id" });
    if (upsertError) throw upsertError;
    return { id, status: "cached", objectPath, publicUrl: PUBLIC_BASE + objectPath, bytes: bytes.byteLength };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    await db.from("soren_team_logo_cache").upsert({
      fotmob_team_id: id,
      source: "fotmob",
      canonical_name: canonicalName,
      chinese_names: chineseNames,
      bucket_id: BUCKET,
      cache_status: message.includes("SOURCE_404") ? "missing" : "error",
      source_url: sourceUrl,
      last_error: message,
      updated_at: new Date().toISOString(),
    }, { onConflict: "fotmob_team_id" });
    return { id, status: "error", error: message };
  }
}

async function status() {
  const aliases = await loadAliases();
  const { data, error } = await db.from("soren_team_logo_cache")
    .select("fotmob_team_id,cache_status,object_path,fetched_at,byte_size");
  if (error) throw error;
  const rows = data ?? [];
  return {
    aliases: aliases.size,
    rows: rows.length,
    cached: rows.filter((x) => x.cache_status === "cached" && x.object_path).length,
    missing: rows.filter((x) => x.cache_status === "missing").length,
    error: rows.filter((x) => x.cache_status === "error").length,
    bytes: rows.reduce((sum, x) => sum + Number(x.byte_size || 0), 0),
  };
}

async function sync(limit = 120, force = false) {
  const aliases = await loadAliases();
  const { data, error } = await db.from("soren_team_logo_cache")
    .select("fotmob_team_id,cache_status,object_path,fetched_at");
  if (error) throw error;
  const cache = new Map<number, CacheRow>((data ?? []).map((x) => [Number(x.fotmob_team_id), x as CacheRow]));
  const staleBefore = Date.now() - 30 * 86400_000;
  const targets = [...aliases.entries()].filter(([id]) => {
    const row = cache.get(id);
    if (force || !row || row.cache_status !== "cached" || !row.object_path) return true;
    return !row.fetched_at || Date.parse(row.fetched_at) < staleBefore;
  }).slice(0, Math.max(1, Math.min(500, limit)));

  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20);
    results.push(...await Promise.all(batch.map(([id, team]) =>
      cacheOne(id, team.canonicalName, [...team.chineseNames].sort())
    )));
  }
  return {
    eligible: aliases.size,
    requested: targets.length,
    cached: results.filter((x) => x.status === "cached").length,
    failed: results.filter((x) => x.status !== "cached").length,
    remainingEstimate: Math.max(0, [...aliases.keys()].filter((id) => !cache.has(id)).length - targets.length),
    results,
    status: await status(),
  };
}

Deno.serve(async (req) => {
  try {
    if (!['GET', 'POST'].includes(req.method)) return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try { body = await req.json(); } catch { body = {}; }
    }
    const mode = String(body.mode || url.searchParams.get("mode") || "status");
    if (mode === "status") return json({ ok: true, mode, result: await status(), at: new Date().toISOString() });
    if (mode !== "sync") return json({ ok: false, error: "INVALID_MODE" }, 400);
    const limit = Number(body.limit || url.searchParams.get("limit") || 120);
    const force = body.force === true || url.searchParams.get("force") === "1";
    return json({ ok: true, mode, result: await sync(limit, force), at: new Date().toISOString() });
  } catch (error) {
    console.error(error);
    return json({ ok: false, error: String(error instanceof Error ? error.message : error) }, 500);
  }
});
