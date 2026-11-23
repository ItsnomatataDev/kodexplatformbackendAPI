/**
 * Optional development-only image-analysis smoke test.
 * Uses a tiny generated PNG. Never prints the token or image bytes.
 */
import 'dotenv/config';
import {
  createKodexAiGatewayClient,
} from '../../src/ai-gateway/client.js';
import { parseKodexAiGatewayConfig } from '../../src/ai-gateway/config.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
        `${event.event} operation=${event.operation} status=${event.status ?? '-'} code=${event.code ?? '-'}${event.fieldPath ? ` fieldPath=${event.fieldPath}` : ''}\n`,
      );
    },
  });

  const result = await client.analyzeImage({
    image: png,
    fileName: 'smoke.png',
    contentType: 'image/png',
  });

  if (!result.analysis) {
    fail('Analyze smoke test failed: response missing analysis text.');
  }

  process.stdout.write(
    `ok assistant=${result.assistant} analysis_chars=${result.analysis.length} caption_chars=${result.generatedCaption?.length ?? 0} requiresReview=${result.requiresReview}\n`,
  );
} catch (error) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'SMOKE_FAILED';
  const details =
    error && typeof error === 'object' && 'details' in error
      ? (error.details as { category?: string; fieldPath?: string } | undefined)
      : undefined;
  const category = details?.category ? ` category=${details.category}` : '';
  const fieldPath = details?.fieldPath ? ` fieldPath=${details.fieldPath}` : '';
  fail(`Analyze smoke test failed (${code}${category}${fieldPath}).`);
}
