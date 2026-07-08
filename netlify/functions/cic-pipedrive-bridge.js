const https = require("https");

const PIPEDRIVE_HOST = "api.pipedrive.com";
const ENV_API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const BRIDGE_SECRET = process.env.CIC_BRIDGE_SECRET;
const OWNER_ID = toNumber(process.env.PIPEDRIVE_OWNER_ID);
const VISIBLE_TO = process.env.PIPEDRIVE_VISIBLE_TO || "3";
const SOURCE_FIELD_KEY = process.env.PIPEDRIVE_LEAD_SOURCE_FIELD_KEY || "";
const SOURCE_OPTION_MAP = parseJsonEnv("PIPEDRIVE_SOURCE_OPTION_MAP_JSON", {});
let personLeadSourceFieldPromise;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(204, "");
  }

  if (event.httpMethod === "GET" && (event.queryStringParameters || {}).probe === "create-test") {
    return runProbe(event);
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
    return json(200, await processLead(payload, apiToken));
  } catch (error) {
    console.error("CIC Pipedrive bridge failed:", error);
    return json(error.statusCode || 500, {
      ok: false,
      error: error.message || "Bridge failed",
    });
  }
};

async function runProbe(event) {
  const apiToken = getApiToken(event);

  if (!apiToken) {
    return json(500, { ok: false, error: "Missing PIPEDRIVE_API_TOKEN" });
  }

  try {
    const stamp = Date.now();
    const result = await processLead({
      first_name: "Bridge",
      last_name: `Probe ${stamp}`,
      email: `bridge.probe.${stamp}@salesfunnelmarketing.us`,
      company: "Bridge Probe Company",
      phone: "4195550199",
      screening_volume: "11 to 50",
      intent: "Bridge probe",
      lead_source: "Meta Ad",
      utm_source: "meta",
      utm_medium: "probe",
      utm_campaign: "bridge-probe",
      page: "bridge-probe",
    }, apiToken);

    return json(200, { probe: "create-test", ...result });
  } catch (error) {
    console.error("CIC Pipedrive bridge probe failed:", error);
    return json(500, {
      ok: false,
      probe: "create-test",
      error: error.message || "Probe failed",
    });
  }
}

async function processLead(payload, apiToken) {
  const lead = normalizePayload(payload);

  if (!lead.email) {
    const error = new Error("Email is required");
    error.statusCode = 422;
    throw error;
  }

  if (!isEmail(lead.email)) {
    const error = new Error("Email is invalid");
    error.statusCode = 422;
    throw error;
  }

  const sourceField = await resolveLeadSourceField(lead.leadSource, apiToken);
  const organizationResult = lead.company
    ? await findOrCreateOrganization(lead.company, apiToken)
    : { id: null, action: "skipped_no_company", error: null };
  const personResult = await findOrCreatePerson(lead, organizationResult.id, sourceField, apiToken);
  const leadResult = await upsertLead(lead, personResult.id, organizationResult.id, sourceField);

  return {
    ok: true,
    organization_id: organizationResult.id,
    organization_action: organizationResult.action,
    organization_error: organizationResult.error,
    person_id: personResult.id,
    person_action: personResult.action,
    person_variant: personResult.variant,
    person_warnings: personResult.warnings,
    lead_id: leadResult.id,
    lead_action: leadResult.action,
    lead_source: lead.leadSource,
    source_field: leadResult.sourceField,
  };
}

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

  try {
    const created = await pipe("POST", "/api/v2/organizations", body, apiToken);
    return {
      id: getId(created),
      action: "created",
      error: null,
    };
  } catch (error) {
    console.warn("CIC Pipedrive organization create skipped:", error.message);
    return {
      id: null,
      action: "skipped_create_failed",
      error: error.message || "Organization create failed",
    };
  }
}

async function findOrCreatePerson(lead, organizationId, sourceField, apiToken) {
  const baseBody = compact({
    name: lead.fullName,
    owner_id: OWNER_ID,
    emails: [{ value: lead.email, primary: true, label: "work" }],
    phones: lead.phone ? [{ value: lead.phone, primary: true, label: "work" }] : undefined,
    visible_to: toNumber(VISIBLE_TO),
  });

  const withSource = (body) => {
    const next = { ...body };
    if (sourceField.key) {
      next.custom_fields = compact({
        ...(next.custom_fields || {}),
        [sourceField.key]: sourceField.value,
      });
    }
    return compact(next);
  };

  const attempts = [
    {
      variant: "full",
      body: withSource({
        ...baseBody,
        org_id: organizationId,
      }),
    },
    {
      variant: "no_source_field",
      body: compact({
        ...baseBody,
        org_id: organizationId,
      }),
    },
    {
      variant: "no_label",
      body: withSource({
        ...baseBody,
        org_id: organizationId,
      }),
    },
    {
      variant: "no_organization",
      body: withSource({
        ...baseBody,
      }),
    },
    {
      variant: "minimal",
      body: baseBody,
    },
  ];

  const warnings = [];

  for (const attempt of attempts) {
    try {
      const created = await pipe("POST", "/api/v2/persons", attempt.body, apiToken);
      return {
        id: getId(created),
        action: "created",
        variant: attempt.variant,
        sourceField,
        warnings,
      };
    } catch (error) {
      const message = error.message || "Person create failed";
      warnings.push(`${attempt.variant}: ${message}`);
      console.warn(`CIC Pipedrive person create attempt failed (${attempt.variant}):`, message);
    }
  }

  throw new Error(`Pipedrive person create failed after ${attempts.length} attempts: ${warnings.join(" | ")}`);
}

async function upsertLead(lead, personId, organizationId, sourceField) {
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

  try {
    const field = await findPersonLeadSourceField(apiToken);

    if (field && field.key) {
      const optionValue = optionValueFor(field, leadSource);
      return {
        key: field.key,
        value: optionValue || leadSource,
        mode: optionValue ? "person_field_option" : "person_field_label",
      };
    }
  } catch (error) {
    console.warn("CIC Pipedrive lead source field lookup skipped:", error.message);
  }

  return { key: null, value: null, mode: "not_configured" };
}

async function findPersonLeadSourceField(apiToken) {
  if (!personLeadSourceFieldPromise) {
    personLeadSourceFieldPromise = pipe("GET", "/api/v1/personFields", undefined, apiToken)
      .then((result) => {
        const fields = asArray(result && result.data);
        return fields.find((field) => clean(field.name).toLowerCase() === "lead source") || null;
      })
      .catch((error) => {
        personLeadSourceFieldPromise = null;
        throw error;
      });
  }

  return personLeadSourceFieldPromise;
}

function optionValueFor(field, leadSource) {
  const options = asArray(field && field.options);
  const normalized = clean(leadSource).toLowerCase();

  if (!options.length || !normalized) return null;

  const option = options.find((item) => {
    const label = clean(item.label || item.name || item.value).toLowerCase();
    return label === normalized;
  });

  return option ? option.id || option.value || option.label : null;
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
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CIC-Bridge-Secret, X-Pipedrive-API-Token",
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
