/**
 * Development-only KODEX AI Gateway chat smoke test.
 * Reads KODEX_AI_GATEWAY_* from the environment. Never prints the token.
 *
 * Requires the MacBook SSH tunnel so http://127.0.0.1:13100 reaches the Ubuntu gateway.
 */
import 'dotenv/config';
import {
  createKodexAiGatewayClient,
} from '../../src/ai-gateway/client.js';
import { parseKodexAiGatewayConfig } from '../../src/ai-gateway/config.js';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

try {
  const config = parseKodexAiGatewayConfig(process.env);
  if (!config.enabled) {
    fail(
      'KODEX AI Gateway is disabled. Set KODEX_AI_GATEWAY_ENABLED=true plus base URL and token in the environment (not on the command line).',
    );
  }

  const client = createKodexAiGatewayClient({
    config,
    logger: (event) => {
      process.stderr.write(
        `${event.event} operation=${event.operation} status=${event.status ?? '-'} code=${event.code ?? '-'}\n`,
      );
    },
  });

  const result = await client.chat({
    assistant: 'kodex',
    message: 'Hello KODEX',
  });

  if (!result.assistant || !result.message) {
    fail('Chat smoke test failed: response missing assistant or message.');
  }

  process.stdout.write(
    `ok assistant=${result.assistant} message_chars=${result.message.length}\n`,
  );
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'SMOKE_FAILED';
  fail(`Chat smoke test failed (${code}).`);
}
