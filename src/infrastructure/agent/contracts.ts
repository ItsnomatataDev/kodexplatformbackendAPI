/** Future authenticated, scoped agent protocol. No transport or executor in Phase 1. */
export type AgentAction =
  | 'server.summary.read'
  | 'containers.list'
  | 'logs.read';
export type AgentEnvelope = {
  version: 1;
  agentId: string;
  requestId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  action: AgentAction;
  resourceId: string;
  maxOutputBytes: number;
  timeoutMs: number;
};
export type AgentResponse = {
  requestId: string;
  status: 'ok' | 'denied' | 'failed';
  truncated: boolean;
  payload: unknown;
};
// Dedicated non-root identity, private authenticated transport, replay ledger and audit required.
// No shell command, caller-provided host, SSH key, Docker socket or filesystem mount contract.
