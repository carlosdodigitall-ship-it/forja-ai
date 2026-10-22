# Forja AI V2 — implantação segura dos créditos

## Estado atual
- O ledger transacional e o adaptador de cobrança foram implementados, mas **não** estão conectados a `/api/generate`.
- A flag `FORJA_CREDITS_V2_ENABLED` é **false** por padrão. Defini-la como true sozinha **não** ativa cobrança: falta conectar o fluxo de geração.
- Nenhuma carteira real é criada ou alterada pelos módulos enquanto não forem invocados.
- Não definir a flag em produção até completar os itens abaixo.

## Fluxo proposto para /api/generate
1. Validar Firebase ID token, extrair UID do token verificado (nunca do corpo da requisição).
2. Validar payload, custo no servidor e saldo.
3. Reservar créditos com operação gerada no servidor.
4. Iniciar chamada ao provedor e consumir streaming.
5. Validar HTML final e registrar resultado da geração.
6. Confirmar a reserva **antes** de emitir evento SSE `done`.
7. Em erro antes do sucesso, estornar a reserva, emitindo erro somente após concluir o estorno ou registrar falha de reconciliação.
8. Em queda de conexão ou timeout, marcar resultado como incerto; reconciliar com o estado persistido. Não presumir que a operação falhou apenas porque o cliente desconectou.

## Recuperação de reservas órfãs (a implementar)
- Registrar em cada operação `leaseExpiresAt`, `lastHeartbeatAt`, `generationId`, `resultId` e `status`.
- Executar worker agendado com autenticação própria e privilégio mínimo.
- Buscar reservas expiradas, revalidar a geração e seu resultado persistido.
- Se existe resultado validado e persistido, confirmar; se não existe e a execução foi comprovadamente encerrada, estornar.
- Usar transações para transições idempotentes; não estornar jobs ativos, mesmo que a resposta HTTP tenha caído.
- Alertar sobre reservas que não podem ser classificadas automaticamente.
- Testar concorrência real no Firebase Emulator; mocks unitários não provam isolamento transacional.

## Bloqueadores antes de ativar
- Regras de segurança: somente backend confiável pode alterar carteiras/operações.
- Provisionamento de carteira e concessão de créditos por webhook de pagamento verificado.
- Definir custos por tipo de operação e plano; limites por usuário e por minuto.
- Persistência do resultado da geração antes de cobrar.
- Testes de stream interrompido, crash, retries e múltiplas instâncias.
- Verificar limites de duração e custo da função na Vercel.
