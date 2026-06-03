import type { ResourceRecord, OpenAPISchema } from './types.js';
import { Store } from './store.js';
import { SchemaRegistry } from './schema-registry.js';

/**
 * Builds API responses, filtering fields based on schema.
 */
export class ResponseBuilder {
  private store: Store;
  private schemaRegistry: SchemaRegistry;

  constructor(store: Store, schemaRegistry: SchemaRegistry) {
    this.store = store;
    this.schemaRegistry = schemaRegistry;
  }

  build(options: {
    resourceName: string;
    record: ResourceRecord;
    schema?: OpenAPISchema;
  }): ResourceRecord {
    const { record, schema } = options;

    if (!schema?.properties) {
      return record;
    }

    // Filter to only include fields defined in schema
    const result: ResourceRecord = {};
    const schemaProperties = Object.keys(schema.properties);

    for (const key of schemaProperties) {
      if (key in record) {
        result[key] = record[key];
      }
    }

    // Always include id if present
    if ('id' in record && !('id' in result)) {
      result.id = record.id;
    }

    return result;
  }
}
