const admin = require("firebase-admin");
const crypto = require("crypto");

const AI_PROVIDERS = ["gemini", "openai", "anthropic", "groq", "openrouter"];

const SYSTEM_INSTRUCTION = [
  "Você é o mecanismo de geração de aplicativos da Forja AI.",
  "Transforme a descrição do usuário em um aplicativo front-end funcional, bonito, consistente e pronto para demonstração.",
  "Entregue uma aplicação polida e funcional com código objetivo. Priorize as telas e interações essenciais; evite explicações, estruturas redundantes e código excessivamente longo para concluir a geração com rapidez.",
  "Retorne somente um documento HTML completo, sem Markdown e sem cercas de código.",
  "Inclua CSS e JavaScript no próprio HTML, sem dependências de build ou bibliotecas externas obrigatórias.",
  "Use português brasileiro na interface. Inclua meta viewport, layouts fluidos, breakpoints para celular/tablet/desktop e evite overflow horizontal.",
  "Implemente as interações principais com JavaScript real; não crie botões decorativos sem comportamento. Verifique mentalmente a consistência dos seletores, eventos, navegação e estados antes de retornar o HTML.",
  "Quando o pedido for amplo, entregue uma interface substancial: hierarquia visual clara, estados vazios, mensagens de feedback, acessibilidade básica e conteúdo de exemplo coerente. Não invente uma integração real quando faltarem credenciais.",
  "Se o pedido envolver dados ou serviços externos não configurados, use dados de demonstração claramente identificados e não finja que existe uma integração real.",
  "Não inclua segredos, chaves API ou credenciais no HTML gerado."
].join(" ");

function jsonError(res, status, message) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error: message });
}

function decryptCredentials(value) {
  const encodedKey = process.env.INTEGRATIONS_ENCRYPTION_KEY || "";
  if (!/^[a-fA-F0-9]{64}$/.test(encodedKey)) throw new Error("SETUP_REQUIRED");
  const parts = String(value || "").split(".");
  if (parts.length !== 3) throw new Error("INVALID_CREDENTIAL_RECORD");
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const data = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(encodedKey, "hex"), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}

function getAdmin() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("SETUP_REQUIRED");
  if (!admin.apps.length) {
    let credentials;
    try { credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch (_) { throw new Error("SETUP_REQUIRED"); }
    admin.initializeApp({ credential: admin.credential.cert(credentials) });
  }
  return { auth: admin.auth(), db: admin.firestore() };
}

let firebaseCertificates = null;
let firebaseCertificatesExpiresAt = 0;
let firebaseCertificateFetch = null;

async function verifyFirebaseIdToken(idToken) {
  const projectId = process.env.FIREBASE_PROJECT_ID || "forja-d4aef";
  const unauthorized = function () {
    const e = new Error("Sua sessão não é válida ou expirou. Entre novamente na Forja AI.");
    e.status = 401;
    return e;
  };
  if (!idToken || idToken.length > 10000) throw unauthorized();

  const parts = idToken.split(".");
  if (parts.length !== 3) throw unauthorized();
  let header, claims, signature;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    signature = Buffer.from(parts[2], "base64url");
  } catch (_) { throw unauthorized(); }
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== "RS256" || !header.kid ||
      claims.iss !== "https://securetoken.google.com/" + projectId ||
      claims.aud !== projectId ||
      typeof claims.sub !== "string" || !claims.sub ||
      claims.sub.length > 128 ||
      !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 ||
      (Number.isFinite(claims.nbf) && claims.nbf > now + 60) ||
      !Number.isFinite(claims.auth_time) || claims.auth_time > now + 60 ||
      (claims.firebase && claims.firebase.sign_in_provider === "anonymous")) {
    throw unauthorized();
  }

  if (!firebaseCertificates || Date.now() >= firebaseCertificatesExpiresAt) {
    if (!firebaseCertificateFetch) {
      firebaseCertificateFetch = (async function () {
        const response = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com", {
          signal: AbortSignal.timeout(8000),
          headers: { "Accept": "application/json" }
        });
        if (!response.ok) throw new Error("Unable to retrieve Firebase verification certificates");
        const certificates = await response.json();
        const cacheControl = response.headers.get("cache-control") || "";
        const match = cacheControl.match(/max-age=(\d+)/i);
        const maxAgeSeconds = match ? Math.max(60, Math.min(Number(match[1]), 21600)) : 300;
        firebaseCertificates = certificates;
        firebaseCertificatesExpiresAt = Date.now() + maxAgeSeconds * 1000;
        return certificates;
      })().finally(function () { firebaseCertificateFetch = null; });
    }
    try {
      await firebaseCertificateFetch;
    } catch (_) {
      const e = new Error("Não foi possível verificar sua sessão com o Firebase. Tente novamente em instantes.");
      e.status = 503;
      throw e;
    }
  }

  let certificate = firebaseCertificates && firebaseCertificates[header.kid];
  if (!certificate) {
    // Refresh certificates once when Google rotates signing keys; never recurse indefinitely.
    try {
      const response = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com", {
        signal: AbortSignal.timeout(8000),
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error("Unable to refresh Firebase verification certificates");
      const freshCertificates = await response.json();
      const cacheControl = response.headers.get("cache-control") || "";
      const match = cacheControl.match(/max-age=(\\d+)/i);
      const maxAgeSeconds = match ? Math.max(60, Math.min(Number(match[1]), 21600)) : 300;
      firebaseCertificates = freshCertificates;
      firebaseCertificatesExpiresAt = Date.now() + maxAgeSeconds * 1000;
      certificate = freshCertificates[header.kid];
    } catch (_) {
      const e = new Error("Não foi possível atualizar a validação da sessão. Tente novamente em instantes.");
      e.status = 503;
      throw e;
    }
    if (!certificate) throw unauthorized();
  }
  let publicKey;
  try { publicKey = crypto.createPublicKey(certificate); }
  catch (_) { throw unauthorized(); }
  const verified = crypto.verify(
    "RSA-SHA256",
    Buffer.from(parts[0] + "." + parts[1], "utf8"),
    publicKey,
    signature
  );
  if (!verified) throw unauthorized();
  return claims;
}

function getBearer(req) {
  const headers = req && req.headers ? req.headers : {};
  const authorization = headers.authorization || headers.Authorization || "";
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) {
    const e = new Error("Sua sessão não foi enviada. Atualize a página, entre novamente e tente criar o aplicativo.");
    e.status = 401;
    throw e;
  }
  return match[1].trim();
}

async function resolveProvider(req, requested) {
  const environmentKeys = {
    gemini: process.env.GEMINI_API_KEY || "",
    openai: process.env.OPENAI_API_KEY || ""
  };
  const idToken = getBearer(req);
  const user = await verifyFirebaseIdToken(idToken);
  const hasSecureStorage = Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON && process.env.INTEGRATIONS_ENCRYPTION_KEY);

  // Owner-managed server keys can be used by signed-in users without exposing secrets to the browser.
  if (!hasSecureStorage) {
    if (requested !== "auto" && environmentKeys[requested]) {
      return { provider: requested, credentials: { apiKey: environmentKeys[requested] }, fromEnvironment: true };
    }
    if (requested === "auto" && environmentKeys.gemini) {
      return { provider: "gemini", credentials: { apiKey: environmentKeys.gemini }, fromEnvironment: true };
    }
    if (requested === "auto" && environmentKeys.openai) {
      return { provider: "openai", credentials: { apiKey: environmentKeys.openai }, fromEnvironment: true };
    }
    throw new Error("SETUP_REQUIRED");
  }

  let services;
  try {
    services = getAdmin();
  } catch (_) {
    if (requested !== "auto" && environmentKeys[requested]) {
      return { provider: requested, credentials: { apiKey: environmentKeys[requested] }, fromEnvironment: true };
    }
    if (requested === "auto" && environmentKeys.gemini) {
      return { provider: "gemini", credentials: { apiKey: environmentKeys.gemini }, fromEnvironment: true };
    }
    if (requested === "auto" && environmentKeys.openai) {
      return { provider: "openai", credentials: { apiKey: environmentKeys.openai }, fromEnvironment: true };
    }
    throw new Error("SETUP_REQUIRED");
  }

  const order = requested === "auto" ? AI_PROVIDERS : [requested];
  for (const provider of order) {
    const snapshot = await services.db.collection("users").doc(user.sub).collection("integrations").doc(provider).get();
    if (!snapshot.exists) continue;
    const record = snapshot.data() || {};
    if (record.status !== "connected" || !record.encryptedCredentials) continue;
    try {
      const credentials = decryptCredentials(record.encryptedCredentials);
      if (AI_PROVIDERS.includes(provider) && credentials.apiKey) {
        return { provider: provider, credentials: credentials, model: record.model || null, accountLabel: record.accountLabel || provider };
      }
    } catch (_) {
      const e = new Error("Não foi possível ler a credencial criptografada da integração. Desconecte e conecte novamente essa plataforma.");
      e.status = 500;
      throw e;
    }
  }

  if (requested !== "auto") {
    if (environmentKeys[requested]) {
      return { provider: requested, credentials: { apiKey: environmentKeys[requested] }, fromEnvironment: true };
    }
    const e = new Error("Essa IA ainda não está conectada. Abra Integrações, conecte e valide sua chave, depois tente novamente.");
    e.status = 400;
    throw e;
  }
  if (environmentKeys.gemini) return { provider: "gemini", credentials: { apiKey: environmentKeys.gemini }, fromEnvironment: true };
  if (environmentKeys.openai) return { provider: "openai", credentials: { apiKey: environmentKeys.openai }, fromEnvironment: true };
  const e = new Error("Nenhum provedor de IA conectado. Conecte Gemini, OpenAI, Anthropic, Groq ou OpenRouter em Integrações.");
  e.status = 400;
  throw e;
}

async function requestGemini(apiKey, prompt) {
  // Prioriza os modelos configurados, mas mantém alternativas automáticas caso
  // um modelo esteja indisponível ou a configuração do Vercel esteja desatualizada.
  // Prioriza modelos atuais e não permite que uma variável antiga da Vercel
  // faça a aplicação tentar primeiro um modelo 2.5 indisponível para novas contas.
  const configuredModels = (process.env.FORJA_GEMINI_MODELS || "")
    .split(",").map(function(v){return v.trim();}).filter(Boolean);
  const preferredModels = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
  const models = Array.from(new Set(preferredModels.concat(configuredModels).filter(function(model){
    return !/^gemini-2\\.5-flash$/i.test(model);
  })));
  let upstream;
  let detail = "";
  const failures = [];
  for (const candidate of models) {
    try {
      upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(candidate) + ":streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 4096, responseMimeType: "text/plain" }
        }),
        signal: AbortSignal.timeout(120000)
      });
    } catch (networkError) {
      const reason = networkError && networkError.message ? String(networkError.message).slice(0, 140) : "erro de rede sem detalhes";
      detail = "Falha de conexão com " + candidate + ": " + reason;
      failures.push(detail);
      continue;
    }
    if (upstream.ok) return { upstream: upstream, provider: "gemini", model: candidate };
    const data = await upstream.json().catch(function(){return {};});
    detail = data && data.error && data.error.message ? String(data.error.message).slice(0,300) : "HTTP " + upstream.status;
    failures.push(candidate + ": " + detail);
    // Se um modelo não estiver habilitado para esta chave, tente o próximo modelo.
    // Erros de autenticação/permissão são devolvidos imediatamente; erros de modelo
    // (por exemplo, 400/404 informando que não está disponível) permitem fallback.
    const modelUnavailable = /model .*not found|not available to new users|is not supported|unknown model|model.*not available|unsupported model/i.test(detail);
    if (![408,429,500,502,503,504].includes(upstream.status) && !modelUnavailable) {
      const e = new Error("O Google Gemini recusou a solicitação. " + detail);
      e.status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      throw e;
    }
  }
  const e = new Error("Nenhum modelo Gemini respondeu. " + (failures.slice(-3).join(" | ") || detail));
  e.status = 503;
  throw e;
}

async function requestOpenAICompatible(provider, apiKey, prompt) {
  const configs = {
    openai: { url: "https://api.openai.com/v1/chat/completions", model: process.env.FORJA_OPENAI_MODEL || "gpt-4.1-mini" },
    groq: { url: "https://api.groq.com/openai/v1/chat/completions", model: process.env.FORJA_GROQ_MODEL || "llama-3.3-70b-versatile" },
    openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", model: process.env.FORJA_OPENROUTER_MODEL || "openai/gpt-4o-mini" }
  };
  const config = configs[provider];
  const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://forja-ai-gamma.vercel.app";
    headers["X-Title"] = "Forja AI";
  }
  const upstream = await fetch(config.url, {
    method: "POST",
    headers: headers,
    body: JSON.stringify({
      model: config.model,
      stream: true,
      temperature: 0.35,
      max_tokens: 4096,
      messages: [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(function(){return {};});
    const detail = data && data.error && (data.error.message || data.error) ? String(data.error.message || data.error).slice(0,350) : "HTTP " + upstream.status;
    const e = new Error("O provedor " + provider + " recusou a geração. " + detail);
    e.status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
    throw e;
  }
  return { upstream: upstream, provider: provider, model: config.model };
}

async function requestAnthropic(apiKey, prompt) {
  const model = process.env.FORJA_ANTHROPIC_MODEL || "claude-sonnet-4-6";
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 8192,
      temperature: 0.35,
      stream: true,
      system: SYSTEM_INSTRUCTION,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(function(){return {};});
    const detail = data && data.error && data.error.message ? String(data.error.message).slice(0,350) : "HTTP " + upstream.status;
    const e = new Error("A Anthropic recusou a geração. " + detail);
    e.status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
    throw e;
  }
  return { upstream: upstream, provider: "anthropic", model: model };
}

function normalizeHtml(generated) {
  let output = String(generated || "").replace(/^\u0060{3}(?:html)?\s*/i, "").replace(/\s*\u0060{3}$/, "").trim();
  if (!output) return "";
  if (!/<!doctype html|<html[\s>]/i.test(output)) {
    output = "<!doctype html>\n<html lang=\"pt-BR\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Aplicativo Forja AI</title></head>\n<body>\n" + output + "\n</body>\n</html>";
  }
  return output;
}

function startEventStream(res) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();
}

async function forwardStream(res, upstream, provider, model) {
  startEventStream(res);
  function send(event) { res.write("data: " + JSON.stringify(event) + "\n\n"); }
  let buffer = "";
  let generated = "";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    let finished = false;
    while (!finished) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        const dataLine = block.split(/\r?\n/).find(function(line){return line.startsWith("data:");});
        if (!dataLine) continue;
        const raw = dataLine.slice(5).trim();
        if (!raw || raw === "[DONE]") { if (raw === "[DONE]") finished = true; continue; }
        let chunk;
        try { chunk = JSON.parse(raw); } catch (_) { continue; }
        let text = "";
        if (provider === "gemini") {
          const parts = chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts;
          text = Array.isArray(parts) ? parts.map(function(part){return part.text || "";}).join("") : "";
          const reason = chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason;
          if (reason && reason !== "STOP" && reason !== "MAX_TOKENS") {
            send({ type: "error", error: "O Gemini encerrou a geração: " + reason });
            return res.end();
          }
        } else if (provider === "anthropic") {
          if (chunk.type === "content_block_delta" && chunk.delta && chunk.delta.type === "text_delta") text = chunk.delta.text || "";
          if (chunk.type === "error") {
            send({ type:"error", error:"A Anthropic interrompeu a geração. Verifique o limite e as permissões da chave." });
            return res.end();
          }
        } else {
          const choice = chunk.choices && chunk.choices[0];
          if (choice && choice.delta) text = typeof choice.delta.content === "string" ? choice.delta.content : "";
          if (!text && choice && choice.delta && Array.isArray(choice.delta.content)) {
            text = choice.delta.content.map(function(part){return part.text || "";}).join("");
          }
        }
        if (text) {
          generated += text;
          send({ type:"chunk", text:text });
        }
      }
    }
    generated = normalizeHtml(generated);
    if (!generated) {
      send({ type:"error", error:"O provedor terminou sem retornar código HTML. Confira o modelo e tente novamente." });
      return res.end();
    }
    send({ type:"done", code:generated, model:model, provider:provider });
    return res.end();
  } catch (_) {
    try { send({ type:"error", error:"A conexão com o provedor foi interrompida durante a geração. Tente novamente." }); } catch (_) {}
    return res.end();
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  const requested = String(req.body && req.body.provider || "auto");
  if (!prompt) return jsonError(res, 400, "Descreva o aplicativo que deseja criar.");
  if (prompt.length > 12000) return jsonError(res, 413, "A descrição é muito longa. Use até 12.000 caracteres.");
  if (requested !== "auto" && !AI_PROVIDERS.includes(requested)) return jsonError(res, 400, "Provedor de IA não suportado.");

  try {
    const selected = await resolveProvider(req, requested);
    const apiKey = selected.credentials.apiKey;
    let upstream;
    if (selected.provider === "gemini") {
      const result = await requestGemini(apiKey, prompt);
      upstream = result.upstream;
      return await forwardStream(res, upstream, result.provider, result.model);
    }
    if (selected.provider === "anthropic") {
      const result = await requestAnthropic(apiKey, prompt);
      upstream = result.upstream;
      return await forwardStream(res, upstream, result.provider, result.model);
    }
    const result = await requestOpenAICompatible(selected.provider, apiKey, prompt);
    upstream = result.upstream;
    return await forwardStream(res, upstream, result.provider, result.model);
  } catch (error) {
    if (error && error.message === "SETUP_REQUIRED") {
      return jsonError(res, 503, "Para usar chaves salvas em Integrações, configure FIREBASE_SERVICE_ACCOUNT_JSON e INTEGRATIONS_ENCRYPTION_KEY na Vercel. A chave GEMINI_API_KEY do servidor continua funcionando como alternativa automática.");
    }
    return jsonError(res, Number(error && error.status) || 500, error.message || "Falha ao preparar a geração.");
  }
};


// Reutilizado pelo endpoint de suporte para manter a mesma autenticação e seleção segura de credenciais.
module.exports.resolveProvider = resolveProvider;
