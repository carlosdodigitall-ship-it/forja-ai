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

  try {
    const upstream = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent", {
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

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = payload && payload.error && payload.error.message;
      const status = upstream.status === 429 ? 429 : (upstream.status >= 400 && upstream.status < 500 ? 400 : 502);
      return res.status(status).json({
        error: upstream.status === 429
          ? "O limite de uso da API Gemini foi atingido. Aguarde e tente novamente ou confira as cotas do seu projeto."
          : "O Google Gemini não conseguiu gerar o aplicativo." + (detail ? " Detalhe: " + detail : "")
      });
    }

    const candidate = payload.candidates && payload.candidates[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    let generated = Array.isArray(parts) ? parts.map(function (part) { return part.text || ""; }).join("\n").trim() : "";
    generated = generated.replace(new RegExp("^" + String.fromCharCode(96).repeat(3) + "(?:html)?\\s*", "i"), "").replace(new RegExp("\\s*" + String.fromCharCode(96).repeat(3) + "$"), "").trim();

    if (!generated) {
      return res.status(502).json({ error: "O Gemini não retornou código. Tente descrever o aplicativo com mais detalhes." });
    }
    if (!/<!doctype html|<html[\s>]/i.test(generated)) {
      generated = "<!doctype html>\n<html lang=\"pt-BR\">\n<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>Aplicativo Forja AI</title></head>\n<body>\n" + generated + "\n</body>\n</html>";
    }

    return res.status(200).json({ code: generated, model: "gemini-3.8-flash" });
  } catch (error) {
    return res.status(500).json({ error: "Falha ao conectar com o Google Gemini. Verifique a conexão e tente novamente." });
  }
};
