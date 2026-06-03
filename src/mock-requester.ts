import type { MockRequest, MockResponse, WhopMockConfiguration } from './types.js';
import { Dispatcher } from './dispatcher.js';
import { FallbackRegistry } from './fallback-registry.js';
import { NotFoundError, WhopMockError } from './error-injector.js';

/**
 * Handles HTTP requests by delegating to the Dispatcher.
 * This is what gets injected into the SDK client.
 */
export class MockRequester {
  private dispatcher: Dispatcher;
  private configuration: WhopMockConfiguration;
  private fallbackRegistry: FallbackRegistry;

  constructor(options: {
    dispatcher: Dispatcher;
    configuration: WhopMockConfiguration;
    fallbackRegistry: FallbackRegistry;
  }) {
    this.dispatcher = options.dispatcher;
    this.configuration = options.configuration;
    this.fallbackRegistry = options.fallbackRegistry;
  }

  async execute(input: MockRequest): Promise<[number, MockResponse, string[]]> {
    const method = this.extractMethod(input);
    const { path: normalizedPath, query } = this.parseUrl(input);
    const body = this.normalizeBody(input.body);

    this.debug(`Request: ${method} ${normalizedPath}`, { query, body });

    try {
      const [status, payload] = this.dispatcher.dispatch({
        method,
        path: normalizedPath,
        query,
        body,
      });

      this.debug(`Response: ${status}`, payload);

      const responseBody = JSON.stringify(payload);
      const response: MockResponse = {
        status,
        body: responseBody,
        headers: { 'content-type': 'application/json' },
      };

      return [status, response, [responseBody]];
    } catch (error) {
      if (error instanceof NotFoundError) {
        this.debug(`NotFound: ${error.message}`);
        return this.errorResponse(404, error.message);
      }

      if (error instanceof WhopMockError) {
        // Try fallback handlers
        const fallback = this.fallbackRegistry.call({
          method,
          path: normalizedPath,
          query,
          body,
        });

        if (fallback !== null) {
          const [status, payload] = this.normalizeFallback(fallback);
          this.debug(`Fallback response: ${status}`, payload);

          const responseBody = JSON.stringify(payload);
          const response: MockResponse = {
            status,
            body: responseBody,
            headers: { 'content-type': 'application/json' },
          };

          return [status, response, [responseBody]];
        }
      }

      // Re-throw unhandled errors
      this.debug(`Error: ${(error as Error).message}`);
      throw error;
    }
  }

  private extractMethod(input: MockRequest): string {
    return (input.method ?? 'GET').toUpperCase();
  }

  private parseUrl(input: MockRequest): { path: string; query: Record<string, unknown> } {
    const urlString = input.url ?? input.path ?? '/';

    try {
      const url = new URL(urlString, 'https://api.whop.com');
      const path = this.normalizePath(url.pathname);
      const query: Record<string, unknown> = {};

      url.searchParams.forEach((value, key) => {
        // Handle array params (key[])
        const normalizedKey = key.replace(/\[\]$/, '');
        if (key.endsWith('[]')) {
          if (!query[normalizedKey]) {
            query[normalizedKey] = [];
          }
          (query[normalizedKey] as unknown[]).push(value);
        } else {
          query[normalizedKey] = value;
        }
      });

      return { path, query };
    } catch {
      return { path: this.normalizePath(urlString), query: {} };
    }
  }

  private normalizePath(path: string): string {
    const basePath = this.configuration.apiBasePath ?? '/api/v1';

    // Remove base path prefix if present
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length);
    }

    // Ensure path starts with /
    if (!path.startsWith('/')) {
      path = '/' + path;
    }

    // Remove trailing slash
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }

    return path;
  }

  private normalizeBody(body: unknown): unknown {
    if (body === null || body === undefined) {
      return null;
    }

    if (typeof body === 'string') {
      try {
        const trimmed = body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          return JSON.parse(body);
        }
      } catch {
        // Return as-is if not valid JSON
      }
    }

    return body;
  }

  private normalizeFallback(fallback: unknown): [number, unknown] {
    if (Array.isArray(fallback) && fallback.length === 2) {
      return [Number(fallback[0]), fallback[1]];
    }
    return [200, fallback];
  }

  private errorResponse(status: number, message: string): [number, MockResponse, string[]] {
    const payload = { error: message };
    const responseBody = JSON.stringify(payload);
    const response: MockResponse = {
      status,
      body: responseBody,
      headers: { 'content-type': 'application/json' },
    };
    return [status, response, [responseBody]];
  }

  private debug(message: string, data?: unknown): void {
    if (this.configuration.debug) {
      const output = this.configuration.debugOutput ?? console.log;
      if (data !== undefined) {
        output(`[WhopMock] ${message}: ${JSON.stringify(data)}`);
      } else {
        output(`[WhopMock] ${message}`);
      }
    }
  }
}
