"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeProvider, selectProvider } = require("../lib/ai/provider-policy");

test("aceita os provedores permitidos", () => {
  for (const name of ["gemini", "openai", "anthropic", "groq", "openrouter", "auto"]) {
    assert.equal(normalizeProvider(name), name);
  }
});

test("normaliza espaços e letras maiúsculas", () => {
  assert.equal(normalizeProvider(" OpenAI "), "openai");
});

test("rejeita provedor desconhecido", () => {
  assert.throws(() => normalizeProvider("criefy"), { code: "UNSUPPORTED_PROVIDER" });
});

test("não permite selecionar provedor sem credencial", () => {
  assert.throws(() => selectProvider("anthropic", { gemini: true }), { code: "PROVIDER_NOT_CONNECTED" });
});

test("seleção automática segue prioridade configurada", () => {
  assert.equal(selectProvider("auto", { openai: true, gemini: true }), "gemini");
  assert.equal(selectProvider("auto", { openai: true, gemini: true }, ["openai", "gemini"]), "openai");
});

test("não permite geração sem provedores disponíveis", () => {
  assert.throws(() => selectProvider("auto", {}), { code: "NO_PROVIDER" });
});

test("rejeita configuração inválida", () => {
  assert.throws(() => selectProvider("auto", null), { code: "INVALID_CONFIGURATION" });
});
