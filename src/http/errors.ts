export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(
    code = 'UNAUTHENTICATED',
    message = 'Authentication is required.',
  ) {
    super(code, message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    code = 'FORBIDDEN',
    message = 'You are not allowed to perform this operation.',
  ) {
    super(code, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(
    code = 'NOT_FOUND',
    message = 'The requested resource was not found.',
  ) {
    super(code, message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(
    code = 'CONFLICT',
    message = 'The request conflicts with the current state of the resource.',
  ) {
    super(code, message, 409);
  }
}

export class ValidationError extends AppError {
  constructor(
    message = 'The request is invalid.',
    details?: Record<string, unknown>,
  ) {
    super('VALIDATION_ERROR', message, 400, details);
  }
}

export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 60) {
    super(
      'RATE_LIMITED',
      'Too many requests. Try again later.',
      429,
      { retryAfterSeconds },
    );
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(
    code = 'SERVICE_UNAVAILABLE',
    message = 'The service is temporarily unavailable.',
  ) {
    super(code, message, 503);
  }
}
