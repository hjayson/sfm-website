// SFM Client Hub: shared logic for the login, the hub data and the hourly refresh.
// Client data lives in Netlify Blobs, never in this public repo.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    const form = new URLSearchParams({ "form-name": "client-login-alert", client: client ? client.name : user.client, email: user.email, time: new Date(at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " Eastern", device: deviceOf(req) });
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
// Refresh one client and save it. Errors keep the last good numbers on the page.
export async function refreshOne(s, key, c) {
  const token = process.env.META_ACCESS_TOKEN;
  c.triedAt = new Date().toISOString();
  try {
    let fresh = null;
    if (c.meta && c.meta.pageId && token) fresh = await pullMeta(c, token);
    else if (c.sample) fresh = sampleDay(c);
    if (fresh) {
      Object.assign(c, fresh);
      c.refreshedAt = new Date().toISOString();
    }
    c.refreshError = "";
  } catch (e) {
    c.refreshError = e.message;
  }
  await s.clients.setJSON(key, c);
  return c;
}
// Fresh on open: numbers older than an hour are pulled again before the page shows them.
// A failed pull waits 10 minutes before the next try, so a Meta outage can't slow every visit.
export const STALE_MS = 60 * 60e3;
export function isStale(c) {
  const age = (iso) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);
  return age(c.refreshedAt) > STALE_MS && age(c.triedAt) > 10 * 60e3;
}
export async function refreshAll(s) {
  const { blobs } = await s.clients.list();
  const done = [];
  for (const b of blobs) {
    const c = await s.clients.get(b.key, { type: "json" });
    if (!c) continue;
    await refreshOne(s, b.key, c);
    done.push({ client: b.key, ok: !c.refreshError, connected: !!(c.sample || (c.meta && c.meta.pageId)), error: c.refreshError || undefined });
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

/* ---------- the 7 active clients, moved in from their old portal pages ---------- */
// Each old portal (sfm-deploy-v3/clients/<slug>.html) holds a CLIENT block. On first run it is read
// once, turned into a hub record and saved in the private store. After that the store is the source.
export const ACTIVE_CLIENTS = ["corporate-intelligence", "fuller-and-sons", "legacy-law-group", "national-exchange-club", "perrysburg-heights", "veterans-trio", "vjs-towing"];

// Reads a JavaScript object literal as data (no code is run): quotes bare keys, drops trailing commas.
export function parseClientBlock(html) {
  const start = html.search(/const\s+CLIENT\s*=\s*\{/);
  if (start < 0) throw new Error("No CLIENT block");
  let i = html.indexOf("{", start), depth = 0, out = "", q = null;
  for (; i < html.length; i++) {
    const ch = html[i];
    if (q) {
      if (ch === "\\") {
        const nx = html[i + 1];
        out += nx === "'" ? "'" : ch + nx;
        i++;
        continue;
      }
      if (ch === q) { out += '"'; q = null; continue; }
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; out += '"'; continue; }
    if (ch === "/" && html[i + 1] === "/") { while (i < html.length && html[i] !== "\n") i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (/[\w$]/.test(html[j])) j++;
      const word = html.slice(i, j);
      let k = j;
      while (/\s/.test(html[k])) k++;
      out += html[k] === ":" && !/^(true|false|null)$/.test(word) ? '"' + word + '"' : word;
      i = j - 1;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      out = out.replace(/,\s*$/, "");
      depth--;
      out += ch;
      if (depth === 0) break;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

// Old portal fields -> Client Hub record. Access codes are left behind on purpose.
export function portalToHub(slug, p) {
  const statusOf = (pr) => {
    const st = pr.stages || [];
    const cur = st.find((x) => x.current);
    if (cur) return cur.name;
    if (st.length && st.every((x) => x.done)) return "Complete";
    return "";
  };
  const report = /^https:\/\/(www\.)?salesfunnelmarketing\.us\//.test(p.reportUrl || "") ? p.reportUrl : "";
  return {
    name: p.name || slug,
    tagline: p.tagline || "",
    note: { text: p.weeklyNote || "", updated: p.updated || "" },
    plan: (p.plan && p.plan.length ? p.plan : p.nextSteps) || [],
    projects: (p.projects || []).map((pr) => ({
      title: pr.title,
      percent: +pr.percent || 0,
      status: statusOf(pr),
      stages: (pr.stages || []).map((x) => ({ name: x.name, state: x.current ? "now" : x.done ? "done" : "next" })),
    })),
    yourTurn: p.yourTurn || [],
    reportUrl: report,
    kpis: [],
    log: [],
    refreshedAt: null,
    importedFrom: "clients/" + slug + ".html",
    importedAt: new Date().toISOString(),
  };
}

async function readPortal(slug, origin) {
  const rel = path.join("sfm-deploy-v3", "clients", slug + ".html");
  for (const base of [process.cwd(), process.env.LAMBDA_TASK_ROOT, path.resolve(".")]) {
    if (!base) continue;
    try { return fs.readFileSync(path.join(base, rel), "utf8"); } catch {}
  }
  if (!origin) throw new Error("Portal file not found");
  const r = await fetch(origin + "/clients/" + slug + ".html", { redirect: "manual" });
  if (!r.ok) throw new Error("Portal page " + r.status);
  return r.text();
}

// Adds any active client that isn't in the store yet. Never overwrites a hub that already exists.
export async function importClients(s, origin) {
  const flag = "clients-imported-v1";
  if (await s.config.get(flag)) return [];
  const done = [];
  let missing = 0;
  for (const slug of ACTIVE_CLIENTS) {
    if (await s.clients.get(slug)) continue;
    try {
      await s.clients.setJSON(slug, portalToHub(slug, parseClientBlock(await readPortal(slug, origin))));
      done.push(slug);
    } catch (e) {
      missing++;
      console.log("Client Hub import failed", slug, e.message);
    }
  }
  if (!missing) await s.config.set(flag, new Date().toISOString());
  return done;
}

/* ---------- set-password links ---------- */
export const INVITE_DAYS = 7;
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
export const validEmail = (e) => /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(e);
export function passwordProblem(pw) {
  pw = String(pw || "");
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "That's too long.";
  return "";
}
// Only a hash of the link's token is stored, so the store alone can't be used to set a password.
export async function createInvite(s, { email, role, client, by }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const exp = Date.now() + INVITE_DAYS * 864e5;
  await s.config.setJSON("invite:" + sha(token), { email, role, client: client || null, exp, by, at: new Date().toISOString() });
  return { token, exp };
}
export async function readInvite(s, token) {
  if (!token || String(token).length > 100) return null;
  const inv = await s.config.get("invite:" + sha(token), { type: "json" });
  if (!inv || inv.exp < Date.now()) return null;
  return inv;
}
export async function useInvite(s, token, password) {
  const inv = await readInvite(s, token);
  if (!inv) return { error: "This link has expired or was already used. Ask Jayson for a new one." };
  const bad = passwordProblem(password);
  if (bad) return { error: bad };
  await s.config.delete("invite:" + sha(token));
  const user = { email: inv.email, role: inv.role, ...(inv.client ? { client: inv.client } : {}), ...hashPassword(password), passwordSetAt: new Date().toISOString() };
  await s.users.setJSON(inv.email, user);
  await s.config.delete("lock:" + inv.email);
  return { user };
}

// First owner login on the live site: works only while HUB_SETUP_KEY is set in Netlify,
// and only for the owner email. Remove the key once Jayson is in.
export const OWNER_EMAIL = (process.env.HUB_OWNER_EMAIL || "jayson@salesfunnelmarketing.us").toLowerCase();
export function setupKeyOk(key) {
  const want = process.env.HUB_SETUP_KEY;
  if (!want || !key) return false;
  const a = crypto.createHash("sha256").update(String(key)).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
export async function listUsers(s) {
  const { blobs } = await s.users.list();
  const all = await Promise.all(blobs.map((b) => s.users.get(b.key, { type: "json" })));
  return all.filter(Boolean).map((u) => ({ email: u.email, role: u.role, client: u.client || null, passwordSetAt: u.passwordSetAt || null }));
}
