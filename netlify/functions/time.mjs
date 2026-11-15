// SFM Team Time API. Team members log their own hours; admins see the whole team.
import {
  stores, seedTestData, whoIs, makeSession, clearSession, checkPassword, ownerHubPasswordOk, ensureOwner, lockOf, failLock,
  createInvite, readInvite, useInvite, listUsers, publicPerson, addPerson, cleanRate, userById, getClients, saveClients,
  validDate, weekOf, addDaysKey, getWeek, putWeek, summarize, status, cleanEntry, validEmail, isProd, OWNER_EMAIL, INVITE_DAYS,
} from "../time-core.mjs";
import crypto from "node:crypto";

const json = (body, code = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const sameOrigin = (req) => {
  const o = req.headers.get("origin");
  return !o || o === new URL(req.url).origin;
};
const readBody = async (req) => { try { return await req.json(); } catch { return {}; } };
const eid = () => "e" + crypto.randomBytes(8).toString("base64url").replace(/[-_]/g, "x");
const histOf = (e) => ({ date: e.date, start: e.start, end: e.end, client: e.client, note: e.note || "" });

export default async (req, context) => {
  const t = stores(context);
  await seedTestData(t, context);
  const url = new URL(req.url);
  const origin = url.origin;
  const action = context.params.action;
  const post = req.method === "POST";
  if (post && !sameOrigin(req)) return json({ error: "Not allowed" }, 403);
  const b = post ? await readBody(req) : {};

  /* ---------- signing in ---------- */
  if (action === "login" && post) {
    const email = String(b.email || "").trim().toLowerCase();
    const pw = String(b.password || "");
    const lockKey = "lock:" + email;
    const lock = await lockOf(t, lockKey);
    if (lock.until > Date.now()) return json({ error: "Too many tries. Wait 15 minutes, or ask Jayson for a new link." }, 429);
    let u = email && validEmail(email) ? await t.users.get(email, { type: "json" }) : null;
    let ok = !!(u && u.active !== false && u.hash && checkPassword(pw, u));
    if (!ok && email === OWNER_EMAIL && (await ownerHubPasswordOk(context, email, pw))) { u = await ensureOwner(t); ok = true; }
    if (!ok) {
      await failLock(t, lockKey, lock);
      return json({ error: "That email and password don't match." }, 401);
    }
    await t.config.delete(lockKey);
    return json({ ok: true }, 200, { "set-cookie": await makeSession(t, u) });
  }
  if (action === "logout") return json({ ok: true }, 200, { "set-cookie": clearSession() });

  if (action === "invite-check") {
    const r = await readInvite(t, url.searchParams.get("t"));
    if (!r) return json({ error: "This link has expired or was already used. Ask Jayson for a new one." }, 410);
    return json({ email: r.u.email, name: r.u.name || "", reset: !!r.u.hash });
  }
  if (action === "set-password" && post) {
    const r = await useInvite(t, b.token, b.password);
    if (r.error) return json({ error: r.error }, 400);
    return json({ ok: true }, 200, { "set-cookie": await makeSession(t, r.user) });
  }

  const me = await whoIs(t, req, context);
  if (!me) return json({ error: "Please log in." }, 401);
  const admin = me.role === "admin";
  const clients = await getClients(t);

  // Whose hours a request is about. Team members only ever get their own.
  const target = async (id) => {
    if (!id || id === me.id) return me;
    if (!admin) return null;
    return userById(t, String(id));
  };

  if (action === "me") {
    const clock = await t.data.get("clock/" + me.id, { type: "json" });
    return json({ me: publicPerson(me, admin), admin, test: !isProd(context), clients, clock: clock || null });
  }

  if (action === "week") {
    const week = String(url.searchParams.get("w") || "");
    if (!validDate(week) || weekOf(week) !== week) return json({ error: "Bad week" }, 400);
    const who = await target(url.searchParams.get("id"));
    if (!who) return json({ error: "Not allowed" }, 403);
    const w = await getWeek(t, who.id, week);
    return json({ week, person: publicPerson(who, admin), ...w, status: status(w), ...summarize(w) });
  }

  /* ---------- clock ---------- */
  if (action === "clock-in" && post) {
    const client = String(b.client || "");
    if (!clients.find((c) => c.id === client && !c.archived) && client !== "general") return json({ error: "Pick a client." }, 400);
    const on = await t.data.get("clock/" + me.id, { type: "json" });
    if (on) return json({ error: "You're already on the clock.", clock: on }, 409);
    const clock = { startedAt: Date.now(), client, note: String(b.note || "").trim().slice(0, 240) };
    await t.data.setJSON("clock/" + me.id, clock);
    return json({ ok: true, clock });
  }
  if (action === "clock-note" && post) {
    const clock = await t.data.get("clock/" + me.id, { type: "json" });
    if (!clock) return json({ error: "You're not on the clock." }, 409);
    clock.note = String(b.note || "").trim().slice(0, 240);
    await t.data.setJSON("clock/" + me.id, clock);
    return json({ ok: true, clock });
  }
  if (action === "clock-cancel" && post) {
    await t.data.delete("clock/" + me.id);
    return json({ ok: true });
  }
  // Clock out: the page sends the start and end in the person's own local time.
  if (action === "clock-out" && post) {
    const clock = await t.data.get("clock/" + me.id, { type: "json" });
    if (!clock) return json({ error: "You're not on the clock." }, 409);
    const c = cleanEntry({ ...b, client: b.client || clock.client }, clients, admin);
    if (c.error) return json({ error: c.error }, 400);
    const sw = b.switchTo ? String(b.switchTo) : "";
    if (sw && !clients.find((x) => x.id === sw && !x.archived) && sw !== "general") return json({ error: "Pick a client." }, 400);
    const r = await saveNew(t, me, me, c.e, "clock", admin);
    if (r.error) return json({ error: r.error }, r.code || 400);
    let next = null;
    if (sw) {
      next = { startedAt: Date.now(), client: sw, note: "" };
      await t.data.setJSON("clock/" + me.id, next);
    } else await t.data.delete("clock/" + me.id);
    return json({ ok: true, entry: r.entry, clock: next });
  }

  /* ---------- entries ---------- */
  if (action === "entry-save" && post) {
    const who = await target(b.uid);
    if (!who) return json({ error: "Not allowed" }, 403);
    const c = cleanEntry(b, clients, admin);
    if (c.error) return json({ error: c.error }, 400);
    if (!b.id) {
      const r = await saveNew(t, me, who, c.e, "manual", admin);
      return r.error ? json({ error: r.error }, r.code || 400) : json({ ok: true, entry: r.entry });
    }
    const fromWeek = validDate(b.was) ? weekOf(b.was) : null;
    if (!fromWeek) return json({ error: "Reload and try again." }, 400);
    const toWeek = weekOf(c.e.date);
    const wa = await getWeek(t, who.id, fromWeek);
    const i = wa.entries.findIndex((x) => x.id === b.id);
    if (i < 0) return json({ error: "That entry was changed or deleted. Reload to see the latest." }, 409);
    const wb = toWeek === fromWeek ? wa : await getWeek(t, who.id, toWeek);
    if (!admin && (wa.approved || wb.approved)) return json({ error: "That week is approved. Ask Jayson to reopen it." }, 423);
    const prev = wa.entries[i];
    const now = Date.now();
    const changed = ["date", "start", "end", "client", "note"].some((k) => (prev[k] || "") !== (c.e[k] || ""));
    if (!changed) return json({ ok: true, entry: prev });
    const entry = { ...prev, ...c.e, tz: prev.tz || c.e.tz, updatedAt: now, updatedBy: me.id, history: [...(prev.history || []), { at: now, by: me.id, byName: me.name, was: histOf(prev) }].slice(-20) };
    wa.entries.splice(i, 1);
    wb.entries.push(entry);
    if (!admin) { wa.submitted = null; wb.submitted = null; }
    await putWeek(t, who.id, fromWeek, wa);
    if (wb !== wa) await putWeek(t, who.id, toWeek, wb);
    return json({ ok: true, entry });
  }
  if (action === "entry-delete" && post) {
    const who = await target(b.uid);
    if (!who) return json({ error: "Not allowed" }, 403);
    if (!validDate(b.date)) return json({ error: "Reload and try again." }, 400);
    const week = weekOf(b.date);
    const w = await getWeek(t, who.id, week);
    if (!admin && w.approved) return json({ error: "That week is approved. Ask Jayson to reopen it." }, 423);
    const before = w.entries.length;
    w.entries = w.entries.filter((x) => x.id !== b.id);
    if (w.entries.length === before) return json({ error: "That entry was already deleted." }, 409);
    if (!admin) w.submitted = null;
    await putWeek(t, who.id, week, w);
    return json({ ok: true });
  }

  /* ---------- weeks ---------- */
  if ((action === "submit" || action === "unsubmit") && post) {
    const week = String(b.week || "");
    if (!validDate(week) || weekOf(week) !== week) return json({ error: "Bad week" }, 400);
    const w = await getWeek(t, me.id, week);
    if (w.approved) return json({ error: "That week is already approved." }, 423);
    if (action === "submit") {
      if (!w.entries.length) return json({ error: "Log some time first." }, 400);
      const s = summarize(w);
      w.submitted = { at: Date.now(), minutes: s.minutes, count: s.count };
    } else w.submitted = null;
    await putWeek(t, me.id, week, w);
    return json({ ok: true, submitted: w.submitted });
  }

  /* ---------- admin only from here ---------- */
  if (!admin) return json({ error: "Not allowed" }, 403);

  if (action === "team") {
    const week = String(url.searchParams.get("w") || "");
    if (!validDate(week) || weekOf(week) !== week) return json({ error: "Bad week" }, 400);
    const people = (await listUsers(t)).filter((u) => u.active !== false || u.id === me.id);
    const rows = await Promise.all(people.map(async (u) => {
      const [w, clock] = await Promise.all([getWeek(t, u.id, week), t.data.get("clock/" + u.id, { type: "json" })]);
      return { person: publicPerson(u, true), ...w, status: status(w), ...summarize(w), clock: clock || null };
    }));
    rows.sort((a, b) => a.person.name.localeCompare(b.person.name));
    return json({ week, rows });
  }
  if ((action === "approve" || action === "reopen") && post) {
    const who = await userById(t, String(b.uid || ""));
    const week = String(b.week || "");
    if (!who || !validDate(week) || weekOf(week) !== week) return json({ error: "Reload and try again." }, 400);
    const w = await getWeek(t, who.id, week);
    if (action === "approve") {
      if (!w.entries.length) return json({ error: "Nothing to approve that week." }, 400);
      const s = summarize(w);
      w.approved = { at: Date.now(), minutes: s.minutes, count: s.count, by: me.id, byName: me.name };
    } else { w.approved = null; w.submitted = null; }
    await putWeek(t, who.id, week, w);
    return json({ ok: true });
  }
  if (action === "clients" && post) {
    try { return json({ ok: true, clients: await saveClients(t, b.clients) }); }
    catch (e) { return json({ error: e.message }, 400); }
  }
  if (action === "people") {
    return json({ people: (await listUsers(t)).map((u) => publicPerson(u, true)).sort((a, z) => a.name.localeCompare(z.name)) });
  }
  // Adds a person and makes their one-time set-password link. Nothing is emailed or texted;
  // the link is shown to the admin, who sends it.
  if (action === "person-add" && post) {
    const email = String(b.email || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 60);
    if (!name) return json({ error: "Add their name." }, 400);
    if (!validEmail(email)) return json({ error: "Enter a real email address." }, 400);
    if (await t.users.get(email)) return json({ error: "That email already has a login here. Use New link on their row." }, 409);
    const u = await addPerson(t, { email, name, rate: b.rate, role: b.role });
    const { token, exp } = await createInvite(t, u, me.email);
    return json({ ok: true, person: publicPerson(u, true), link: origin + "/time/?t=" + token, expires: new Date(exp).toISOString(), days: INVITE_DAYS });
  }
  if (action === "person-update" && post) {
    const u = await userById(t, String(b.id || ""));
    if (!u) return json({ error: "Reload and try again." }, 404);
    if (b.name != null) { const n = String(b.name).trim().slice(0, 60); if (n) u.name = n; }
    if (b.rate !== undefined) u.rate = cleanRate(b.rate);
    if (b.role != null && !u.owner && u.id !== me.id) u.role = b.role === "admin" ? "admin" : "member";
    if (b.active != null && !u.owner && u.id !== me.id) {
      u.active = !!b.active;
      if (!u.active) { u.sv = (u.sv || 0) + 1; await t.data.delete("clock/" + u.id); }
    }
    await t.users.setJSON(u.email, u);
    return json({ ok: true, person: publicPerson(u, true) });
  }
  if (action === "person-link" && post) {
    const u = await userById(t, String(b.id || ""));
    if (!u || u.active === false) return json({ error: "Turn their access back on first." }, 400);
    if (u.owner) return json({ error: "You log in with your Client Hub password." }, 400);
    const { token, exp } = await createInvite(t, u, me.email);
    return json({ ok: true, link: origin + "/time/?t=" + token, expires: new Date(exp).toISOString(), days: INVITE_DAYS });
  }
  if (action === "export") {
    const from = String(url.searchParams.get("from") || ""), to = String(url.searchParams.get("to") || "");
    if (!validDate(from) || !validDate(to) || from > to) return json({ error: "Pick a start date before the end date." }, 400);
    if (addDaysKey(from, 400) < to) return json({ error: "Export a year or less at a time." }, 400);
    const people = await listUsers(t);
    const cname = (id) => (clients.find((c) => c.id === id) || {}).name || (id === "general" ? "General" : "Removed client");
    const pad = (n) => String(n).padStart(2, "0");
    const rows = [["Person", "Email", "Date", "Start", "End", "Hours", "Decimal hours", "Client", "Note", "Entry type", "Week status", "Edited", "Hourly rate", "Cost"]];
    for (const u of people) {
      const list = [];
      for (let wk = weekOf(from); wk <= to; wk = addDaysKey(wk, 7)) {
        const w = await getWeek(t, u.id, wk);
        const st = status(w);
        for (const e of w.entries) if (e.date >= from && e.date <= to) list.push({ ...e, st });
      }
      list.sort((x, y) => (x.date + x.start).localeCompare(y.date + y.start));
      for (const e of list) {
        const hrs = e.minutes / 60;
        rows.push([u.name, u.email, e.date, e.start, e.end, Math.floor(e.minutes / 60) + ":" + pad(e.minutes % 60), hrs.toFixed(2), cname(e.client), e.note || "",
          e.source === "clock" ? "Clock" : "Manual", { approved: "Approved", changed: "Changed after approval", submitted: "Submitted", open: "Open" }[e.st],
          e.history && e.history.length ? "Yes" : "", u.rate || "", u.rate ? (hrs * u.rate).toFixed(2) : ""]);
      }
    }
    // Cells that start with = + - @ are prefixed so spreadsheets don't run them as formulas.
    const cell = (v) => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="SFM-team-hours-${from}-to-${to}.csv"`, "cache-control": "no-store" } });
  }

  return json({ error: "Not found" }, 404);
};

async function saveNew(t, me, who, e, source, admin) {
  const week = weekOf(e.date);
  const w = await getWeek(t, who.id, week);
  if (!admin && w.approved) return { error: "That week is approved. Ask Jayson to reopen it.", code: 423 };
  if (w.entries.length >= 300) return { error: "That week is full." };
  const now = Date.now();
  const entry = { id: eid(), ...e, source, createdAt: now, updatedAt: now, updatedBy: me.id, ...(me.id !== who.id ? { addedBy: me.name } : {}), history: [] };
  w.entries.push(entry);
  if (!admin) w.submitted = null;
  await putWeek(t, who.id, week, w);
  return { entry };
}

export const config = { path: "/api/time/:action" };
