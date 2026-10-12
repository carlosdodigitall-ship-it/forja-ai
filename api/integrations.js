const crypto = require("crypto");
const admin = require("firebase-admin");

const PROVIDERS = {
  github: { name: "GitHub", kind: "token" },
  vercel: { name: "Vercel", kind: "token" },
  gitlab: { name: "GitLab", kind: "token" },
  openai: { name: "OpenAI", kind: "api_key" },
  gemini: { name: "Google Gemini", kind: "api_key" },
  anthropic: { name: "Anthropic", kind: "api_key" },
  supabase: { name: "Supabase", kind: "project_credentials" },
  stripe: { name: "Stripe", kind: "secret_key" },
  mercadopago: { name: "Mercado Pago", kind: "access_token" },
  resend: { name: "Resend", kind: "api_key" },
  groq: { name: "Groq", kind: "api_key" },
  openrouter: { name: "OpenRouter", kind: "api_key" }
};

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

function getAdmin() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const e = new Error("O servidor ainda não foi configurado para guardar integrações de forma segura.");
    e.code = "SERVER_SETUP_REQUIRED";
    throw e;
  }
  if (!admin.apps.length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (_) {
      const e = new Error("FIREBASE_SERVICE_ACCOUNT_JSON não contém JSON válido.");
      e.code = "SERVER_SETUP_REQUIRED";
      throw e;
    }
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

function encryptionKey() {
  const value = process.env.INTEGRATIONS_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    const e = new Error("INTEGRATIONS_ENCRYPTION_KEY precisa conter 64 caracteres hexadecimais.");
    e.code = "SERVER_SETUP_REQUIRED";
    throw e;
  }
  return Buffer.from(value, "hex");
}

function encryptCredentials(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function requireUser(req) {
  const services = getAdmin();
  const idToken = bearer(req);
  if (!idToken) {
    const e = new Error("Sua sessão expirou. Entre novamente na Forja AI.");
    e.status = 401;
    throw e;
  }
  try {
    const decoded = await services.auth.verifyIdToken(idToken);
    if (!decoded.uid || decoded.firebase && decoded.firebase.sign_in_provider === "anonymous") {
      const e = new Error("Entre com uma conta válida para gerenciar integrações.");
      e.status = 401;
      throw e;
    }
    return { uid: decoded.uid, db: services.db };
  } catch (error) {
    if (error.status) throw error;
    const e = new Error("Não foi possível validar sua sessão. Entre novamente.");
    e.status = 401;
    throw e;
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

function requiredString(obj, key, label, maxLength) {
  const value = typeof obj[key] === "string" ? obj[key].trim() : "";
  if (!value) {
    const e = new Error("Preencha o campo: " + label + ".");
    e.status = 400;
    throw e;
  }
  if (value.length > maxLength) {
    const e = new Error("O campo " + label + " ultrapassa o limite permitido.");
    e.status = 400;
    throw e;
  }
  return value;
}

async function remoteJson(url, options) {
  let response;
  try {
    response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(9000) }, options || {}));
  } catch (_) {
    const e = new Error("Não foi possível alcançar a API da plataforma. Verifique a rede e tente novamente.");
    e.status = 502;
    throw e;
  }
  let data = {};
  const text = await response.text();
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!response.ok) {
    let message = "A plataforma recusou a credencial (HTTP " + response.status + ").";
    if (response.status === 401 || response.status === 403) {
      message = "A credencial foi recusada. Confira o token, as permissões e se ele não expirou.";
    } else if (response.status === 404) {
      message = "O recurso não foi encontrado. Confira o endereço ou as permissões da credencial.";
    } else if (response.status === 429) {
      message = "A plataforma limitou temporariamente as requisições. Tente novamente mais tarde.";
    }
    const e = new Error(message);
    e.status = response.status === 401 || response.status === 403 ? 400 : 502;
    throw e;
  }
  return data;
}

async function verifyCredentials(provider, input) {
  let data;
  let label = PROVIDERS[provider].name;

  if (provider === "github") {
    const token = requiredString(input, "token", "token de acesso do GitHub", 4096);
    data = await remoteJson("https://api.github.com/user", { headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Forja-AI-Integrations"
    }});
    label = data.login ? "@" + data.login : label;
    return { credentials: { token }, accountLabel: label, scopes: "API GitHub validada" };
  }

  if (provider === "vercel") {
    const token = requiredString(input, "token", "token de acesso da Vercel", 4096);
    data = await remoteJson("https://api.vercel.com/v2/user", { headers: {
      "Authorization": "Bearer " + token,
      "User-Agent": "Forja-AI-Integrations"
    }});
    label = data.user && (data.user.username || data.user.name) || data.username || label;
    return { credentials: { token }, accountLabel: label, scopes: "API Vercel validada" };
  }

  if (provider === "gitlab") {
    const token = requiredString(input, "token", "token de acesso do GitLab", 4096);
    data = await remoteJson("https://gitlab.com/api/v4/user", { headers: {
      "PRIVATE-TOKEN": token,
      "User-Agent": "Forja-AI-Integrations"
    }});
    label = data.username ? "@" + data.username : label;
    return { credentials: { token }, accountLabel: label, scopes: "API GitLab validada" };
  }

  if (provider === "openai") {
    const apiKey = requiredString(input, "apiKey", "chave de API da OpenAI", 4096);
    data = await remoteJson("https://api.openai.com/v1/models", { headers: { "Authorization": "Bearer " + apiKey } });
    return { credentials: { apiKey }, accountLabel: (data.data && data.data.length ? data.data.length + " modelos disponíveis" : "Chave válida"), scopes: "API de modelos validada" };
  }

  if (provider === "gemini") {
    const apiKey = requiredString(input, "apiKey", "chave de API do Gemini", 4096);
    data = await remoteJson("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(apiKey), {});
    return { credentials: { apiKey }, accountLabel: (data.models && data.models.length ? data.models.length + " modelos disponíveis" : "Chave válida"), scopes: "API Gemini validada" };
  }

  if (provider === "anthropic") {
    const apiKey = requiredString(input, "apiKey", "chave de API da Anthropic", 4096);
    data = await remoteJson("https://api.anthropic.com/v1/models", { headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }});
    return { credentials: { apiKey }, accountLabel: (data.data && data.data.length ? data.data.length + " modelos disponíveis" : "Chave válida"), scopes: "API Anthropic validada" };
  }

  if (provider === "supabase") {
    const projectUrl = requiredString(input, "projectUrl", "URL do projeto Supabase", 512).replace(/\/+$/, "");
    const anonKey = requiredString(input, "anonKey", "chave publishable/anon do Supabase", 4096);
    let parsedUrl;
    try { parsedUrl = new URL(projectUrl); } catch (_) {}
    if (!parsedUrl || parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(".supabase.co")) {
      const e = new Error("Use a URL HTTPS do projeto, por exemplo https://seu-projeto.supabase.co.");
      e.status = 400;
      throw e;
    }
    await remoteJson(projectUrl + "/auth/v1/settings", { headers: {
      "apikey": anonKey,
      "Authorization": "Bearer " + anonKey
    }});
    label = parsedUrl.hostname.split(".")[0];
    return { credentials: { projectUrl, anonKey }, accountLabel: label, scopes: "Endpoint de Auth validado" };
  }

  if (provider === "stripe") {
    const secretKey = requiredString(input, "secretKey", "chave secreta da Stripe", 4096);
    if (!/^(sk_live_|sk_test_|rk_live_|rk_test_)/.test(secretKey)) {
      const e = new Error("A chave Stripe deve ser uma chave secreta (sk_...) ou restrita (rk_...).");
      e.status = 400;
      throw e;
    }
    data = await remoteJson("https://api.stripe.com/v1/account", { headers: {
      "Authorization": "Basic " + Buffer.from(secretKey + ":", "utf8").toString("base64")
    }});
    label = data.business_profile && data.business_profile.name || data.email || data.id || label;
    return { credentials: { secretKey }, accountLabel: label, scopes: "Conta Stripe validada" };
  }

  if (provider === "mercadopago") {
    const accessToken = requiredString(input, "accessToken", "Access Token do Mercado Pago", 4096);
    data = await remoteJson("https://api.mercadopago.com/users/me", { headers: { "Authorization": "Bearer " + accessToken } });
    label = data.nickname || data.email || (data.id ? "Conta " + data.id : label);
    return { credentials: { accessToken }, accountLabel: label, scopes: "Conta Mercado Pago validada" };
  }

  if (provider === "resend") {
    const apiKey = requiredString(input, "apiKey", "chave de API do Resend", 4096);
    data = await remoteJson("https://api.resend.com/domains", { headers: { "Authorization": "Bearer " + apiKey } });
    return { credentials: { apiKey }, accountLabel: (data.data && data.data.length ? data.data.length + " domínio(s)" : "Chave válida"), scopes: "API Resend validada" };
  }

  if (provider === "groq") {
    const apiKey = requiredString(input, "apiKey", "chave de API da Groq", 4096);
    data = await remoteJson("https://api.groq.com/openai/v1/models", { headers: { "Authorization": "Bearer " + apiKey } });
    return { credentials: { apiKey }, accountLabel: (data.data && data.data.length ? data.data.length + " modelos disponíveis" : "Chave válida"), scopes: "API Groq validada" };
  }

  if (provider === "openrouter") {
    const apiKey = requiredString(input, "apiKey", "chave de API do OpenRouter", 4096);
    data = await remoteJson("https://openrouter.ai/api/v1/key", { headers: { "Authorization": "Bearer " + apiKey } });
    return { credentials: { apiKey }, accountLabel: data.data && (data.data.label || data.data.name) || "Chave válida", scopes: "API OpenRouter validada" };
  }

  const e = new Error("Esta integração ainda não possui um conector ativo.");
  e.status = 400;
  throw e;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return send(res, 405, { error: "Método não permitido." });
  }

  const action = String(req.query && req.query.action || "list");
  try {
    const session = await requireUser(req);
    const userRef = session.db.collection("users").doc(session.uid);
    const integrationsRef = userRef.collection("integrations");

    if (req.method === "GET" && action === "list") {
      const snapshot = await integrationsRef.get();
      const integrations = {};
      snapshot.docs.forEach(function(doc) {
        const value = doc.data() || {};
        if (!PROVIDERS[doc.id] || value.status !== "connected") return;
        integrations[doc.id] = {
          provider: doc.id,
          status: "connected",
          accountLabel: String(value.accountLabel || PROVIDERS[doc.id].name),
          connectedAt: value.connectedAt && value.connectedAt.toDate ? value.connectedAt.toDate().toISOString() : null,
          lastValidatedAt: value.lastValidatedAt && value.lastValidatedAt.toDate ? value.lastValidatedAt.toDate().toISOString() : null
        };
      });
      return send(res, 200, { integrations });
    }

    if (req.method === "POST" && action === "connect") {
      const body = parseBody(req);
      const provider = String(body.provider || "");
      if (!PROVIDERS[provider]) return send(res, 400, { error: "Plataforma não reconhecida." });
      const result = await verifyCredentials(provider, body.credentials || {});
      const ref = integrationsRef.doc(provider);
      const existing = await ref.get();
      const now = admin.firestore.FieldValue.serverTimestamp();
      const record = {
        provider: provider,
        status: "connected",
        kind: PROVIDERS[provider].kind,
        accountLabel: String(result.accountLabel || PROVIDERS[provider].name).slice(0, 180),
        scopes: String(result.scopes || "Validado").slice(0, 180),
        encryptedCredentials: encryptCredentials(result.credentials),
        updatedAt: now,
        lastValidatedAt: now
      };
      if (!existing.exists) record.connectedAt = now;
      await ref.set(record, { merge: true });
      return send(res, 200, {
        ok: true,
        provider: provider,
        status: "connected",
        accountLabel: record.accountLabel,
        message: "Credencial validada pela plataforma e guardada criptografada no servidor."
      });
    }

    if (req.method === "POST" && action === "disconnect") {
      const body = parseBody(req);
      const provider = String(body.provider || "");
      if (!PROVIDERS[provider]) return send(res, 400, { error: "Plataforma não reconhecida." });
      await integrationsRef.doc(provider).delete();
      return send(res, 200, { ok: true, provider: provider, status: "disconnected" });
    }

    return send(res, 404, { error: "Ação de integração não encontrada." });
  } catch (error) {
    if (error && error.code === "SERVER_SETUP_REQUIRED") {
      return send(res, 503, {
        code: "SERVER_SETUP_REQUIRED",
        error: error.message,
        setup: [
          "FIREBASE_SERVICE_ACCOUNT_JSON",
          "INTEGRATIONS_ENCRYPTION_KEY"
        ]
      });
    }
    const status = Number(error && error.status) || 500;
    if (status >= 500) {
      return send(res, status, { error: "Não foi possível concluir a operação. Tente novamente e confira os logs do servidor." });
    }
    return send(res, status, { error: error.message || "Não foi possível concluir a operação." });
  }
};
