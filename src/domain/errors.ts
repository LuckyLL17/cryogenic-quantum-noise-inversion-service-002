export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422, public readonly details?: unknown) {
    super(message);
    this.name = 'DomainError';
  }
}

export function invariant(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new DomainError(code, message, 422, details);
}
