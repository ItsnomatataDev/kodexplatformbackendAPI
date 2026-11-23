# KODEX AI Workspace Ubuntu Gateway chat (Phase E)

Feature-flagged backend integration of `POST /api/ai/chat` with the verified Ubuntu AI Gateway multi-turn contract. Default **off**. Content Studio vision (`KODEX_AI_GATEWAY_ENABLED`) is unchanged and independent.

## Configuration

| Variable | Default | Role |
| --- | --- | --- |
| `KODEX_AI_WORKSPACE_GATEWAY_ENABLED` | `false` | Workspace `/api/ai/chat` only |
| `KODEX_AI_GATEWAY_ENABLED` | `false` | Content Studio `analyze-media` only |
| `KODEX_AI_GATEWAY_BASE_URL` | required if either flag is true | e.g. `http://127.0.0.1:13100` |
| `KODEX_AI_GATEWAY_TOKEN` | required if either flag is true | Restricted `kodex-platform` application credential (`ai:chat:kodex`). Not `local-development`. |
| `KODEX_AI_GATEWAY_TIMEOUT_MS` | `30000` | Chat timeout |

Flag off: existing `LLM_*` completions path.

Flag on: typed Ubuntu client only. **No silent fallback** to OpenAI-compatible LLM after a gateway failure.

Do not set the workspace flag in production as part of this sprint.

## Context builder

`src/ai/gateway-context.ts` builds `messages[]` from the authenticated user's Postgres thread:

1. Load latest-N chronological history with **org + user** ownership (Phase B).
2. Drop stored `role=system` rows. Inject the **server** trusted KODEX / assistant `system_prompt`.
3. Drop unmatched historical user turns (failed inference). Do not invent assistant text.
4. Include the latest user message **once** (strip the trailing persisted copy, then append it).
5. Keep a **suffix** of complete user/assistant turns that fits the gateway budget.
6. Reject the current user message (HTTP 400) if it, or it plus the system prompt, exceeds limits. Do not truncate it.

### 2,048-byte budget

The Ubuntu contract counts **all** supplied messages, including the trusted system prompt:

- Max **20** messages
- Max **1,024** UTF-8 bytes per message
- Max **2,048** UTF-8 bytes **total**

The default system prompt is ~70 bytes. After system + current user, leftover budget is often only one or two short prior turns. Long threads therefore send recent suffix only. The 20-message cap is rarely the binding constraint versus 2,048 bytes.

## Gateway mapping

Request:

```json
{
  "assistant": "kodex",
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" },
    { "role": "user", "content": "…" }
  ]
}
```

No `model`, `tools`, or client-originated trusted system. UI assistant names are not Ubuntu identities.

Response `{ assistant, model, reply }` is normalized to `{ assistant, message, model }` using **`reply` first**.

Single-turn `chat({ message })` remains for Content Studio / smoke tooling and still requires `KODEX_AI_GATEWAY_ENABLED`.

## Errors and retry

| Gateway | HTTP to workspace client | Persistence |
| --- | --- | --- |
| 401 | `503 KODEX_AI_GATEWAY_UNAUTHORIZED` | User row kept; no assistant row |
| 403 | `503 KODEX_AI_GATEWAY_FORBIDDEN` | same |
| 429 | `503 KODEX_AI_GATEWAY_OVERLOADED` | same |
| timeout | `504 KODEX_AI_GATEWAY_TIMEOUT` | same |
| 5xx / network | `503 KODEX_AI_GATEWAY_UNAVAILABLE` | same |
| Oversized current input | `400 VALIDATION_ERROR` | User row may already exist; retry after shortening |

Retry the same `threadId` + message (`clientMessageId` optional). Phase B pending-user reuse still applies. Logs emit operation/status/code only — no token, no transcript.

Frontend envelope is unchanged: `{ reply, conversationId, threadId, assistantMessage }`.

## Local integration (optional)

Backend only. Requires the Mac SSH tunnel to Ubuntu `127.0.0.1:3100` → local `127.0.0.1:13100`, and a dedicated `kodex-platform` credential.

1. Leave production flags false.
2. In a **gitignored** local env: `KODEX_AI_WORKSPACE_GATEWAY_ENABLED=true`, URL, token. Keep `KODEX_AI_GATEWAY_ENABLED=false` unless testing vision separately.
3. `npm run test:ai-workspace` and `npm run typecheck`.
4. Optional live call: `POST /api/ai/chat` with an authenticated workspace session while the tunnel is up.
5. Do **not** restart Ubuntu systemd or deploy.

## Production and networking blockers

- Hetzner cannot use the Mac SSH tunnel. Workspace flag-on in production has no private path to the Ubuntu gateway.
- Do not expose the gateway on a public network.
- Do not rotate Ubuntu credentials in this sprint.
- Team-chat `@kodex` still uses `llmChatText`. Content Studio vision still uses `KODEX_AI_GATEWAY_ENABLED` only.
- Ubuntu gateway process was not restarted or redeployed here.
