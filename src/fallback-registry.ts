import type { FallbackHandler } from './types.js';

/**
 * Registry for custom fallback handlers for unmatched routes.
 */
export class FallbackRegistry {
  private handlers: FallbackHandler[] = [];

  register(handler: FallbackHandler): void {
    this.handlers.push(handler);
  }

  call(params: {
    method: string;
    path: string;
    query: Record<string, unknown>;
    body: unknown;
  }): [number, unknown] | unknown | null {
    for (const handler of this.handlers) {
      const result = handler(params);
      if (result !== null && result !== undefined) {
        return result;
      }
    }
    return null;
  }

  clear(): void {
    this.handlers = [];
  }
}
