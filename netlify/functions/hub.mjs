// SFM Client Hub API: login, logout, me, refresh, invite, invite-check, set-password, setup
import {
  stores, seedTestData, importClients, checkPassword, hashPassword, makeSession, clearSession, readSession,
  recordLogin, recentLogins, refreshAll, refreshOne, isStale, isProd, createInvite, readInvite, useInvite,
  validEmail, passwordProblem, listUsers, OWNER_EMAIL, setupKeyOk, INVITE_DAYS,
} from "../hub-core.mjs";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const sameOrigin = (req) => {
  const o = req.headers.get("origin");
  return !o || o === new URL(req.url).origin;
};
const body = async (req) => { try { return await req.json(); } catch { return {}; } };

async function locked(s, key) {
  const lock = (await s.config.get(key, { type: "json" })) || { n: 0, until: 0 };
  return lock;
}
async function fail(s, key, lock) {
  lock.n += 1;
  if (lock.n >= 5) { lock.until = Date.now() + 15 * 60e3; lock.n = 0; }
  await s.config.setJSON(key, lock);
}

export default async (req, context) => {
  const s = stores(context);
  const origin = new URL(req.url).origin;
  await seedTestData(s, context);
  await importClients(s, origin);
  const action = context.params.action;
  const post = req.method === "POST";

  if (action === "login" && post) {
    if (!sameOrigin(req)) return json({ error: "Not allowed" }, 403);
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const lockKey = "lock:" + email;
    const lock = await locked(s, lockKey);
    if (lock.until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes, or ask us to reset your password." }, 429);
    const user = email && (await s.users.get(email, { type: "json" }));
    if (!user || !checkPassword(b.password || "", user)) {
      await fail(s, lockKey, lock);
      return json({ error: "That email and password don't match." }, 401);
    }
    await s.config.delete(lockKey);
    const client = user.client ? await s.clients.get(user.client, { type: "json" }) : null;
    await recordLogin(s, user, client, req);
    return json({ ok: true, role: user.role }, 200, { "set-cookie": await makeSession(s, user) });
  }

  if (action === "logout") return json({ ok: true }, 200, { "set-cookie": clearSession() });

  // Set-password link: who it's for, so the page can greet them. Says nothing else.
  if (action === "invite-check") {
    const inv = await readInvite(s, new URL(req.url).searchParams.get("t"));
    if (!inv) return json({ error: "This link has expired or was already used. Ask Jayson for a new one." }, 410);
    const c = inv.client ? await s.clients.get(inv.client, { type: "json" }) : null;
    return json({ email: inv.email, clientName: c ? c.name : "SFM team" });
  }

  if (action === "set-password" && post) {
    if (!sameOrigin(req)) return json({ error: "Not allowed" }, 403);
    const b = await body(req);
    const r = await useInvite(s, b.token, b.password);
    if (r.error) return json({ error: r.error }, 400);
    const client = r.user.client ? await s.clients.get(r.user.client, { type: "json" }) : null;
    await recordLogin(s, r.user, client, req);
    return json({ ok: true, role: r.user.role }, 200, { "set-cookie": await makeSession(s, r.user) });
  }

  // First owner login on the live site. Needs HUB_SETUP_KEY in Netlify; off when it's not set.
  if (action === "setup" && post) {
    if (!sameOrigin(req)) return json({ error: "Not allowed" }, 403);
    if (!process.env.HUB_SETUP_KEY) return json({ error: "Setup is turned off." }, 403);
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    const lockKey = "lock:setup";
    const lock = await locked(s, lockKey);
    if (lock.until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes." }, 429);
    if (email !== OWNER_EMAIL || !setupKeyOk(b.key)) {
      await fail(s, lockKey, lock);
      return json({ error: "That email and setup key don't match." }, 401);
    }
    const bad = passwordProblem(b.password);
    if (bad) return json({ error: bad }, 400);
    const user = { email, role: "admin", ...hashPassword(b.password), passwordSetAt: new Date().toISOString() };
    await s.users.setJSON(email, user);
    await s.config.delete(lockKey);
    await recordLogin(s, user, null, req);
    return json({ ok: true, role: "admin" }, 200, { "set-cookie": await makeSession(s, user) });
  }

  const me = await readSession(s, req);
  if (!me) return json({ error: "Please log in." }, 401);

  if (action === "me") {
    if (me.role === "admin") {
      const { blobs } = await s.clients.list();
      const users = await listUsers(s);
      const clients = await Promise.all(blobs.map(async (b) => {
        const c = await s.clients.get(b.key, { type: "json" });
        return {
          slug: b.key, name: c.name, sample: !!c.sample, refreshedAt: c.refreshedAt, refreshError: c.refreshError || "",
          connected: !!(c.sample || (c.meta && c.meta.pageId)), noteUpdated: (c.note && c.note.updated) || "",
          logins: users.filter((u) => u.client === b.key).map((u) => u.email),
        };
      }));
      clients.sort((a, b) => (a.sample - b.sample) || a.name.localeCompare(b.name));
      const team = users.filter((u) => u.role === "admin").map((u) => u.email);
      return json({ role: "admin", email: me.email, test: !isProd(context), clients, team, logins: await recentLogins(s) });
    }
    const c = await s.clients.get(me.client, { type: "json" });
    if (!c) return json({ error: "Your hub isn't set up yet." }, 404);
    if (isStale(c)) await refreshOne(s, me.client, c);
    const { lo, hi, meta, importedFrom, importedAt, triedAt, refreshError, ...pub } = c;
    pub.kpis = (c.kpis || []).map(({ lo, hi, ...k }) => k);
    return json({ role: "client", email: me.email, test: !isProd(context), client: pub });
  }

  if (me.role !== "admin") return json({ error: "Not allowed" }, 403);

  if (action === "refresh" && post) {
    return json({ ok: true, results: await refreshAll(s) });
  }

  // Makes a one-time set-password link. Nothing is emailed; the link is shown to the SFM team member.
  if (action === "invite" && post) {
    if (!sameOrigin(req)) return json({ error: "Not allowed" }, 403);
    const b = await body(req);
    const email = String(b.email || "").trim().toLowerCase();
    if (!validEmail(email)) return json({ error: "Enter a real email address." }, 400);
    let role = "client", client = String(b.client || "");
    if (client === "__team") { role = "admin"; client = ""; }
    else if (!client || !(await s.clients.get(client))) return json({ error: "Pick a client." }, 400);
    const existing = await s.users.get(email, { type: "json" });
    if (existing && (existing.role !== role || (existing.client || "") !== client)) {
      return json({ error: "That email already logs in to a different hub." }, 409);
    }
    const { token, exp } = await createInvite(s, { email, role, client, by: me.email });
    return json({ ok: true, link: origin + "/client-login/set-password/?t=" + token, expires: new Date(exp).toISOString(), days: INVITE_DAYS, reset: !!existing });
  }

  return json({ error: "Not found" }, 404);
};

export const config = { path: "/api/hub/:action" };
