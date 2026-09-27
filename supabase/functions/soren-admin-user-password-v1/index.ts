import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const allowedOrigin = "https://suolunpro.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Vary": "Origin",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
const normalizeEmail = (value: unknown) => String(value ?? "").trim().toLowerCase();
const validPassword = (value: unknown) => {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value).length;
  return value.length >= 8 && bytes <= 72;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return reply({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!token) return reply({ ok: false, error: "LOGIN_REQUIRED" }, 401);
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return reply({ ok: false, error: "SERVER_CONFIG" }, 500);

    const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) return reply({ ok: false, error: "LOGIN_REQUIRED" }, 401);

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: adminRow, error: adminError } = await admin
      .from("soren_admin_members_v1").select("user_id").eq("user_id", user.id).maybeSingle();
    if (adminError) return reply({ ok: false, error: "ADMIN_CHECK_FAILED" }, 500);
    if (!adminRow) return reply({ ok: false, error: "ADMIN_ONLY" }, 403);

    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = body.password;
    if (!email || !email.includes("@")) return reply({ ok: false, error: "INVALID_EMAIL" }, 400);
    if (!validPassword(password)) return reply({ ok: false, error: "INVALID_PASSWORD", min_length: 8, max_bytes: 72 }, 400);

    let target: any = null;
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return reply({ ok: false, error: "USER_LIST_UNAVAILABLE" }, 500);
      const users = data?.users ?? [];
      target = users.find((u) => normalizeEmail(u.email) === email) ?? null;
      if (target || users.length < 1000) break;
    }
    if (!target) return reply({ ok: false, error: "USER_NOT_FOUND" }, 404);

    const { error: updateError } = await admin.auth.admin.updateUserById(target.id, { password });
    if (updateError) return reply({ ok: false, error: "PASSWORD_UPDATE_FAILED", detail: updateError.message || undefined }, 400);

    const { error: auditError } = await admin.from("soren_admin_password_reset_audit_v1").insert({
      admin_user_id: user.id, target_user_id: target.id, target_email: email
    });
    if (auditError) return reply({ ok: true, email, reset: true, audit_recorded: false }, 200);
    return reply({ ok: true, email, reset: true, audit_recorded: true }, 200);
  } catch {
    return reply({ ok: false, error: "SERVER_ERROR" }, 500);
  }
});
