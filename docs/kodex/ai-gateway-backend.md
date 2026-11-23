# KODEX AI Gateway — backend client (sprint v0.6A)

Server-side client for the Ubuntu **KODEX AI Gateway v0.4.0**. No frontend, no production deploy, and no change to Content Studio storage or the media CDN.

Existing KODEX chat and **text** caption routes still use the OpenAI-compatible `LLM_*` client. Content Studio **image analysis** (`POST /api/kodex/content-studio/analyze-media`) uses this gateway client when `KODEX_AI_GATEWAY_ENABLED=true` and the token/URL are valid. The default remains **disabled**.

## Architecture

| Piece | Role |
| --- | --- |
| `src/ai-gateway/config.ts` | Reads `KODEX_AI_GATEWAY_*`. Default **disabled**. |
| `src/ai-gateway/client.ts` | Authenticated `chat` and `analyzeImage`. Bounded timeouts. No retries. |
| `src/config/env.ts` | Exposes `env.kodexAiGateway` for later wiring. Does not probe the gateway. |
| Ubuntu gateway | `GET /health`, `POST /api/v1/ai/chat`, `POST /api/v1/ai/media/analyze` |
| MacBook tunnel | `http://127.0.0.1:13100` → gateway `127.0.0.1:3100` |

The backend never sends the application token to the browser. Tokens are not logged.

## Development setup

1. Keep the existing SSH tunnel so the Mac can reach the gateway:

   `http://127.0.0.1:13100` → Ubuntu `127.0.0.1:3100`

2. Put credentials in a **gitignored** env file or the shell environment. Do not pass the token as a CLI argument.

```
KODEX_AI_GATEWAY_ENABLED=true
KODEX_AI_GATEWAY_BASE_URL=http://127.0.0.1:13100
KODEX_AI_GATEWAY_TOKEN=<dedicated KODEX application credential>
```

Optional:

```
KODEX_AI_GATEWAY_TIMEOUT_MS=30000
KODEX_AI_GATEWAY_ANALYZE_TIMEOUT_MS=60000
```

3. Use a **dedicated KODEX application credential** issued for this backend. Do not use the broad `local-development` gateway credential.

Text model on the gateway: `qwen3:8b`. Vision model: `qwen3-vl:4b`.

## Smoke tests

Automated tests mock the gateway and do not need a GPU:

```
npx tsx --test tests/ai-gateway-client.test.ts
```

Live chat (tunnel + real credential required):

```
KODEX_AI_GATEWAY_ENABLED=true \
KODEX_AI_GATEWAY_BASE_URL=http://127.0.0.1:13100 \
KODEX_AI_GATEWAY_TOKEN=... \
npm run smoke:ai-gateway:chat
```

Prefer exporting the token in the current shell (or a gitignored file) rather than embedding it in shell history. The scripts print `assistant` and **character counts only**.

Optional vision smoke (tiny generated PNG, no extra image file required):

```
npm run smoke:ai-gateway:analyze
```

A non-zero exit means the gateway was disabled, unreachable, unauthorized, overloaded, or returned an unexpected body. The token is never written to stdout.

## Response contracts

Chat request:

```json
{ "assistant": "kodex", "message": "Hello KODEX" }
```

Chat result used by the client: `{ assistant: string, message: string }`  
Accepted JSON fields for the text: `message`, `text`, `content`, `reply`, `output`, or the same keys under `data` / `result`.

Vision: `multipart/form-data` with field `image`.

Gateway v0.4.0 returns a **structured** body (not a single `analysis` string). Typical shape:

```json
{
  "assistant": "kodex",
  "analysis": { "sceneDescription": "..." },
  "captions": {
    "generatedCaption": "...",
    "requiresReview": true
  },
  "requiresReview": true
}
```

Client result: `{ assistant, analysis, generatedCaption, requiresReview }`.  
`analysis` is taken from `analysis` (string) or `analysis.sceneDescription` / `sceneDescription` (never invented).  
Caption text may be `captions.generatedCaption`, `captions.instagram`, `captions.facebook`, `captions.hook` / `text` / `body`, or a caption array. Hashtags are not captions.  
If caption fields are present, `requiresReview` must be **boolean true**. Missing caption text is not invented.

Content Studio mapping (`mapGatewayAnalyzeToContentStudio`) copies only genuine fields into `ContentStudioAnalyzeOutput`. Platform captions are not filled from the primary caption. `requiresReview !== true` keeps mood/scene (and analysis uncertainties) and clears actionable caption, hook, CTA, and hashtag fields.

## Content Studio wiring (sprint v0.6C)

`analyzeContentStudioMedia` in `src/kodex/content-studio.ts`:

1. Session + `content_studio.manage` still happen in `src/routes/kodex.ts` (unchanged envelope).
2. `storagePath` must start with `{organizationId}/`. Bytes are loaded from the private review bucket. HTTP(S) URLs are rejected.
3. If the gateway is configured, authorized image bytes are sent as multipart `image` (8 MiB max). Gateway failures are returned as typed errors — **no fallback** to `llmVisionText`.
4. If the gateway is disabled, behavior is unchanged: `llmVisionText` with a data URL (12 MiB max).

The Ubuntu vision endpoint does **not** accept the Content Studio copywriter prompt, brand profile, or conversation history. Only the image is sent.

### Local end-to-end (MacBook + SSH tunnel)

Automated tests mock inference:

```
npx tsx --test tests/content-studio-analyze-gateway.test.ts tests/ai-gateway-client.test.ts
```

A full editor click-path needs a logged-in staff session with `content_studio.manage`, Postgres, and MinIO. Do not bypass those checks.

1. Keep the tunnel: `http://127.0.0.1:13100` → Ubuntu `127.0.0.1:3100`.
2. In a **gitignored** local env (not production): `KODEX_AI_GATEWAY_ENABLED=true`, base URL, dedicated `kodex-platform` credential (not `local-development`).
3. Confirm the gateway itself with `npm run smoke:ai-gateway:analyze` (tiny generated PNG; prints character counts only).
4. Log into Content Studio as a permitted user, analyze a **non-customer** test image already stored under that org, and confirm `PostFrameAiSuggestions` still requires Apply.
5. Leave production `KODEX_AI_GATEWAY_ENABLED` unset/false. Do not restart or deploy as part of this sprint.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `KODEX_AI_GATEWAY_NOT_CONFIGURED` | `ENABLED` is not `true`, or URL/token missing |
| Connection / `KODEX_AI_GATEWAY_UNAVAILABLE` | SSH tunnel down; gateway not listening on 3100 |
| `KODEX_AI_GATEWAY_UNAUTHORIZED` | Wrong or missing application credential |
| `KODEX_AI_GATEWAY_FORBIDDEN` | Credential not allowed for this operation |
| `KODEX_AI_GATEWAY_OVERLOADED` | Gateway 429 |
| `KODEX_AI_GATEWAY_TIMEOUT` | Inference slower than timeout |
| `KODEX_AI_GATEWAY_INVALID_RESPONSE` | Body was not JSON or had no text field |
| Parse error on `local-development` | That credential is blocked on purpose |

## Security limitations

- The new client is still server-side only. The browser never receives `KODEX_AI_GATEWAY_TOKEN`.
- Failures are not retried (inference is expensive) and do not fall back to `LLM_*`.
- Gateway client logs record operation, status, and error code only — not tokens, prompts, or image bytes.
- `env.kodexAiGateway.token` is redacted by pino when the gateway is enabled.
- Production Hetzner still cannot reach `127.0.0.1:13100` on a developer laptop.

## Remaining production connectivity

Not done in this sprint (and must not be improvised on the VPS):

1. Issue a dedicated production KODEX application credential on the Ubuntu gateway (not `local-development`).
2. Provide a private path from the Hetzner API to the gateway (VPN, SSH tunnel service, or private IP). Do not publish the gateway on the public internet.
3. Set `KODEX_AI_GATEWAY_*` on the VPS only through authorized secret management.
4. Content Studio `analyze-media` is wired behind the existing `content_studio.manage` + org path checks (v0.6C). Chat assist and `/api/ai/chat` are **not**.
5. Confirm timeout and concurrency limits against real `qwen3-vl:4b` load before enabling on any production API host.

## Next integration step

Keep this client **disabled in production** until a private path from the API host to the Ubuntu gateway exists. Do not replace `src/kodex/llm-client.ts`. Do not route workspace chat or `generate-caption` through vision.
