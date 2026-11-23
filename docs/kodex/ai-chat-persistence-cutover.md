# KODEX AI conversation persistence cutover (Phase C)

Backend sprint v0.6E Phase B made `/api/ai/chat` the **authoritative writer** of inference user and assistant turns. Message endpoints remain for history reads and for legacy client writes. Do not wire Ubuntu until this cutover is complete.

## What the backend now does

- Thread get/update/delete, message list/insert, and `/api/ai/chat` require **organization ID + authenticated user ID**. Other users receive `404 AI_THREAD_NOT_FOUND`.
- `POST /api/ai/threads/:threadId/messages` accepts **`role: user` only**. Assistant and system rows are server-owned.
- `/api/ai/chat` loads **latest 40** messages (chronological, `id` tie-break), prepends a **server** system prompt, and ignores stored `role=system` rows.
- Provider failures return **`503 AI_INFERENCE_UNAVAILABLE`**. The user turn is kept; no assistant row is written. Retry the same text (or `clientMessageId`) to reuse that pending user turn.
- Successful envelope is unchanged: `{ reply, conversationId, threadId, assistantMessage }`.
- In-process lock + identical in-flight coalescing reduce duplicate turns on one Node process.

## Frontend changes required (ITsNomatataWorkSpace)

Do these together. Leaving any dual-write path in place will duplicate user rows or 400 on assistant inserts.

1. **Pass the UI conversation UUID into inference.**  
   `RealTimeChat.handleSend` → `onAsk` → `askAssistant` / router → `postToInternalAiAssistance` → `sendKodeAiChat` must send `threadId` / `conversationId` (the Postgres thread id already used by `ChatHistoryService`).

2. **Stop creating thread B.**  
   Workspace must not call `/api/ai/chat` without that id after the sidebar thread exists.

3. **Stop client writes of inference turns.**  
   After `/chat` persists user + assistant:
   - Do **not** `POST /api/ai/threads/:id/messages` for the user prompt.
   - Do **not** `POST .../messages` with `role: assistant` (this now returns 400).
   - Render from `/chat`’s `assistantMessage` (and optional refresh of `GET .../messages`).

4. **Handle 503 without a fake bubble.**  
   Show a retryable error. Do not append “AI is unavailable…” as an assistant message. Retry with the same `threadId` and same `message` (optional `clientMessageId`) so the backend reuses the pending user row.

5. **Do not send `role: system` from the browser.**  
   Assistant `system_prompt` stays on `ai.assistants` and is injected by the server.

6. **Serialize overlapping sends on the same thread** in the UI (`busy` / in-flight). Backend locking is per process only.

7. **Keep listing/reading threads** via `GET /api/ai/threads` and `GET /api/ai/threads/:id/messages`. Message list is now **latest-N chronological** (default 100, max 500), not oldest-N.

## Retry behavior

| Situation | Backend | Client should |
| --- | --- | --- |
| Inference 503 | User row kept; no assistant row | Retry same `threadId` + message; do not POST the user row again |
| Success then refresh | User + assistant in Postgres | Reload messages; do not re-POST |
| Duplicate in-flight identical payload (one process) | Coalesced to one write | Still disable Send while pending |
| Two different prompts | Serialized on that thread | Queue in UI |

## Out of scope until a later sprint

- Production enablement of `KODEX_AI_WORKSPACE_GATEWAY_ENABLED` (implemented locally; default off). See `docs/kodex/ai-workspace-gateway-chat.md`.
- Content Studio analyze-media (already on its own vision flag)
- Team-chat `@kodex`
- Deleting historical client-supplied `system` rows (they remain stored; they are not used as trusted instructions)
