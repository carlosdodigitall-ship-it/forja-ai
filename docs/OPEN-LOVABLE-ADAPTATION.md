# Open Lovable — engenharia reversa e plano de adaptação

## Objetivo

Aproveitar padrões técnicos do [Firecrawl Open Lovable](https://github.com/firecrawl/open-lovable) sem substituir a aplicação atual da Forja AI, sua autenticação Firebase, o banco existente ou as rotas de publicação da Vercel.

## Inspeção realizada

Foram examinados a árvore de arquivos do Open Lovable, README, package.json, licença MIT e as rotas/componentes centrais para:

- geração de código por streaming: `app/api/generate-ai-code-stream/route.ts`;
- edição incremental de arquivos: `app/api/apply-ai-code-stream/route.ts`;
- provisionamento de ambiente React isolado: `app/api/create-ai-sandbox-v2/route.ts`;
- exibição da prévia: `components/SandboxPreview.tsx`.

Na Forja AI, foram inspecionados `index.html`, `package.json`, `api/generate.js`, `api/chat.js` e `api/integrations.js`.

## Diferenças arquiteturais importantes

- A Forja AI atual é uma aplicação HTML estática com funções serverless em `api/`; o Open Lovable é um aplicativo Next.js/React com vários serviços de sandbox.
- A geração atual da Forja AI retorna um documento HTML único com CSS/JavaScript incorporados. O Open Lovable gera vários arquivos de projeto e instala dependências.
- A autenticação de geração já usa tokens do Firebase Authentication. O armazenamento de credenciais de integrações usa Firebase Admin e criptografia no servidor; essas credenciais não devem ser exigidas para a chave global `GEMINI_API_KEY`.
- O Open Lovable utiliza Firecrawl para extrair referências de sites e um sandbox (Vercel Sandbox ou E2B) para executar projetos React. Esses serviços não são equivalentes a uma simples prévia HTML em iframe.

## Implementação inicial nesta branch

A rota `api/generate.js` agora reconhece pedidos explícitos de recriação/ inspiração que contenham uma URL HTTPS pública. Quando a variável opcional `FIRECRAWL_API_KEY` está configurada, consulta a API de scraping do Firecrawl, limita o contexto extraído e o adiciona ao prompt da geração existente.

Proteções incluídas:

- a funcionalidade é opcional; pedidos normais sem intenção de recriação continuam usando o fluxo atual;
- não aceita URL sem HTTPS nem hosts locais/privados conhecidos;
- define timeout para a chamada externa e limita o conteúdo de referência a 16.000 caracteres;
- trata o texto da página como dado não confiável e instrui o modelo a ignorar instruções embutidas no site;
- não envia a chave Firecrawl ao navegador;
- não altera o Firebase, o login nem a estrutura de projetos existentes.

## Configuração para testar a nova capacidade

Na Vercel, em **Settings → Environment Variables**, adicione:

- `FIRECRAWL_API_KEY`: chave obtida no painel do Firecrawl.

Depois, faça um novo deploy. Exemplo de pedido: `Recrie o estilo visual deste site, sem copiar literalmente textos ou marca: https://exemplo.com`.

A chave Firecrawl é opcional e pode estar sujeita a cobrança/limites próprios. Sem ela, a geração normal por descrição permanece disponível; somente a recriação por URL retorna uma mensagem de configuração.

## Próximas etapas antes de chamar a integração de completa

1. Testar em ambiente de preview a geração normal e a geração por URL com chaves válidas.
2. Acrescentar uma entrada dedicada de URL na interface, em vez de exigir que a URL esteja dentro da descrição.
3. Implementar armazenamento/versionamento de arquivos de projeto no Firestore usando o UID autenticado e regras de acesso por proprietário.
4. Implementar sandbox por projeto, com isolamento e encerramento de processos, antes de permitir execução de React/npm gerado pela IA.
5. Adicionar detecção de erros de build/runtime e ciclos de correção por chat.
6. Validar exportação, sincronização GitHub e publicação Vercel sem expor tokens ao cliente.

## Licença

O Open Lovable declara licença MIT. Esta primeira etapa adapta o comportamento de referência e não copia seus componentes ou rotas. Qualquer reutilização futura de trechos substanciais deve preservar o aviso de copyright e a licença do projeto original.
