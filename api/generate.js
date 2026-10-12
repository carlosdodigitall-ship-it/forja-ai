module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");

  if (req.method !== "POST") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).json({ error: "A variável GEMINI_API_KEY não foi encontrada na Vercel. Confira Settings > Environment Variables e faça um novo deploy." });
  }

  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(400).json({ error: "Descreva o aplicativo que deseja criar." });
  }
  if (prompt.length > 12000) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(413).json({ error: "A descrição é muito longa. Use até 12.000 caracteres." });
  }

  const systemInstruction = [
    "Você é o mecanismo de geração de aplicativos da Forja AI.",
    "Transforme a descrição do usuário em um aplicativo front-end funcional, bonito e responsivo.",
    "Retorne somente um documento HTML completo, sem Markdown e sem cercas de código.",
    "Inclua CSS e JavaScript no próprio HTML, sem dependências de build ou bibliotecas externas obrigatórias.",
    "Use português brasileiro na interface. Faça o layout adaptável a celular e desktop.",
    "Implemente as interações principais com JavaScript real; não crie botões decorativos sem comportamento.",
    "Se o pedido envolver dados ou serviços externos não configurados, use dados de demonstração claramente identificados e não finja que existe uma integração real.",
    "Não inclua segredos, chaves API ou credenciais no HTML gerado."
  ].join(" ");

  const model = "gemini-3.8-flash";
  let upstream;
  try {
    upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: 8192, responseMimeType: "text/plain" }
      })
    });
  } catch (e) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(503).json({ error: "Não foi possível conectar ao serviço do Google Gemini. Tente novamente." });
  }

  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => ({}));
    const detail = payload && payload.error && payload.error.message ? payload.error.message : "O serviço retornou HTTP " + upstream.status + ".";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    const status = upstream.status === 429 ? 429 : (upstream.status === 401 || upstream.status === 403 ? 502 : 400);
    return res.status(status).json({
      error: upstream.status === 429
        ? "O limite de uso ou a capacidade do Gemini foi atingido. Aguarde e tente novamente. " + detail
        : "O Google Gemini recusou a solicitação. " + detail
    });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders && res.flushHeaders();

  function send(event) {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  }

  let rawBuffer = "";
  let generated = "";
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    let done = false;
    while (!done) {
      const part = await reader.read();
      done = part.done;
      rawBuffer += decoder.decode(part.value || new Uint8Array(), { stream: !done });
      const blocks = rawBuffer.split("\n\n");
      rawBuffer = blocks.pop() || "";
      for (const block of blocks) {
        const dataLine = block.split("\n").find(line => line.startsWith("data:"));
        if (!dataLine) continue;
        let chunk;
        try { chunk = JSON.parse(dataLine.slice(5).trim()); } catch (e) { continue; }
        const parts = chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts;
        const text = Array.isArray(parts) ? parts.map(part => part.text || "").join("") : "";
        if (text) {
          generated += text;
          send({ type: "chunk", text: text });
        }
        const finish = chunk.candidates && chunk.candidates[0] && chunk.candidates[0].finishReason;
        if (finish && finish !== "STOP" && finish !== "MAX_TOKENS") {
          send({ type: "error", error: "O Gemini encerrou a geração: " + finish });
          return res.end();
        }
      }
    }

    generated = generated
      .replace(/^\u0060{3}(?:html)?\s*/i, "")
      .replace(/\s*\u0060{3}$/, "")
      .trim();
    if (!generated) {
      send({ type: "error", error: "O Gemini não retornou código HTML. Tente novamente." });
      return res.end();
    }
    if (!/<!doctype html|<html[\s>]/i.test(generated)) {
      generated = "<!doctype html>\n<html lang=\"pt-BR\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Aplicativo Forja AI</title></head>\n<body>\n" + generated + "\n</body>\n</html>";
    }
    send({ type: "done", code: generated, model: model });
    return res.end();
  } catch (e) {
    try { send({ type: "error", error: "A conexão com o Gemini foi interrompida durante a geração. Tente novamente." }); } catch (_) {}
    return res.end();
  }
};
