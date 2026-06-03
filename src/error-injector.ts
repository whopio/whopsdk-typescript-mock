import type { ErrorInjection, RouteEntry } from './types.js';

export class WhopMockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhopMockError';
  }
}

export class NotFoundError extends WhopMockError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Allows programmatic injection of errors for testing error handling.
 */
export class ErrorInjector {
  private prepared: Map<string, ErrorInjection> = new Map();

  prepare(
    errorClass: new (message?: string) => Error,
    actionKey: string,
    options: { message?: string; attributes?: Record<string, unknown> } = {}
  ): void {
    this.prepared.set(actionKey, {
      errorClass,
      actionKey,
      message: options.message,
      attributes: options.attributes,
    });
  }

  raiseIfPrepared(route: RouteEntry): void {
    const actionKey = this.actionKeyFor(route);
    const injection = this.prepared.get(actionKey);

    if (injection) {
      this.prepared.delete(actionKey);
      const message = injection.message ?? `Injected error for ${actionKey}`;
      throw new injection.errorClass(message);
    }
  }

  clear(): void {
    this.prepared.clear();
  }

  private actionKeyFor(route: RouteEntry): string {
    // Generate action key like "retrieve_membership" or "create_payment"
    return `${route.action}_${route.resourceName}`;
  }
}
