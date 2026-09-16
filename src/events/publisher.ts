import { logger } from '../config/logger.js';
import type { DomainEvent } from './types.js';

export interface EventPublisher {
  publish(event: DomainEvent): Promise<void>;
}

export class LoggingEventPublisher implements EventPublisher {
  async publish(event: DomainEvent): Promise<void> {
    logger.info(
      {
        eventName: event.name,
        occurredAt: event.occurredAt,
        organizationId: event.organizationId,
        actorId: event.actorId,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
      },
      'domain event',
    );
  }
}

export const eventPublisher: EventPublisher = new LoggingEventPublisher();

export async function publishDomainEvent(event: DomainEvent): Promise<void> {
  await eventPublisher.publish(event);
}
