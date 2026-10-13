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
    const selected = await generator.resolveProvider(req, "gemini");
    const models = (process.env.FORJA_GEMINI_MODELS || "gemini-3.8-flash,gemini-3.6-flash").split(",").map(function (v) { return v.trim(); }).filter(Boolean);
    let lastError = "";
    for (const model of models) {
      let response;
      try {
        response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": selected.credentials.apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SUPPORT_INSTRUCTION }] },
            contents: safeMessages,
            generationConfig: { temperature: 0.4, maxOutputTokens: 1200 }
          }),
          signal: AbortSignal.timeout(25000)
        });
      } catch (_) {
        lastError = "Não consegui conectar ao Gemini agora. Tente novamente em instantes.";
        continue;
      }
      if (response.ok) {
        const data = await response.json();
        const answer = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
          ? data.candidates[0].content.parts.map(function (part) { return part.text || ""; }).join("").trim()
          : "";
        if (!answer) return res.status(502).json({ error: "A IA não retornou uma resposta. Tente enviar a mensagem novamente." });
        return res.status(200).json({ answer: answer, model: model });
      }
      const data = await response.json().catch(function () { return {}; });
      lastError = data && data.error && data.error.message ? String(data.error.message).slice(0, 240) : "HTTP " + response.status;
      if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
    }
    return res.status(502).json({ error: "O chat não conseguiu responder: " + (lastError || "provedor indisponível") });
  } catch (error) {
    return res.status(Number(error && error.status) || 500).json({
      error: error && error.message ? error.message : "Falha ao abrir o chat de suporte."
    });
  }
};
