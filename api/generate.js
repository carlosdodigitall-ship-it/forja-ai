const admin = require("firebase-admin");
const crypto = require("crypto");

const AI_PROVIDERS = ["gemini", "openai", "anthropic", "groq", "openrouter"];

const SYSTEM_INSTRUCTION = [
  "Você é o mecanismo de geração de aplicativos da Forja AI.",
  "Transforme a descrição do usuário em um aplicativo front-end funcional, bonito, consistente e pronto para demonstração.",
  "Priorize qualidade e completude em vez de responder com uma versão mínima ou apressada. Analise os requisitos e construa todas as seções relevantes antes de finalizar.",
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

function getBearer(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function resolveProvider(req, requested) {
  const environmentKey = process.env.GEMINI_API_KEY;
  const idToken = getBearer(req);

  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !process.env.INTEGRATIONS_ENCRYPTION_KEY) {
    if (requested === "auto" && environmentKey) {
      return { provider: "gemini", credentials: { apiKey: environmentKey }, fromEnvironment: true };
    }
    throw new Error("SETUP_REQUIRED");
  }
  if (!idToken) {
    if (requested === "auto" && environmentKey) {
      return { provider: "gemini", credentials: { apiKey: environmentKey }, fromEnvironment: true };
    }
    const e = new Error("Entre na Forja AI para usar suas integrações.");
    e.status = 401;
    throw e;
  }

  let services;
  let user;
  try {
    services = getAdmin();
    user = await services.auth.verifyIdToken(idToken);
  } catch (error) {
    if (error.message === "SETUP_REQUIRED") {
      if (requested === "auto" && environmentKey) return { provider: "gemini", credentials: { apiKey: environmentKey }, fromEnvironment: true };
      throw error;
    }
    const e = new Error("Sua sessão expirou. Entre novamente na Forja AI.");
    e.status = 401;
    throw e;
  }
  if (!user.uid || (user.firebase && user.firebase.sign_in_provider === "anonymous")) {
    const e = new Error("Entre com uma conta válida para gerar aplicativos.");
    e.status = 401;
    throw e;
  }

  const order = requested === "auto" ? AI_PROVIDERS : [requested];
  for (const provider of order) {
    const snapshot = await services.db.collection("users").doc(user.uid).collection("integrations").doc(provider).get();
    if (!snapshot.exists) continue;
    const record = snapshot.data() || {};
    if (record.status !== "connected" || !record.encryptedCredentials) continue;
    try {
      const credentials = decryptCredentials(record.encryptedCredentials);
      if ((provider === "gemini" || provider === "openai" || provider === "anthropic" || provider === "groq" || provider === "openrouter") && (credentials.apiKey || credentials.token)) {
        return { provider: provider, credentials: credentials, model: record.model || null, accountLabel: record.accountLabel || provider };
      }
    } catch (_) {
      const e = new Error("Não foi possível ler a credencial criptografada da integração. Desconecte e conecte novamente essa plataforma.");
      e.status = 500;
      throw e;
    }
  }

  if (requested !== "auto") {
    const e = new Error("Essa IA ainda não está conectada. Abra Integrações, conecte e valide sua chave, depois tente novamente.");
    e.status = 400;
    throw e;
  }
  if (environmentKey) return { provider: "gemini", credentials: { apiKey: environmentKey }, fromEnvironment: true };
  const e = new Error("Nenhum provedor de IA conectado. Conecte Gemini, OpenAI, Anthropic, Groq ou OpenRouter em Integrações.");
  e.status = 400;
  throw e;
}

async function requestGemini(apiKey, prompt) {
  const models = (process.env.FORJA_GEMINI_MODELS || "gemini-3.8-flash,gemini-3.6-flash").split(",").map(function(v){return v.trim();}).filter(Boolean);
  let upstream;
  let detail = "";
  let selected = models[0];
  for (const candidate of models) {
    selected = candidate;
    try {
      upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(candidate) + ":streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 8192, responseMimeType: "text/plain" }
        }),
        signal: AbortSignal.timeout(60000)
      });
    } catch (_) {
      detail = "Falha de conexão ao tentar " + candidate + ".";
      continue;
    }
    if (upstream.ok) return { upstream: upstream, provider: "gemini", model: candidate };
    const data = await upstream.json().catch(function(){return {};});
    detail = data && data.error && data.error.message ? String(data.error.message).slice(0,300) : "HTTP " + upstream.status;
    if (![408,429,500,502,503,504].includes(upstream.status)) {
      const e = new Error("O Google Gemini recusou a solicitação. " + detail);
      e.status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      throw e;
    }
  }
  const e = new Error("Os modelos Gemini estão temporariamente indisponíveis. " + detail);
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
      max_tokens: 8192,
      messages: [
        { role: "system", content: SYSTEM_INSTRUCTION },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(60000)
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
    signal: AbortSignal.timeout(60000)
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
