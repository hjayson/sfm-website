// SFM Client Hub: shared logic for the login, the hub data and the daily refresh.
// Client data lives in Netlify Blobs, never in this public repo.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const COOKIE = "sfm_hub";
const SESSION_DAYS = 30;

// Production and test copies use separate stores, so test logins never touch real data.
export function isProd(context) {
  return (context && context.deploy && context.deploy.context) === "production";
}
export function stores(context) {
  const ns = isProd(context) ? "client-hub" : "client-hub-test";
  return {
    users: getStore({ name: ns + "-users", consistency: "strong" }),
    clients: getStore({ name: ns + "-clients", consistency: "strong" }),
    logins: getStore({ name: ns + "-logins", consistency: "strong" }),
    config: getStore({ name: ns + "-config", consistency: "strong" }),
  };
}

/* ---------- passwords ---------- */
export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString("hex");
  return { salt, hash };
}
export function checkPassword(pw, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const h = crypto.scryptSync(String(pw), rec.salt, 64);
  const want = Buffer.from(rec.hash, "hex");
  return want.length === h.length && crypto.timingSafeEqual(h, want);
}

/* ---------- sessions (signed cookie) ---------- */
async function secret(s) {
  if (process.env.HUB_SESSION_SECRET) return process.env.HUB_SESSION_SECRET;
  let v = await s.config.get("session-secret");
  if (!v) { v = crypto.randomBytes(32).toString("hex"); await s.config.set("session-secret", v); }
  return v;
}
const b64u = (b) => Buffer.from(b).toString("base64url");
export async function makeSession(s, user) {
  const body = b64u(JSON.stringify({ e: user.email, r: user.role, c: user.client || null, x: Date.now() + SESSION_DAYS * 864e5 }));
  const sig = crypto.createHmac("sha256", await secret(s)).update(body).digest("base64url");
  return COOKIE + "=" + body + "." + sig + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400;
}
export const clearSession = () => COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
export async function readSession(s, req) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", await secret(s)).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString());
  if (!p.x || p.x < Date.now()) return null;
  return { email: p.e, role: p.r, client: p.c };
}

/* ---------- login alerts ---------- */
export async function recordLogin(s, user, client, req) {
  const at = new Date().toISOString();
  const key = at + "-" + crypto.randomBytes(3).toString("hex");
  await s.logins.setJSON(key, { at, email: user.email, client: user.client, clientName: client ? client.name : "", device: deviceOf(req) });
  // Email alert: a Netlify Forms submission, which emails whoever is set up for form notifications.
  if (user.role === "client") {
    const origin = new URL(req.url).origin;
    const form = new URLSearchParams({ "form-name": "client-login-alert", client: client ? client.name : user.client, email: user.email, time: at, device: deviceOf(req) });
    try { await fetch(origin + "/client-login/", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }); } catch (e) { console.log("login alert failed", e.message); }
  }
}
function deviceOf(req) {
  const ua = req.headers.get("user-agent") || "";
  const dev = /iPhone|Android.+Mobile/.test(ua) ? "Phone" : /iPad|Tablet/.test(ua) ? "Tablet" : "Computer";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return dev + ", " + br;
}
export async function recentLogins(s, limit = 50) {
  const { blobs } = await s.logins.list();
  const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
  return Promise.all(keys.map((k) => s.logins.get(k, { type: "json" })));
}

/* ---------- daily refresh ---------- */
// Each client record may carry meta: { pageId, igId }. With META_ACCESS_TOKEN set (a system user
// token from SFM's Business Manager), numbers come from Meta. Sample clients get sample numbers.
const GRAPH = "https://graph.facebook.com/v21.0";
async function g(path, params, token) {
  const u = new URL(GRAPH + path);
  Object.entries({ ...params, access_token: token }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || "Meta " + r.status);
  return j;
}
async function pullMeta(c, token) {
  const out = { kpis: [], log: [], sourceNote: "Facebook and Instagram, pulled automatically" };
  const since = Math.floor((Date.now() - 7 * 864e5) / 1000), until = Math.floor(Date.now() / 1000);
  const page = await g("/" + c.meta.pageId, { fields: "name,followers_count,access_token" }, token);
  const pt = page.access_token || token;
  const daily = async (metric) => {
    try { const j = await g("/" + c.meta.pageId + "/insights", { metric, period: "day", since, until }, pt); return (j.data[0] && j.data[0].values.map((v) => v.value)) || []; }
    catch (e) { return []; }
  };
  const reach = await daily("page_impressions_unique");
  const eng = await daily("page_post_engagements");
  const sum = (a) => a.reduce((x, y) => x + (typeof y === "number" ? y : 0), 0);
  if (reach.length) out.kpis.push({ k: "People reached", v: sum(reach), series: reach, src: "Facebook page" });
  if (eng.length) out.kpis.push({ k: "Engagements", v: sum(eng), series: eng, src: "Facebook page" });
  out.kpis.push({ k: "Facebook followers", v: page.followers_count || 0, src: "Facebook page" });
  if (c.meta.igId) {
    const ig = await g("/" + c.meta.igId, { fields: "followers_count,media_count" }, pt);
    out.kpis.push({ k: "Instagram followers", v: ig.followers_count || 0, src: "Instagram" });
  }
  const posts = await g("/" + c.meta.pageId + "/posts", { since, until, fields: "created_time,message", limit: 20 }, pt);
  out.log = (posts.data || []).map((p) => ({ at: p.created_time, tag: "Facebook", text: "Posted: " + String(p.message || "photo or video").slice(0, 90) }));
  return out;
}
function sampleDay(c) {
  const bump = (a, lo, hi) => [...a.slice(1), Math.round(lo + Math.random() * (hi - lo))];
  const k = c.kpis.map((x) => ({ ...x }));
  for (const x of k) {
    if (x.series) {
      x.series = bump(x.series, x.lo, x.hi);
      x.v = x.series.reduce((a, b) => a + b, 0);
    }
  }
  return { kpis: k, log: c.log };
}
export async function refreshAll(s, opts = {}) {
  const { blobs } = await s.clients.list();
  const token = process.env.META_ACCESS_TOKEN;
  const done = [];
  for (const b of blobs) {
    const c = await s.clients.get(b.key, { type: "json" });
    if (!c) continue;
    try {
      let fresh = null;
      if (c.meta && c.meta.pageId && token) fresh = await pullMeta(c, token);
      else if (c.sample) fresh = sampleDay(c);
      if (fresh) Object.assign(c, fresh);
      c.refreshedAt = new Date().toISOString();
      c.refreshError = "";
    } catch (e) {
      c.refreshError = e.message; // keep yesterday's numbers on the page
    }
    await s.clients.setJSON(b.key, c);
    done.push({ client: b.key, ok: !c.refreshError, error: c.refreshError || undefined });
  }
  return done;
}

/* ---------- sample data for test copies only ---------- */
export async function seedTestData(s, context) {
  if (isProd(context)) return;
  if (await s.users.get("demo@cleanteam.example")) return;
  const demoPw = "sample-hub-2026"; // sample login for fake data on test copies only
  await s.users.setJSON("demo@cleanteam.example", { email: "demo@cleanteam.example", role: "client", client: "clean-team", ...hashPassword(demoPw) });
  await s.users.setJSON("team@sfm-test.example", { email: "team@sfm-test.example", role: "admin", ...hashPassword(demoPw) });
  await s.clients.setJSON("clean-team", {
    sample: true,
    name: "Jayson's Clean Team",
    tagline: "Social media management, Facebook ads, Google profile",
    refreshedAt: new Date().toISOString(),
    kpis: [
      { k: "People reached", v: 8412, series: [620, 710, 690, 1240, 1530, 1890, 1732], lo: 600, hi: 1900, src: "Facebook + Instagram" },
      { k: "Engagements", v: 611, series: [60, 74, 71, 88, 102, 118, 98], lo: 55, hi: 120, src: "Likes, comments, shares, saves" },
      { k: "New followers", v: 37, series: [3, 4, 6, 5, 7, 6, 6], lo: 2, hi: 8, src: "Facebook + Instagram" },
      { k: "Quote requests", v: 4, series: [0, 0, 1, 0, 1, 2, 0], lo: 0, hi: 2, src: "Facebook lead ad" },
    ],
    weekly: {
      updated: "This week",
      did: "Posted 5 times on Facebook and 4 on Instagram, including the before-and-after kitchen reel. Started the holiday deep-clean ad on Tuesday at $10 a day.",
      happened: "The kitchen reel reached 3,140 people, the best post this month. The ad brought 4 quote requests. The two text-only tips posts barely moved, so we're not repeating them.",
      changing: "More short video from real jobs and fewer text posts. We'll test a second ad photo next week to see if it lowers the cost per quote.",
    },
    log: [
      { at: "Today", tag: "Instagram", text: "Posted the window-cleaning reel" },
      { at: "Thu", tag: "Facebook", text: "Posted a holiday booking reminder" },
      { at: "Wed", tag: "Google", text: "A new 5-star review came in" },
      { at: "Tue", tag: "Ads", text: "Holiday deep-clean ad started" },
      { at: "Mon", tag: "Facebook", text: "Kitchen before-and-after reel" },
    ],
    projects: [
      { title: "Social media management", percent: 100, status: "Ongoing" },
      { title: "Holiday ad campaign", percent: 60, status: "Running" },
      { title: "Google profile cleanup", percent: 35, status: "In progress" },
    ],
    yourTurn: ["Send 3 to 5 photos from this week's jobs", "Reply to Wednesday's Google review, or tell us what to say"],
  });
}
