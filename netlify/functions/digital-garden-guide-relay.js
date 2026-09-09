const https = require("https");

const DEFAULT_GHL_WEBHOOK_URL =
  "https://services.leadconnectorhq.com/hooks/OJDfphRc0kbldNRpq1lD/webhook-trigger/73801063-0419-4bae-9ef4-c7627218acc2";
const GHL_WEBHOOK_URL = process.env.DIGITAL_GARDEN_GHL_WEBHOOK_URL || DEFAULT_GHL_WEBHOOK_URL;
const ALLOWED_ORIGINS = new Set(
  (process.env.SFM_RELAY_ALLOWED_ORIGINS || "https://salesfunnelmarketing.us,https://www.salesfunnelmarketing.us")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

exports.handler = async (event) => {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || "";

  if (event.httpMethod === "OPTIONS") return response(origin, 204, "");
  if (event.httpMethod !== "POST") return json(origin, 405, { ok: false, error: "POST only" });
  if (origin && ALLOWED_ORIGINS.size && !ALLOWED_ORIGINS.has(origin) && !isLocalOrigin(origin)) {
    return json(origin, 403, { ok: false, error: "Origin is not allowed" });
  }

  try {
    const raw = parseBody(event.body);
    if (clean(raw.company)) return json(origin, 200, { ok: true, skipped: true });

    const payload = normalizePayload(raw);
    if (!payload.email) return json(origin, 422, { ok: false, error: "Email is required" });
    if (!isEmail(payload.email)) return json(origin, 422, { ok: false, error: "Email is invalid" });

    const ghlResult = await postJson(GHL_WEBHOOK_URL, payload);
    return json(origin, 200, {
      ok: true,
      ghl_status: ghlResult.statusCode,
      ghl_id: ghlResult.body && ghlResult.body.id,
    });
  } catch (error) {
    console.error("Digital Garden guide relay failed:", error);
    return json(origin, 502, { ok: false, error: error.message || "GHL relay failed" });
  }
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  return JSON.parse(body);
}

function normalizePayload(input) {
  return {
    first_name: clean(input.first_name || input.firstName),
    email: clean(input.email).toLowerCase(),
    source: clean(input.source || "landing-page"),
    offer: clean(input.offer || "digital-garden-guide"),
    page: clean(input.page || input.page_url || input.pageUrl || "sfm-digital-garden"),
    utm_source: clean(input.utm_source || input.utmSource),
    utm_medium: clean(input.utm_medium || input.utmMedium),
    utm_campaign: clean(input.utm_campaign || input.utmCampaign),
    utm_content: clean(input.utm_content || input.utmContent),
    utm_term: clean(input.utm_term || input.utmTerm),
  };
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const body = JSON.stringify(payload);
    const request = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          const parsed = raw ? safeJson(raw) : {};
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GHL webhook failed (${res.statusCode}): ${raw}`));
            return;
          }
          resolve({ statusCode: res.statusCode, body: parsed });
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(10000, () => request.destroy(new Error("GHL webhook timed out")));
    request.write(body);
    request.end();
  });
}

function response(origin, statusCode, body) {
  const allowedOrigin =
    ALLOWED_ORIGINS.has(origin) || isLocalOrigin(origin) ? origin : "https://www.salesfunnelmarketing.us";
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      Vary: "Origin",
    },
    body,
  };
}

function json(origin, statusCode, body) {
  return {
    ...response(origin, statusCode, JSON.stringify(body)),
    headers: {
      ...response(origin, statusCode, "").headers,
      "Content-Type": "application/json",
    },
  };
}

function clean(value) {
  return String(value || "").trim();
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
