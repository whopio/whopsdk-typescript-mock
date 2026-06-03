import type { OpenAPISpec, OpenAPISchema } from './types.js';

/**
 * Registry for resolving OpenAPI schemas and $ref references.
 */
export class SchemaRegistry {
  private spec: OpenAPISpec;
  private schemas: Map<string, OpenAPISchema> = new Map();

  constructor(spec: OpenAPISpec) {
    this.spec = spec;
    this.loadSchemas();
  }

  private loadSchemas(): void {
    const schemas = this.spec.components?.schemas ?? {};
    for (const [name, schema] of Object.entries(schemas)) {
      this.schemas.set(name, schema);
    }
  }

  get(name: string): OpenAPISchema | undefined {
    return this.schemas.get(name);
  }

  resolve(schema: OpenAPISchema | undefined): OpenAPISchema | undefined {
    if (!schema) return undefined;

    // Handle $ref
    if (schema.$ref) {
      const refName = this.extractRefName(schema.$ref);
      const resolved = this.schemas.get(refName);
      return resolved ? this.resolve(resolved) : undefined;
    }

    // Handle allOf
    if (schema.allOf && Array.isArray(schema.allOf)) {
      return this.mergeAllOf(schema.allOf);
    }

    // Handle oneOf/anyOf - return first option for simplicity
    if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      return this.resolve(schema.oneOf[0]);
    }

    if (schema.anyOf && Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
      return this.resolve(schema.anyOf[0]);
    }

    return schema;
  }

  schemaNameForResource(resourceName: string): string {
    // Convert resource name to PascalCase schema name
    const pascalCase = resourceName
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('');

    // Common schema name patterns
    const candidates = [
      pascalCase,
      `${pascalCase}Response`,
      `${pascalCase}Object`,
    ];

    for (const candidate of candidates) {
      if (this.schemas.has(candidate)) {
        return candidate;
      }
    }

    return pascalCase;
  }

  prefixFor(resourceName: string): string | undefined {
    const schemaName = this.schemaNameForResource(resourceName);
    const schema = this.schemas.get(schemaName);

    if (!schema?.properties?.id) return undefined;

    const idSchema = this.resolve(schema.properties.id);
    if (!idSchema) return undefined;

    // Check for example or pattern that indicates prefix
    const example = (idSchema as Record<string, unknown>).example as string | undefined;
    if (example && typeof example === 'string') {
      const match = example.match(/^([a-z]+_)/);
      if (match) return match[1];
    }

    return undefined;
  }

  private extractRefName(ref: string): string {
    // Format: #/components/schemas/SchemaName
    const parts = ref.split('/');
    return parts[parts.length - 1];
  }

  private mergeAllOf(schemas: OpenAPISchema[]): OpenAPISchema {
    const merged: OpenAPISchema = {
      type: 'object',
      properties: {},
    };

    for (const schema of schemas) {
      const resolved = this.resolve(schema);
      if (resolved?.properties) {
        merged.properties = { ...merged.properties, ...resolved.properties };
      }
      if (resolved?.type) {
        merged.type = resolved.type;
      }
    }

    return merged;
  }
}
