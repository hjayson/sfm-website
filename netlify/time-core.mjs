// SFM Team Time: shared logic for team logins and hours.
// Hours live in Netlify Blobs, never in this public repo. Each person sees and edits only their own
// hours; admins see everyone, fix entries, approve weeks and export for payroll.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import {
  stores as hubStores, readSession as readHubSession, hashPassword, checkPassword, passwordProblem, validEmail,
  isProd, OWNER_EMAIL,
} from "./hub-core.mjs";

export { hashPassword, checkPassword, passwordProblem, validEmail, isProd, OWNER_EMAIL };

export const COOKIE = "sfm_time";
const SESSION_DAYS = 60;
export const INVITE_DAYS = 7;

// Production and test copies use separate stores, so test logins never touch real hours.
export function stores(context) {
  const ns = isProd(context) ? "team-time" : "team-time-test";
  return {
    users: getStore({ name: ns + "-users", consistency: "strong" }),
    data: getStore({ name: ns + "-data", consistency: "strong" }),
    config: getStore({ name: ns + "-config", consistency: "strong" }),
  };
}

const rid = (n = 9) => crypto.randomBytes(n).toString("base64url").replace(/[-_]/g, "x");
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

/* ---------- sessions (signed cookie) ---------- */
async function secret(t) {
  if (process.env.TIME_SESSION_SECRET) return process.env.TIME_SESSION_SECRET;
  let v = await t.config.get("session-secret");
  if (!v) { v = crypto.randomBytes(32).toString("hex"); await t.config.set("session-secret", v); }
  return v;
}
export async function makeSession(t, u) {
  const body = Buffer.from(JSON.stringify({ i: u.id, e: u.email, v: u.sv || 0, x: Date.now() + SESSION_DAYS * 864e5 })).toString("base64url");
  const sig = crypto.createHmac("sha256", await secret(t)).update(body).digest("base64url");
  return COOKIE + "=" + body + "." + sig + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_DAYS * 86400;
}
export const clearSession = () => COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
async function readSession(t, req) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [body, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", await secret(t)).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.x || p.x < Date.now()) return null;
    return p;
  } catch { return null; }
}

// Who is asking: a Team Time login, or Jayson already logged in to the Client Hub.
// The user record is read on every request, so removing someone or resetting their password
// ends their sessions straight away.
export async function whoIs(t, req, context) {
  const p = await readSession(t, req);
  if (p) {
    const u = await t.users.get(p.e, { type: "json" });
    if (u && u.active !== false && u.id === p.i && (u.sv || 0) === p.v) return u;
  }
  try {
    const hs = await readHubSession(hubStores(context), req);
    if (hs && hs.role === "admin" && String(hs.email).toLowerCase() === OWNER_EMAIL) return ensureOwner(t);
  } catch (e) { console.log("hub session check failed", e.message); }
  return null;
}
export async function ensureOwner(t) {
  let u = await t.users.get(OWNER_EMAIL, { type: "json" });
  if (!u) {
    u = { id: "u" + rid(), email: OWNER_EMAIL, name: "Jayson Hines", role: "admin", active: true, owner: true, createdAt: new Date().toISOString() };
    await t.users.setJSON(OWNER_EMAIL, u);
  }
  return u;
}
// Jayson can also log in here with his Client Hub password.
export async function ownerHubPasswordOk(context, email, pw) {
  if (email !== OWNER_EMAIL) return false;
  const hu = await hubStores(context).users.get(email, { type: "json" });
  return !!(hu && hu.role === "admin" && checkPassword(pw, hu));
}

/* ---------- login lockout ---------- */
export async function lockOf(t, key) { return (await t.config.get(key, { type: "json" })) || { n: 0, until: 0 }; }
export async function failLock(t, key, lock) {
  lock.n += 1;
  if (lock.n >= 5) { lock.until = Date.now() + 15 * 60e3; lock.n = 0; }
  await t.config.setJSON(key, lock);
}

/* ---------- set-password links ---------- */
// Only a hash of the link's token is stored. A new link replaces the person's older ones.
export async function createInvite(t, u, by) {
  const token = rid(32);
  const exp = Date.now() + INVITE_DAYS * 864e5;
  const old = await t.config.get("invite-of:" + u.id);
  if (old) await t.config.delete("invite:" + old);
  await t.config.setJSON("invite:" + sha(token), { email: u.email, id: u.id, exp, by, at: new Date().toISOString() });
  await t.config.set("invite-of:" + u.id, sha(token));
  return { token, exp };
}
export async function readInvite(t, token) {
  if (!token || String(token).length > 100) return null;
  const inv = await t.config.get("invite:" + sha(token), { type: "json" });
  if (!inv || inv.exp < Date.now()) return null;
  const u = await t.users.get(inv.email, { type: "json" });
  if (!u || u.id !== inv.id || u.active === false) return null;
  return { inv, u };
}
export async function useInvite(t, token, password) {
  const r = await readInvite(t, token);
  if (!r) return { error: "This link has expired or was already used. Ask Jayson for a new one." };
  const bad = passwordProblem(password);
  if (bad) return { error: bad };
  await t.config.delete("invite:" + sha(token));
  await t.config.delete("invite-of:" + r.u.id);
  const u = { ...r.u, ...hashPassword(password), passwordSetAt: new Date().toISOString(), sv: (r.u.sv || 0) + 1 };
  await t.users.setJSON(u.email, u);
  await t.config.delete("lock:" + u.email);
  return { user: u };
}

/* ---------- people ---------- */
export async function listUsers(t) {
  const { blobs } = await t.users.list();
  const all = await Promise.all(blobs.map((b) => t.users.get(b.key, { type: "json" })));
  return all.filter(Boolean);
}
export const publicPerson = (u, withPrivate) => ({
  id: u.id, name: u.name || u.email, email: u.email, role: u.role, active: u.active !== false,
  ...(withPrivate ? { rate: u.rate || "", hasPassword: !!u.hash || !!u.owner, owner: !!u.owner } : {}),
});
export async function addPerson(t, { email, name, rate, role }) {
  const u = { id: "u" + rid(), email, name, role: role === "admin" ? "admin" : "member", rate: cleanRate(rate), active: true, createdAt: new Date().toISOString() };
  await t.users.setJSON(email, u);
  return u;
}
export const cleanRate = (r) => (r === "" || r == null || isNaN(+r) || +r < 0 ? "" : Math.round(+r * 100) / 100);
export async function userById(t, id) {
  return (await listUsers(t)).find((u) => u.id === id) || null;
}

/* ---------- clients ---------- */
export const DEFAULT_CLIENTS = [
  ["c-cic", "CIC"], ["c-llg", "Legacy Law Group"], ["c-nec", "National Exchange Club"],
  ["c-vub", "Owens TRIO Veterans (VUB)"], ["c-vjs", "VJ's Towing"], ["c-phcc", "Perrysburg Heights Community Center"],
  ["c-fuller", "Fuller and Sons"], ["c-sfm", "SFM internal"], ["c-admin", "Admin and email"],
].map(([id, name]) => ({ id, name }));
export async function getClients(t) {
  let s = await t.data.get("settings", { type: "json" });
  if (!s) { s = { clients: DEFAULT_CLIENTS }; await t.data.setJSON("settings", s); }
  return s.clients || [];
}
export async function saveClients(t, list) {
  const seen = new Set();
  const clean = [];
  for (const c of Array.isArray(list) ? list : []) {
    const name = String((c && c.name) || "").trim().slice(0, 80);
    let id = String((c && c.id) || "");
    if (!name) continue;
    if (!/^c-[A-Za-z0-9-]{1,40}$/.test(id)) id = "c-" + rid(5);
    if (seen.has(id)) continue;
    seen.add(id);
    clean.push({ id, name, ...(c.archived ? { archived: true } : {}) });
  }
  if (clean.length > 200) throw new Error("Too many clients.");
  await t.data.setJSON("settings", { clients: clean });
  return clean;
}

/* ---------- dates ---------- */
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export function validDate(d) {
  if (!DATE.test(String(d))) return false;
  const [y, m, dd] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === dd && y >= 2020 && y <= 2100;
}
export function weekOf(d) {
  const [y, m, dd] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}
export function addDaysKey(d, n) {
  const [y, m, dd] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, dd + n));
  return x.toISOString().slice(0, 10);
}
const toMin = (s) => { const [a, b] = s.split(":").map(Number); return a * 60 + b; };
export const span = (a, b) => { let m = toMin(b) - toMin(a); if (m <= 0) m += 1440; return m; };

/* ---------- weeks ---------- */
const wkey = (uid, week) => "w/" + uid + "/" + week;
export async function getWeek(t, uid, week) {
  return (await t.data.get(wkey(uid, week), { type: "json" })) || { entries: [], submitted: null, approved: null };
}
export async function putWeek(t, uid, week, w) {
  if (!w.entries.length && !w.submitted && !w.approved) { await t.data.delete(wkey(uid, week)); return; }
  await t.data.setJSON(wkey(uid, week), w);
}
export function summarize(w) {
  let minutes = 0, maxUp = 0;
  for (const e of w.entries) { minutes += e.minutes || 0; maxUp = Math.max(maxUp, e.updatedAt || 0); }
  return { minutes, count: w.entries.length, maxUp };
}
export function status(w) {
  const s = summarize(w);
  if (w.approved) {
    const same = w.approved.minutes === s.minutes && w.approved.count === s.count && s.maxUp <= w.approved.at;
    return same ? "approved" : "changed";
  }
  return w.submitted ? "submitted" : "open";
}

// Checks an entry from the page and returns the fields to store, or an error.
export function cleanEntry(b, clients, isAdmin) {
  const date = String(b.date || ""), start = String(b.start || ""), end = String(b.end || "");
  if (!validDate(date)) return { error: "Pick a date." };
  if (!TIME.test(start) || !TIME.test(end)) return { error: "Pick a start and end time." };
  if (start === end) return { error: "The start and end are the same time." };
  const today = new Date().toISOString().slice(0, 10);
  if (date > addDaysKey(today, 1)) return { error: "That date is in the future." };
  if (!isAdmin && date < addDaysKey(today, -120)) return { error: "That's more than 4 months back. Ask Jayson to add it." };
  const client = String(b.client || "");
  if (!clients.find((c) => c.id === client) && client !== "general") return { error: "Pick a client." };
  const minutes = span(start, end);
  if (minutes > 16 * 60) return { error: "One entry can't be longer than 16 hours. Split it in two." };
  return { e: { date, start, end, minutes, client, note: String(b.note || "").trim().slice(0, 240), tz: String(b.tz || "").slice(0, 60) } };
}

/* ---------- sample data for test copies only ---------- */
export const TEST_PASSWORD = "sample-time-2026"; // sample logins on test copies only
export async function seedTestData(t, context) {
  if (isProd(context)) return;
  if (await t.config.get("seeded-v1")) return;
  const mk = async (email, name, role, rate) => {
    const u = { id: "u" + rid(), email, name, role, rate, active: true, ...hashPassword(TEST_PASSWORD), passwordSetAt: new Date().toISOString(), createdAt: new Date().toISOString() };
    await t.users.setJSON(email, u);
    return u;
  };
  await mk("boss@sfm-test.example", "Test Owner", "admin", "");
  const sam = await mk("sam@sfm-test.example", "Sam Sample", "member", 20);
  const riley = await mk("riley@sfm-test.example", "Riley Sample", "member", 18);
  await getClients(t);
  // Last week, so the team view has something to approve.
  const today = new Date().toISOString().slice(0, 10);
  const last = addDaysKey(weekOf(today), -7);
  const now = Date.now() - 3 * 864e5;
  const plan = [
    [sam, [[0, "09:00", "12:30", "c-cic", "Edited podcast clips"], [1, "13:00", "17:00", "c-vub", "20 Under 40 posts"], [3, "10:00", "14:15", "c-nec", "Flat Fussell photo edits"]]],
    [riley, [[0, "08:30", "11:00", "c-phcc", "Kroger bag drive post"], [2, "12:00", "16:30", "c-llg", "Blog draft"]]],
  ];
  for (const [u, rows] of plan) {
    const w = { entries: [], submitted: null, approved: null };
    for (const [d, s, e, c, n] of rows) {
      w.entries.push({ id: "e" + rid(), date: addDaysKey(last, d), start: s, end: e, minutes: span(s, e), client: c, note: n, source: "manual", tz: "America/New_York", createdAt: now, updatedAt: now, updatedBy: u.id, history: [] });
    }
    if (u === sam) w.submitted = { at: now, ...(() => { const s = summarize(w); return { minutes: s.minutes, count: s.count }; })() };
    await putWeek(t, u.id, last, w);
  }
  await t.config.set("seeded-v1", new Date().toISOString());
}
