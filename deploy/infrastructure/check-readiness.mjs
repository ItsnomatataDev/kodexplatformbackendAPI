/** Run INSIDE the infrastructure container after its liveness-based startup wait.
 * Exit nonzero until schema, role and audit dependencies are ready. No secrets emitted.
 */
const origin = `http://127.0.0.1:${process.env.INFRA_PORT ?? '3101'}`;
try {
  const response = await fetch(`${origin}/health/ready`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || (await response.json()).status !== 'ready')
    throw new Error();
  console.log('Infrastructure authentication ready');
} catch {
  console.error(
    'Infrastructure authentication is not ready; release must not be accepted',
  );
  process.exitCode = 1;
}
