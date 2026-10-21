"use strict";

const PROVIDERS = Object.freeze(["gemini", "openai", "anthropic", "groq", "openrouter"]);

class ProviderSelectionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ProviderSelectionError";
    this.code = code;
    this.status = 400;
  }
}

function normalizeProvider(value) {
  if (typeof value !== "string") throw new ProviderSelectionError("Provedor inválido.", "INVALID_PROVIDER");
  const provider = value.trim().toLowerCase();
  if (provider !== "auto" && !PROVIDERS.includes(provider)) {
    throw new ProviderSelectionError("Provedor de IA não suportado.", "UNSUPPORTED_PROVIDER");
  }
  return provider;
}

function selectProvider(requested, available, priority = PROVIDERS) {
  const provider = normalizeProvider(requested);
  if (!available || typeof available !== "object" || Array.isArray(available)) {
    throw new ProviderSelectionError("Configuração de provedores inválida.", "INVALID_CONFIGURATION");
  }
  if (provider !== "auto") {
    if (!available[provider]) throw new ProviderSelectionError("A IA selecionada não está conectada.", "PROVIDER_NOT_CONNECTED");
    return provider;
  }
  for (const candidate of priority) {
    if (PROVIDERS.includes(candidate) && available[candidate]) return candidate;
  }
  throw new ProviderSelectionError("Nenhuma IA está conectada.", "NO_PROVIDER");
}

module.exports = { PROVIDERS, ProviderSelectionError, normalizeProvider, selectProvider };
