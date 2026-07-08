const https = require("https");

const DEFAULT_GHL_WEBHOOK_URL =
  "https://services.leadconnectorhq.com/hooks/Wz5dF7uxlMP59Q9vBIwV/webhook-trigger/63fca5f6-73d1-4a0e-a32d-a0337700339d";

const GHL_WEBHOOK_URL = process.env.CIC_GHL_WEBHOOK_URL || DEFAULT_GHL_WEBHOOK_URL;
const ALLOWED_ORIGINS = new Set(
  (process.env.CIC_RELAY_ALLOWED_ORIGINS || "https://corpintel.com,https://www.corpintel.com")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

exports.handler = async (event) => {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || "";

  if (event.httpMethod === "OPTIONS") {
    return response(origin, 204, "");
  }

  if (event.httpMethod !== "POST") {
    return json(origin, 405, { ok: false, error: "POST only" });
  }

  if (origin && ALLOWED_ORIGINS.size && !ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { ok: false, error: "Origin is not allowed" });
  }

  try {
    const payload = normalizePayload(parseBody(event.body));

    if (!payload.email) {
      return json(origin, 422, { ok: false, error: "Email is required" });
    }

    if (!isEmail(payload.email)) {
      return json(origin, 422, { ok: false, error: "Email is invalid" });
    }

    const ghlResult = await postJson(GHL_WEBHOOK_URL, payload);

    return json(origin, 200, {
      ok: true,
      ghl_status: ghlResult.statusCode,
      ghl_id: ghlResult.body && ghlResult.body.id,
    });
  } catch (error) {
    console.error("CIC GHL relay failed:", error);
    return json(origin, 502, {
      ok: false,
      error: error.message || "GHL relay failed",
    });
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
    last_name: clean(input.last_name || input.lastName),
    email: clean(input.email || input.work_email || input.workEmail).toLowerCase(),
    company: clean(input.company || input.organization || input.org_name),
    phone: clean(input.phone || input.phone_number || input.phoneNumber),
    screening_volume: clean(input.screening_volume || input.volume || input.annualVolume),
    intent: clean(input.intent || input.helpIntent),
    lead_source: clean(input.lead_source || input.leadSource || input.source || "Website Form"),
    utm_source: clean(input.utm_source || input.utmSource),
    utm_medium: clean(input.utm_medium || input.utmMedium),
    utm_campaign: clean(input.utm_campaign || input.utmCampaign),
    page: clean(input.page || input.page_url || input.pageUrl || "ad-landing"),
  };
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const body = JSON.stringify(payload);
    const req = https.request(
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

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("GHL webhook timed out"));
    });
    req.write(body);
    req.end();
  });
}

function response(origin, statusCode, body) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://corpintel.com";

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

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
