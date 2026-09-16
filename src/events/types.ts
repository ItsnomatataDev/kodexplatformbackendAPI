export type DomainEvent = {
  name: string;
  occurredAt: string;
  organizationId?: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  payload?: Record<string, unknown>;
};

export function createDomainEvent(
  name: string,
  input: Omit<DomainEvent, 'name' | 'occurredAt'> = {},
): DomainEvent {
  return {
    name,
    occurredAt: new Date().toISOString(),
    ...input,
  };
}
