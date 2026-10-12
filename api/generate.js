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
    "Transforme a descrição do usuário em um aplicativo front-end funcional, bonito, consistente e pronto para demonstração.",
    "Priorize qualidade e completude em vez de responder com uma versão mínima ou apressada. Analise os requisitos e construa todas as seções relevantes antes de finalizar.",
    "Retorne somente um documento HTML completo, sem Markdown e sem cercas de código.",
    "Inclua CSS e JavaScript no próprio HTML, sem dependências de build ou bibliotecas externas obrigatórias.",
    "Use português brasileiro na interface. Inclua meta viewport, layouts fluidos, breakpoints para celular/tablet/desktop e evite overflow horizontal.",
    "Implemente as interações principais com JavaScript real; não crie botões decorativos sem comportamento. Verifique mentalmente a consistência dos seletores, eventos, navegação e estados antes de retornar o HTML.",
    "Quando o pedido for amplo, entregue uma interface substancial: hierarquia visual clara, estados vazios, mensagens de feedback, acessibilidade básica e conteúdo de exemplo coerente. Não invente uma integração real quando faltarem credenciais.";
    "Se o pedido envolver dados ou serviços externos não configurados, use dados de demonstração claramente identificados e não finja que existe uma integração real.",
    "Não inclua segredos, chaves API ou credenciais no HTML gerado."
  ].join(" ");

  // Prioriza o modelo principal e usa modelos atuais alternativos somente se o Google
  // responder com indisponibilidade/capacidade, antes de iniciar o streaming.
  const models = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"];
  let upstream;
  let model = models[0];
  let lastDetail = "";
  for (const candidate of models) {
    model = candidate;
    try {
      upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + candidate + ":streamGenerateContent?alt=sse", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 8192, responseMimeType: "text/plain" }
        })
      });
    } catch (e) {
      lastDetail = "Falha de conexão ao tentar " + candidate + ".";
      continue;
    }

    if (upstream.ok) break;

    const payload = await upstream.json().catch(() => ({}));
    lastDetail = payload && payload.error && payload.error.message
      ? payload.error.message
      : "O serviço retornou HTTP " + upstream.status + ".";

    // Não tenta outros modelos quando o problema é credencial, permissão ou entrada.
    if (![408, 429, 500, 502, 503, 504].includes(upstream.status)) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status;
      return res.status(status).json({ error: "O Google Gemini recusou a solicitação. " + lastDetail });
    }
  }

  if (!upstream || !upstream.ok) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(503).json({
      error: "Os modelos Gemini disponíveis estão temporariamente sem capacidade. A Forja AI tentou os modelos atuais alternativos. Aguarde um pouco e tente novamente. Detalhe: " + lastDetail
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
      const blocks = rawBuffer.split(/\r?\n\r?\n/);
      rawBuffer = blocks.pop() || "";
      for (const block of blocks) {
        const dataLine = block.split(/\r?\n/).find(line => line.startsWith("data:"));
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
