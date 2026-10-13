const generator = require("./generate");

const SUPPORT_INSTRUCTION = [
  "Você é o assistente de suporte técnico da Forja AI.",
  "Responda em português brasileiro, de forma direta, cordial e prática.",
  "Ajude a diagnosticar travamentos, erros de geração, prévia, autenticação, integrações e layout.",
  "Não afirme que verificou logs, arquivos ou configurações se eles não foram fornecidos na conversa.",
  "Peça a mensagem exata do erro quando ela for necessária. Dê instruções em passos curtos para iniciantes.",
  "Se o usuário relatar que a geração fica carregando, diferencie problemas de sessão, provedor/modelo, conexão e renderização da prévia.",
  "Não invente que uma integração está conectada nem peça ao usuário para compartilhar chaves secretas."
].join(" ");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const messages = req.body && Array.isArray(req.body.messages) ? req.body.messages : [];
  if (!messages.length || messages.length > 12) {
    return res.status(400).json({ error: "Envie uma mensagem para iniciar o atendimento." });
  }

  const safeMessages = [];
  for (const item of messages) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") continue;
    const content = item.content.trim().slice(0, 3000);
    if (content) safeMessages.push({ role: item.role === "assistant" ? "model" : "user", parts: [{ text: content }] });
  }
  if (!safeMessages.length || safeMessages[safeMessages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Escreva sua mensagem antes de enviar." });
  }

  try {
    const selected = await generator.resolveProvider(req, "auto");
    let lastError = "";
    const provider = selected.provider;
    const model = selected.model || (provider === "gemini" ? (process.env.FORJA_GEMINI_MODEL || "gemini-3.8-flash") : provider === "anthropic" ? (process.env.FORJA_ANTHROPIC_MODEL || "claude-sonnet-4-6") : provider === "openai" ? (process.env.FORJA_OPENAI_MODEL || "gpt-4.1-mini") : provider === "groq" ? (process.env.FORJA_GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.FORJA_OPENROUTER_MODEL || "openai/gpt-4o-mini"));
    const preferredGeminiModels = ["gemini-3.8-flash","gemini-3.7-flash","gemini-3.6-flash","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-3.1-flash-lite","gemini-3-flash-preview"];
    const configuredGeminiModels = (process.env.FORJA_GEMINI_MODELS || "").split(",").map(function(v){return v.trim();}).filter(Boolean);
    if (selected.model) configuredGeminiModels.push(selected.model);
    const candidateModels = provider === "gemini"
      ? Array.from(new Set(preferredGeminiModels.concat(configuredGeminiModels))).filter(function(value){return !/^gemini-2\\.5-flash$/i.test(value);})
      : [model];
    for (const candidateModel of candidateModels) {
      let response;
      try {
        response = await fetch(provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(candidateModel) + ":generateContent" : provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : (provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : provider === "openrouter" ? "https://openrouter.ai/api/v1/chat/completions" : "https://api.openai.com/v1/chat/completions"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(provider === "gemini" ? {"x-goog-api-key": selected.credentials.apiKey} : provider === "anthropic" ? {"x-api-key": selected.credentials.apiKey, "anthropic-version":"2023-06-01"} : {"Authorization":"Bearer " + selected.credentials.apiKey}) },
          body: JSON.stringify(provider === "gemini" ? {
            systemInstruction: { parts: [{ text: SUPPORT_INSTRUCTION }] },
            contents: safeMessages,
            generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
          } : provider === "anthropic" ? {
            model: candidateModel, max_tokens: 1200, temperature: 0.4, system: SUPPORT_INSTRUCTION,
            messages: safeMessages.map(function(m){return {role:m.role === "model" ? "assistant" : "user", content:m.parts.map(function(p){return p.text;}).join("\\n")};})
          } : {
            model: candidateModel, temperature: 0.4, max_tokens: 1200,
            messages: [{role:"system",content:SUPPORT_INSTRUCTION}].concat(safeMessages.map(function(m){return {role:m.role === "model" ? "assistant" : "user",content:m.parts.map(function(p){return p.text;}).join("\\n")};}))
          }),
          signal: AbortSignal.timeout(25000)
        });
      } catch (_) {
        lastError = "Não consegui conectar ao Gemini agora. Tente novamente em instantes.";
        continue;
      }
      if (response.ok) {
        const data = await response.json();
        const answer = provider === "gemini"
          ? (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts ? data.candidates[0].content.parts.map(function(part){return part.text || "";}).join("").trim() : "")
          : provider === "anthropic"
          ? (data && Array.isArray(data.content) ? data.content.map(function(part){return part.text || "";}).join("").trim() : "")
          : (data && data.choices && data.choices[0] && data.choices[0].message ? String(data.choices[0].message.content || "").trim() : "");
        if (!answer) return res.status(502).json({ error: "A IA não retornou uma resposta. Tente enviar a mensagem novamente." });
        return res.status(200).json({ answer: answer, model: candidateModel, provider: provider });
      }
      const data = await response.json().catch(function () { return {}; });
      lastError = data && data.error && data.error.message ? String(data.error.message).slice(0, 240) : "HTTP " + response.status;
      const unavailableModel = /model .*not found|not available to new users|no longer available to new users|is not supported|unknown model|model.*not available|unsupported model/i.test(lastError);
      if (![408, 429, 500, 502, 503, 504].includes(response.status) && !unavailableModel) break;
    }
    return res.status(502).json({ error: "O chat não conseguiu responder: " + (lastError || "provedor indisponível") });
  } catch (error) {
    return res.status(Number(error && error.status) || 500).json({
      error: error && error.message ? error.message : "Falha ao abrir o chat de suporte."
    });
  }
};
