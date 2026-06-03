import type {
  OpenAPISpec,
  OpenAPIOperation,
  RouteEntry,
  HttpMethod,
  RouteAction,
} from './types.js';
import { SchemaRegistry } from './schema-registry.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

const DEFAULT_CRUD_RESOURCES = [
  'dispute',
  'dispute_alert',
  'resolution_case',
  'resolution_event',
  'payment',
  'user',
];

/**
 * Parses OpenAPI spec into route entries for request matching.
 */
export class RouteRegistry {
  readonly routes: RouteEntry[];
  private schemaRegistry: SchemaRegistry;

  constructor(spec: OpenAPISpec, schemaRegistry: SchemaRegistry) {
    this.schemaRegistry = schemaRegistry;
    this.routes = this.buildRoutes(spec);
    this.registerDefaultCrudRoutes();
  }

  private registerDefaultCrudRoutes(): void {
    for (const resourceName of DEFAULT_CRUD_RESOURCES) {
      const pluralPath = this.pluralize(resourceName);

      const crudRoutes: RouteEntry[] = [
        {
          action: 'list',
          method: 'GET',
          path: `/${pluralPath}`,
          resourceName,
          memberAction: false,
        },
        {
          action: 'create',
          method: 'POST',
          path: `/${pluralPath}`,
          resourceName,
          memberAction: false,
        },
        {
          action: 'retrieve',
          method: 'GET',
          path: `/${pluralPath}/{id}`,
          resourceName,
          memberAction: false,
        },
        {
          action: 'update',
          method: 'PATCH',
          path: `/${pluralPath}/{id}`,
          resourceName,
          memberAction: false,
        },
        {
          action: 'delete',
          method: 'DELETE',
          path: `/${pluralPath}/{id}`,
          resourceName,
          memberAction: false,
        },
      ];

      // Only add routes that don't already exist
      for (const route of crudRoutes) {
        const exists = this.routes.some(
          (r) => r.path === route.path && r.method === route.method
        );
        if (!exists) {
          this.routes.push(route);
        }
      }
    }
  }

  private pluralize(resourceName: string): string {
    if (resourceName.endsWith('y')) {
      return resourceName.slice(0, -1) + 'ies';
    }
    if (resourceName.endsWith('s') || resourceName.endsWith('x')) {
      return resourceName + 'es';
    }
    return resourceName + 's';
  }

  private buildRoutes(spec: OpenAPISpec): RouteEntry[] {
    const routes: RouteEntry[] = [];

    for (const [path, operations] of Object.entries(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const operation = operations[method] as OpenAPIOperation | undefined;
        if (!operation) continue;

        routes.push({
          action: this.inferAction(method, path, operation),
          method: method.toUpperCase() as HttpMethod,
          operationId: operation.operationId,
          path,
          resourceName: this.inferResourceName(path),
          memberAction: this.isMemberAction(path),
          requestSchema: this.extractRequestSchema(operation),
          responseSchema: this.extractResponseSchema(operation),
        });
      }
    }

    return routes;
  }

  private extractRequestSchema(operation: OpenAPIOperation) {
    const schema = operation.requestBody?.content?.['application/json']?.schema;
    return schema ? this.schemaRegistry.resolve(schema) : undefined;
  }

  private extractResponseSchema(operation: OpenAPIOperation) {
    const content =
      operation.responses?.['200']?.content?.['application/json']?.schema ??
      operation.responses?.['201']?.content?.['application/json']?.schema;
    return content ? this.schemaRegistry.resolve(content) : undefined;
  }

  private inferAction(
    method: string,
    path: string,
    operation: OpenAPIOperation
  ): RouteAction {
    const operationId = operation.operationId ?? '';

    if (method === 'get' && this.isSearchPath(path)) return 'search';
    if (method === 'get' && this.isCollectionPath(path)) return 'list';
    if (method === 'get' && this.isMemberAction(path)) {
      return this.lastPathSegment(path) as RouteAction;
    }
    if (method === 'get') return 'retrieve';
    if (method === 'post' && this.isCollectionPath(path)) return 'create';
    if (method === 'post' && this.isMemberAction(path)) {
      return this.lastPathSegment(path) as RouteAction;
    }
    if (method === 'patch' || method === 'put') return 'update';
    if (method === 'delete') return 'delete';

    if (operationId) {
      // Extract action from operationId like "createPayment" -> "create"
      const match = operationId.match(/^([a-z]+)/);
      if (match) return match[1] as RouteAction;
    }

    return 'custom';
  }

  private inferResourceName(path: string): string {
    const segments = path.split('/').filter(Boolean);
    const segment = segments.find((s) => !s.startsWith('{'));

    if (!segment) return '';

    // Convert plural to singular
    if (segment.endsWith('ies')) {
      return segment.slice(0, -3) + 'y';
    }
    return segment.replace(/s$/, '');
  }

  private isCollectionPath(path: string): boolean {
    return !path.includes('{');
  }

  private isSearchPath(path: string): boolean {
    return this.lastPathSegment(path) === 'search';
  }

  private isMemberAction(path: string): boolean {
    const parts = path.split('/').filter(Boolean);
    return parts.length > 2 && parts[1]?.startsWith('{');
  }

  private lastPathSegment(path: string): string {
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }
}
