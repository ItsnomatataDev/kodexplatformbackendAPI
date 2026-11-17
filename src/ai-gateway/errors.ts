import { AppError } from '../http/errors.js';

export class KodexAiGatewayNotConfiguredError extends AppError {
  constructor(
    message = 'The KODEX AI Gateway is disabled or not configured.',
  ) {
    super('KODEX_AI_GATEWAY_NOT_CONFIGURED', message, 503);
  }
}

export class KodexAiGatewayAuthError extends AppError {
  constructor(message = 'The AI Gateway rejected the application credential.') {
    super('KODEX_AI_GATEWAY_UNAUTHORIZED', message, 503);
  }
}

export class KodexAiGatewayForbiddenError extends AppError {
  constructor(message = 'The AI Gateway forbade this operation.') {
    super('KODEX_AI_GATEWAY_FORBIDDEN', message, 503);
  }
}

export class KodexAiGatewayOverloadedError extends AppError {
  constructor(message = 'The AI Gateway is overloaded. Try again later.') {
    super('KODEX_AI_GATEWAY_OVERLOADED', message, 503);
  }
}

export class KodexAiGatewayTimeoutError extends AppError {
  constructor(message = 'The AI Gateway request timed out.') {
    super('KODEX_AI_GATEWAY_TIMEOUT', message, 504);
  }
}

export class KodexAiGatewayUnavailableError extends AppError {
  constructor(message = 'The AI Gateway is unavailable.') {
    super('KODEX_AI_GATEWAY_UNAVAILABLE', message, 503);
  }
}

export type KodexAiGatewayInvalidResponseDetails = {
  category:
    | 'malformed_json'
    | 'missing_field'
    | 'empty_field'
    | 'wrong_type'
    | 'requires_review';
  fieldPath?: string;
};

export class KodexAiGatewayInvalidResponseError extends AppError {
  declare details?: KodexAiGatewayInvalidResponseDetails;

  constructor(
    message = 'The AI Gateway returned an invalid response.',
    details?: KodexAiGatewayInvalidResponseDetails,
  ) {
    super('KODEX_AI_GATEWAY_INVALID_RESPONSE', message, 502, details);
  }
}
