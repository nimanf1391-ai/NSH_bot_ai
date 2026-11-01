import { createClient } from "npm:@supabase/supabase-js@2";

const URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OWNER_PHONE = (Deno.env.get("OWNER_PHONE") ?? "").replace(/[^\d+]/g, "");
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "";
const db = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-session-token, x-client-info, apikey, content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const now = () => new Date().toISOString();
const normalizePhone = (v: unknown) => String(v ?? "").replace(/[^\d+]/g, "");
const validPhone = (p: string) => /^\+[1-9]\d{7,14}$/.test(p);

// Atomic rate limits are stored in Postgres; client-supplied IP headers are not trusted.
async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const { data, error } = await db.rpc("nsh_rate_limit", {
    p_rate_key: await sha(key),
    p_action: "login",
    p_max_attempts: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) throw error;
  return data === true;
}
function requestIp(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return req.headers.get("cf-connecting-ip")?.trim() || forwarded || "";
}

async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function secureCode(): string {
  let out = "";
  const bytes = new Uint8Array(32);
  while (out.length < 6) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 250) out += String(b % 10);
      if (out.length === 6) break;
    }
  }
  return out;
}
function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function getSessionUser(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = req.headers.get("x-session-token")?.trim() || auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const tokenHash = await sha(token);
  const { data: session, error: se } = await db.from("nsh_sessions")
    .select("user_id,expires_at").eq("token_hash", tokenHash)
    .gt("expires_at", now()).maybeSingle();
  if (se || !session) return null;
  const { data: user, error: ue } = await db.from("nsh_users")
    .select("id,phone,status,role").eq("id", session.user_id).maybeSingle();
  if (ue || !user || user.status !== "active") return null;
  return user;
}
async function requireOwner(req: Request) {
  const user = await getSessionUser(req);
  return user?.role === "owner" ? user : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    if (!URL || !SERVICE_KEY || !OWNER_PHONE) {
      return json({ success: false, error: "Server secrets are not configured" }, 500);
    }
    const body = await req.json();
    const action = String(body.action ?? "");
    const phone = normalizePhone(body.phone);

    if (action === "request") {
      if (!validPhone(phone)) return json({ success: false, error: "شماره موبایل معتبر نیست." }, 400);
      const ip = requestIp(req);
      const phoneAllowed = await rateLimit(`request:phone:${phone}`, 3, 3600);
      const ipAllowed = ip ? await rateLimit(`request:ip:${ip}`, 10, 3600) : true;
      if (!phoneAllowed || !ipAllowed) {
        return json({ success: false, error: "تعداد درخواست‌ها زیاد است؛ یک ساعت دیگر دوباره تلاش کنید." }, 429);
      }
      const { data: pending, error: pe } = await db.from("login_requests")
        .select("id").eq("phone", phone).eq("status", "pending")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (pe) throw pe;
      if (pending) return json({ success: true, request_id: pending.id, status: "pending" });
      const { data, error } = await db.from("login_requests")
        .insert({ phone, status: "pending" }).select("id,phone,status,created_at").single();
      if (error) throw error;
      return json({ success: true, request: data });
    }

    if (action === "verify") {
      if (!validPhone(phone) || !/^\d{6}$/.test(String(body.code ?? ""))) {
        return json({ success: false, error: "شماره یا کد نامعتبر است." }, 400);
      }
      const ip = requestIp(req);
      const phoneAllowed = await rateLimit(`verify:phone:${phone}`, 5, 900);
      const ipAllowed = ip ? await rateLimit(`verify:ip:${ip}`, 20, 900) : true;
      if (!phoneAllowed || !ipAllowed) {
        return json({ success: false, error: "تلاش‌های ورود بیش از حد مجاز است؛ ۱۵ دقیقه دیگر دوباره امتحان کنید." }, 429);
      }
      const { data: row, error: findError } = await db.from("login_codes")
        .select("id,expires_at").eq("phone", phone).eq("code_hash", await sha(String(body.code)))
        .is("used_at", null).gt("expires_at", now())
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (findError) throw findError;
      if (!row) return json({ success: false, error: "کد نادرست، استفاده‌شده یا منقضی است." }, 401);
      const { data: consumed, error: consumeError } = await db.from("login_codes")
        .update({ used_at: now() }).eq("id", row.id).is("used_at", null).select("id").maybeSingle();
      if (consumeError) throw consumeError;
      if (!consumed) return json({ success: false, error: "این کد قبلاً استفاده شده است." }, 409);

      const ownerLogin = phone === OWNER_PHONE;
      const { data: found, error: lookupError } = await db.from("nsh_users")
        .select("id,phone,status,role").eq("phone", phone).maybeSingle();
      if (lookupError) throw lookupError;
      let user = found;
      if (!user) {
        const { data, error } = await db.from("nsh_users").insert({
          phone, status: "active", role: ownerLogin ? "owner" : "user",
        }).select("id,phone,status,role").single();
        if (error) throw error;
        user = data;
      } else {
        if (user.status !== "active") return json({ success: false, error: "حساب کاربری غیرفعال است." }, 403);
        if (ownerLogin && user.role !== "owner") {
          const { data, error } = await db.from("nsh_users").update({ role: "owner" })
            .eq("id", user.id).select("id,phone,status,role").single();
          if (error) throw error;
          user = data;
        }
      }
      const token = secureToken();
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      const { error: sessionError } = await db.from("nsh_sessions").insert({
        user_id: user.id, token_hash: await sha(token), expires_at: expiresAt,
      });
      if (sessionError) throw sessionError;
      const { error: syncError } = await db.from("nsh_user_sync").upsert(
        { user_id: user.id }, { onConflict: "user_id", ignoreDuplicates: true },
      );
      if (syncError) throw syncError;
      return json({ success: true, session_token: token, expires_at: expiresAt,
        user: { id: user.id, phone: user.phone, role: user.role } });
    }

    if (action === "session_me") {
      const user = await getSessionUser(req);
      if (!user) return json({ success: false, error: "نشست معتبر نیست؛ دوباره وارد شوید." }, 401);
      return json({ success: true, user, role: user.role });
    }

    if (action === "logout") {
      const token = (req.headers.get("x-session-token") ?? "").trim();
      if (token) await db.from("nsh_sessions").delete().eq("token_hash", await sha(token));
      return json({ success: true });
    }

    if (action === "sync_get" || action === "sync_save") {
      const user = await getSessionUser(req);
      if (!user) return json({ success: false, error: "نشست معتبر نیست؛ دوباره وارد شوید." }, 401);
      if (action === "sync_get") {
        const { data, error } = await db.from("nsh_user_sync")
          .select("data_json,updated_at").eq("user_id", user.id).maybeSingle();
        if (error) throw error;
        return json({ success: true, data: data?.data_json ?? {}, updated_at: data?.updated_at ?? null });
      }
      if (!body.data || typeof body.data !== "object" || Array.isArray(body.data)) {
        return json({ success: false, error: "داده نامعتبر است." }, 400);
      }
      const { error } = await db.from("nsh_user_sync").upsert({
        user_id: user.id, data_json: body.data, updated_at: now(),
      }, { onConflict: "user_id" });
      if (error) throw error;
      return json({ success: true });
    }

    if (["admin_list_requests", "admin_list_users", "issue", "admin_set_user_status", "admin_reject"].includes(action)) {
      const owner = await requireOwner(req);
      // Bootstrap fallback: only Supabase Dashboard Test may use ADMIN_SECRET
      // to issue the very first/recovery code for OWNER_PHONE. Never put this secret in the website.
      const bootstrapOwnerIssue = action === "issue" && phone === OWNER_PHONE &&
        !!ADMIN_SECRET && req.headers.get("x-admin-secret") === ADMIN_SECRET;
      if (!owner && !bootstrapOwnerIssue) {
        return json({ success: false, error: "دسترسی فقط برای مالک مجاز است." }, 403);
      }

      if (action === "admin_list_requests") {
        const { data, error } = await db.from("login_requests")
          .select("id,phone,status,created_at,processed_at")
          .order("created_at", { ascending: false }).limit(200);
        if (error) throw error;
        return json({ success: true, requests: data ?? [] });
      }
      if (action === "admin_list_users") {
        const { data, error } = await db.from("nsh_users")
          .select("id,phone,status,role,created_at")
          .order("created_at", { ascending: false }).limit(500);
        if (error) throw error;
        return json({ success: true, users: data ?? [] });
      }
      if (action === "issue") {
        if (!validPhone(phone)) return json({ success: false, error: "شماره موبایل معتبر نیست." }, 400);
        const { data: pending, error: pe } = await db.from("login_requests")
          .select("id").eq("phone", phone).eq("status", "pending")
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (pe) throw pe;
        if (!pending) return json({ success: false, error: "درخواست در انتظار برای این شماره پیدا نشد." }, 404);
        const code = secureCode();
        const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
        const { error: insertError } = await db.from("login_codes").insert({
          phone, code_hash: await sha(code), expires_at: expiresAt, used_at: null,
        });
        if (insertError) throw insertError;
        const { error: updateError } = await db.from("login_requests").update({
          status: "approved", processed_at: now(),
        }).eq("id", pending.id);
        if (updateError) throw updateError;
        return json({ success: true, phone, code, expires_at: expiresAt });
      }
      if (action === "admin_reject") {
        if (!validPhone(phone)) return json({ success: false, error: "شماره معتبر نیست." }, 400);
        const { data, error } = await db.from("login_requests").update({
          status: "rejected", processed_at: now(),
        }).eq("phone", phone).eq("status", "pending").select("id");
        if (error) throw error;
        return json({ success: true, updated: data?.length ?? 0 });
      }
      if (action === "admin_set_user_status") {
        const userId = String(body.user_id ?? "");
        const status = String(body.status ?? "");
        if (!userId || !["active", "disabled"].includes(status)) {
          return json({ success: false, error: "اطلاعات کاربر نامعتبر است." }, 400);
        }
        const { data: target, error: targetError } = await db.from("nsh_users")
          .select("id,role").eq("id", userId).maybeSingle();
        if (targetError) throw targetError;
        if (!target || target.role === "owner") {
          return json({ success: false, error: "حساب مالک قابل تغییر نیست." }, 403);
        }
        const { error } = await db.from("nsh_users").update({ status }).eq("id", userId);
        if (error) throw error;
        return json({ success: true });
      }
    }

    return json({ success: false, error: "عملیات ناشناخته است." }, 400);
  } catch (error) {
    console.error("login-code error:", error);
    return json({ success: false, error: "خطای سرور؛ تنظیمات و جدول‌ها را بررسی کنید." }, 500);
  }
});
