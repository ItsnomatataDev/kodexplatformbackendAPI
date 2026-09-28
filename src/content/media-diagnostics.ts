import type { Logger } from 'pino';

/** Observe reads without prefetching, buffering, or logging upstream errors/secrets. */
export function observeMediaBody(body: ReadableStream<Uint8Array>, logger: Logger) {
  const reader = body.getReader();
  const started = performance.now();
  let bytes = 0;
  let finished = false;
  const finish = (outcome: string) => {
    if (finished) return;
    finished = true;
    logger.info({ outcome, bytes, streamDurationMs: Math.round(performance.now() - started) }, 'media.stream');
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish('complete');
          controller.close();
        } else {
          bytes += chunk.value.byteLength;
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finish('error');
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish('aborted');
      await reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
