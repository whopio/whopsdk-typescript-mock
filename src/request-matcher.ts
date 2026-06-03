import type { RouteEntry, RouteMatch, HttpMethod } from './types.js';
import { RouteRegistry } from './route-registry.js';

/**
 * Matches incoming requests to registered routes.
 */
export class RequestMatcher {
  private routeRegistry: RouteRegistry;
  private compiledRoutes: Array<{
    route: RouteEntry;
    regex: RegExp;
    paramNames: string[];
  }>;

  constructor(routeRegistry: RouteRegistry) {
    this.routeRegistry = routeRegistry;
    this.compiledRoutes = this.compileRoutes();
  }

  match(method: string, path: string): RouteMatch | null {
    const normalizedMethod = method.toUpperCase() as HttpMethod;
    const normalizedPath = this.normalizePath(path);

    for (const { route, regex, paramNames } of this.compiledRoutes) {
      if (route.method !== normalizedMethod) continue;

      const match = normalizedPath.match(regex);
      if (match) {
        const pathParams: Record<string, string> = {};
        paramNames.forEach((name, index) => {
          pathParams[name] = match[index + 1];
        });

        return { route, pathParams };
      }
    }

    return null;
  }

  private compileRoutes() {
    return this.routeRegistry.routes.map((route) => {
      const paramNames: string[] = [];

      // Convert OpenAPI path params {id} to regex capture groups
      const regexPattern = route.path
        .split('/')
        .filter(Boolean)
        .map((segment) => {
          if (segment.startsWith('{') && segment.endsWith('}')) {
            const paramName = segment.slice(1, -1);
            paramNames.push(paramName);
            return '([^/]+)';
          }
          return segment;
        })
        .join('/');

      return {
        route,
        regex: new RegExp(`^/?${regexPattern}/?$`),
        paramNames,
      };
    });
  }

  private normalizePath(path: string): string {
    // Remove leading/trailing slashes and query string
    const withoutQuery = path.split('?')[0];
    return withoutQuery.replace(/^\/+|\/+$/g, '');
  }
}
