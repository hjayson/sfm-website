const https = require("https");

const PIPEDRIVE_HOST = "api.pipedrive.com";
const ENV_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BRIDGE_SECRET = process.env.CIC_BRIDGE_SECRET;
const OWNER_ID = toNumber(process.env.PIPEDRIVE_OWNER_ID);
const VISIBLE_TO = process.env.PIPEDRIVE_VISIBLE_TO || "3";
const SOURCE_FIELD_KEY = process.env.PIPEDRIVE_LEAD_SOURCE_FIELD_KEY || "";
const SOURCE_OPTION_MAP = parseJsonEnv("PIPEDRIVE_SOURCE_OPTION_MAP_JSON", {});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, error: "POST only" });
  }

  const apiToken = getApiToken(event);

  if (!apiToken) {
    return json(500, { ok: false, error: "Missing PIPEDRIVE_API_TOKEN" });
  }

  if (BRIDGE_SECRET && !hasValidSecret(event)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  try {
    const payload = parseBody(event.body);
    const lead = normalizePayload(payload);

    if (!lead.email) {
      return json(422, { ok: false, error: "Email is required" });
    }

    if (!isEmail(lead.email)) {
      return json(422, { ok: false, error: "Email is invalid" });
    }

    const organizationId = lead.company
      ? await findOrCreateOrganization(lead.company, apiToken)
      : null;
    const personId = await findOrCreatePerson(lead, organizationId, apiToken);
    const leadResult = await upsertLead(lead, personId, organizationId, apiToken);

    return json(200, {
      ok: true,
      organization_id: organizationId,
      person_id: personId,
      lead_id: leadResult.id,
      lead_action: leadResult.action,
      lead_source: lead.leadSource,
      source_field: leadResult.sourceField,
    });
  } catch (error) {
    console.error("CIC Pipedrive bridge failed:", error);
    return json(500, {
      ok: false,
      error: error.message || "Bridge failed",
    });
  }
};

function parseBody(body) {
  if (!body) return {};
  if (typeof body === "object") return body;
  return JSON.parse(body);
}

function normalizePayload(input) {
  const firstName = clean(input.first_name || input.firstName);
  const lastName = clean(input.last_name || input.lastName);
  const fullName = clean(input.name || [firstName, lastName].filter(Boolean).join(" "));
  const email = clean(input.email || input.work_email || input.workEmail).toLowerCase();
  const company = clean(input.company || input.organization || input.org_name);
  const phone = clean(input.phone || input.phone_number || input.phoneNumber);
  const utmSource = clean(input.utm_source || input.utmSource);
  const rawSource = clean(input.lead_source || input.leadSource || input.source || utmSource);

  return {
    firstName,
    lastName,
    fullName: fullName || email,
    email,
    company,
    phone,
    screeningVolume: clean(input.screening_volume || input.annualVolume),
    intent: clean(input.intent || input.helpIntent),
    leadSource: normalizeLeadSource(rawSource, utmSource),
    utmSource,
    utmMedium: clean(input.utm_medium || input.utmMedium),
    utmCampaign: clean(input.utm_campaign || input.utmCampaign),
    page: clean(input.page || input.page_url || input.pageUrl),
  };
}

function normalizeLeadSource(source, utmSource) {
  const value = clean(source || utmSource).toLowerCase();

  if (!value) return "Website Form";
  if (value.includes("meta") || value.includes("facebook") || value === "fb") return "Meta Ad";
  if (value.includes("linkedin")) return "LinkedIn Ad";
  if (value.includes("google") || value.includes("adwords") || value.includes("ppc")) return "Google Ad";
  if (value.includes("website") || value.includes("form") || value.includes("direct")) return "Website Form";

  return clean(source);
}

async function findOrCreateOrganization(company, apiToken) {
  const body = compact({
    name: company,
    owner_id: OWNER_ID,
    visible_to: toNumber(VISIBLE_TO),
  });

  const created = await pipe("POST", "/api/v1/organizations", body, apiToken);
  return getId(created);
}

async function findOrCreatePerson(lead, organizationId, apiToken) {
  const body = compact({
    name: lead.fullName,
    org_id: organizationId,
    owner_id: OWNER_ID,
    email: lead.email,
    phone: lead.phone,
    label: "Ad Lead",
    visible_to: toNumber(VISIBLE_TO),
  });

  const created = await pipe("POST", "/api/v1/persons", body, apiToken);
  return getId(created);
}

async function upsertLead(lead, personId, organizationId, apiToken) {
  const sourceField = await resolveLeadSourceField(lead.leadSource, apiToken);
  return {
    id: null,
    action: "skipped_existing_pipedrive_automation",
    person_id: personId,
    organization_id: organizationId,
    sourceField,
  };
}

async function resolveLeadSourceField(leadSource, apiToken) {
  if (SOURCE_FIELD_KEY) {
    return {
      key: SOURCE_FIELD_KEY,
      value: SOURCE_OPTION_MAP[leadSource] || leadSource,
      mode: "env",
    };
  }

  return { key: null, value: null, mode: "not_configured" };
}

async function findFirstId(path, apiToken) {
  const result = await pipe("GET", path, undefined, apiToken);
  return firstIdFromSearch(result);
}

function firstIdFromSearch(result) {
  const data = result && result.data;
  const items = asArray((data && data.items) || data);

  for (const item of items) {
    const id = getId(item.item || item);
    if (id) return id;
  }

  return null;
}

function getId(result) {
  if (!result) return null;
  if (result.id) return result.id;
  if (result.data && result.data.id) return result.data.id;
  if (result.item && result.item.id) return result.item.id;
  return null;
}

function originIdFor(lead) {
  return [lead.leadSource, lead.page, lead.utmSource, lead.utmMedium, lead.utmCampaign]
    .filter(Boolean)
    .join(" | ")
    .slice(0, 255);
}

function pipe(method, path, body, apiToken) {
  return new Promise((resolve, reject) => {
    const jsonBody = body ? JSON.stringify(body) : null;
    const options = {
      hostname: PIPEDRIVE_HOST,
      path: withToken(path, apiToken),
      method,
      headers: {
        Accept: "application/json",
      },
    };

    if (jsonBody) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(jsonBody);
    }

    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        const parsed = raw ? safeJson(raw) : {};

        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.success === false) {
          const message = parsed.error || parsed.error_info || parsed.message || raw;
          reject(new Error(`Pipedrive ${method} ${path.split("?")[0]} failed (${res.statusCode}): ${message}`));
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error(`Pipedrive ${method} ${path.split("?")[0]} timed out`));
    });

    if (jsonBody) req.write(jsonBody);
    req.end();
  });
}

function withToken(path, apiToken) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}api_token=${encodeURIComponent(apiToken)}`;
}

function hasValidSecret(event) {
  const headers = lowerHeaders(event.headers || {});
  const query = event.queryStringParameters || {};
  const provided = headers["x-cic-bridge-secret"] || query.secret || query.bridge_secret;
  return provided === BRIDGE_SECRET;
}

function getApiToken(event) {
  if (ENV_API_TOKEN) return ENV_API_TOKEN;

  const headers = lowerHeaders(event.headers || {});
  const query = event.queryStringParameters || {};
  const authorization = clean(headers.authorization);

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return (
    clean(headers["x-pipedrive-api-token"]) ||
    clean(query.pipedrive_api_token) ||
    clean(query.api_token)
  );
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-CIC-Bridge-Secret",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body,
  };
}

function json(statusCode, body) {
  return {
    ...response(statusCode, JSON.stringify(body)),
    headers: {
      ...response(statusCode, "").headers,
      "Content-Type": "application/json",
    },
  };
}

function clean(value) {
  return String(value || "").trim();
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function lowerHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}
