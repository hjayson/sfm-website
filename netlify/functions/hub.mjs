// SFM Client Hub API: /api/hub/login, /api/hub/logout, /api/hub/me, /api/hub/refresh
import { stores, seedTestData, checkPassword, makeSession, clearSession, readSession, recordLogin, recentLogins, refreshAll, refreshOne, isStale, isProd } from "../hub-core.mjs";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

export default async (req, context) => {
  const s = stores(context);
  await seedTestData(s, context);
  const action = context.params.action;

  if (action === "login" && req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== new URL(req.url).origin) return json({ error: "Not allowed" }, 403);
    let body = {};
    try { body = await req.json(); } catch {}
    const email = String(body.email || "").trim().toLowerCase();
    const lockKey = "lock:" + email;
    const lock = (await s.config.get(lockKey, { type: "json" })) || { n: 0, until: 0 };
    if (lock.until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes, or ask us to reset your password." }, 429);
    const user = email && (await s.users.get(email, { type: "json" }));
    if (!user || !checkPassword(body.password || "", user)) {
      lock.n += 1;
      if (lock.n >= 5) { lock.until = Date.now() + 15 * 60e3; lock.n = 0; }
      await s.config.setJSON(lockKey, lock);
      return json({ error: "That email and password don't match." }, 401);
    }
    await s.config.delete(lockKey);
    const client = user.client ? await s.clients.get(user.client, { type: "json" }) : null;
    await recordLogin(s, user, client, req);
    return json({ ok: true, role: user.role }, 200, { "set-cookie": await makeSession(s, user) });
  }

  if (action === "logout") return json({ ok: true }, 200, { "set-cookie": clearSession() });

  const me = await readSession(s, req);
  if (!me) return json({ error: "Please log in." }, 401);

  if (action === "me") {
    if (me.role === "admin") {
      const { blobs } = await s.clients.list();
      const clients = await Promise.all(blobs.map(async (b) => {
        const c = await s.clients.get(b.key, { type: "json" });
        return { slug: b.key, name: c.name, refreshedAt: c.refreshedAt, refreshError: c.refreshError || "" };
      }));
      return json({ role: "admin", email: me.email, test: !isProd(context), clients, logins: await recentLogins(s) });
    }
    const c = await s.clients.get(me.client, { type: "json" });
    if (!c) return json({ error: "Your hub isn't set up yet." }, 404);
    if (isStale(c)) await refreshOne(s, me.client, c);
    const { lo, hi, meta, ...pub } = c;
    pub.kpis = (c.kpis || []).map(({ lo, hi, ...k }) => k);
    return json({ role: "client", email: me.email, test: !isProd(context), client: pub });
  }

  if (action === "refresh" && req.method === "POST") {
    if (me.role !== "admin") return json({ error: "Not allowed" }, 403);
    return json({ ok: true, results: await refreshAll(s) });
  }

  return json({ error: "Not found" }, 404);
};

export const config = { path: "/api/hub/:action" };
