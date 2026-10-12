module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "A variável GEMINI_API_KEY não foi encontrada na Vercel. Confira Settings > Environment Variables e faça um novo deploy." });
  }

  const prompt = req.body && typeof req.body.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return res.status(400).json({ error: "Descreva o aplicativo que deseja criar." });
  if (prompt.length > 12000) return res.status(413).json({ error: "A descrição é muito longa. Use até 12.000 caracteres." });

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

  // Usa apenas o modelo atualmente recomendado para novos usuários.
  // Modelos Gemini 2.5 podem não estar disponíveis para novas contas.
  const models = ["gemini-3.8-flash"];
  let lastDetail = "";
  let lastStatus = 0;

  try {
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      let upstream;
      let payload = {};

      try {
        upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.35,
              maxOutputTokens: 8192,
              responseMimeType: "text/plain"
            }
          })
        });
        payload = await upstream.json().catch(() => ({}));
      } catch (networkError) {
        lastDetail = "Não foi possível conectar ao serviço do Google.";
        lastStatus = 503;
        continue;
      }

      if (!upstream.ok) {
        lastStatus = upstream.status;
        lastDetail = payload && payload.error && payload.error.message
          ? payload.error.message
          : "O serviço retornou HTTP " + upstream.status + ".";

        // Não tenta modelos antigos descontinuados ou indisponíveis para novas contas.
        if (![408, 429, 500, 502, 503, 504].includes(upstream.status)) {
          const status = upstream.status === 401 || upstream.status === 403 ? 502 : 400;
          return res.status(status).json({
            error: upstream.status === 429
              ? "O limite de uso da API Gemini foi atingido. Confira as cotas e o faturamento do projeto Google AI Studio."
              : "O Google Gemini recusou a solicitação. " + lastDetail
          });
        }
        continue;
      }

      const candidate = payload.candidates && payload.candidates[0];
      const parts = candidate && candidate.content && candidate.content.parts;
      let generated = Array.isArray(parts)
        ? parts.map(function (part) { return part.text || ""; }).join("\n").trim()
        : "";

      generated = generated
        .replace(new RegExp("^" + String.fromCharCode(96).repeat(3) + "(?:html)?\\s*", "i"), "")
        .replace(new RegExp("\\s*" + String.fromCharCode(96).repeat(3) + "$"), "")
        .trim();

      if (!generated) {
        lastDetail = "O modelo " + model + " não retornou código.";
        lastStatus = 502;
        continue;
      }

      if (!/<!doctype html|<html[\s>]/i.test(generated)) {
        generated = "<!doctype html>\n<html lang=\"pt-BR\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Aplicativo Forja AI</title></head>\n<body>\n" + generated + "\n</body>\n</html>";
      }

      return res.status(200).json({ code: generated, model: model });
    }

    if (lastStatus === 429) {
      return res.status(429).json({
        error: "Os modelos Gemini estão no limite de capacidade ou de cota neste momento. Aguarde alguns minutos e tente novamente. " + lastDetail
      });
    }

    return res.status(502).json({
      error: "O modelo Gemini 3.8 Flash não conseguiu gerar o aplicativo neste momento. Aguarde alguns minutos e tente novamente. Detalhe: " + lastDetail
    });
  } catch (error) {
    return res.status(500).json({ error: "Falha inesperada ao gerar o aplicativo. Tente novamente." });
  }
};
