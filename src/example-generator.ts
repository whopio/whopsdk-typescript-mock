import { IdGenerator } from './id-generator.js';
import { SchemaRegistry } from './schema-registry.js';
import type { OpenAPISchema, ResourceRecord } from './types.js';

const RESOURCE_STATUS_DEFAULTS: Record<string, string> = {
  withdrawal: 'requested',
  transfer: 'paid',
  invoice: 'draft',
  payment: 'pending',
  refund: 'pending',
  entry: 'pending',
  verification: 'created',
  dispute: 'needs_response',
  dispute_alert: 'DISPUTE',
  resolution_case: 'merchant_response_needed',
  setup_intent: 'requires_payment_method',
  payout_account: 'connected',
  payout_method: 'active',
  ledger_account: 'active',
  membership: 'active',
};

const NAME_DEFAULTS: Record<string, unknown> = {
  status: 'active',
  payment_method_type: 'card',
  typename: 'BasePaymentMethod',
  username: 'example-user',
  email: 'user@example.com',
  email_address: 'customer@example.com',
  route: 'example-route',
  title: 'Example',
  name: 'Example',
  description: 'Example description',
  currency: 'usd',
  base_currency: 'usd',
  country: 'US',
  phone: '+1-555-123-4567',
  phone_number: '+1-555-123-4567',
  code: 'PROMO2024',
  secret: 'whsec_test_secret',
  payer_name: 'Example Payer',
};

const URL_FIELDS = [
  'url',
  'refresh_url',
  'return_url',
  'callback_url',
  'redirect_url',
  'success_url',
  'cancel_url',
  'webhook_url',
  'image_url',
  'logo_url',
  'avatar_url',
  'checkout_url',
  'portal_url',
  'manage_url',
];

/**
 * Generates example data from OpenAPI schemas.
 */
export class ExampleGenerator {
  private idGenerator: IdGenerator;
  private schemaRegistry: SchemaRegistry;

  constructor(idGenerator: IdGenerator, schemaRegistry: SchemaRegistry) {
    this.idGenerator = idGenerator;
    this.schemaRegistry = schemaRegistry;
  }

  generate(resourceName: string, overrides: Record<string, unknown> = {}): ResourceRecord {
    const schemaName = this.schemaRegistry.schemaNameForResource(resourceName);
    const schema = this.schemaRegistry.get(schemaName);

    const base = schema
      ? this.generateFromSchema(schema, resourceName, undefined)
      : this.fallbackExample(resourceName);

    return this.deepMerge(base, overrides);
  }

  private generateFromSchema(
    schema: OpenAPISchema,
    resourceName: string,
    propertyName: string | undefined
  ): ResourceRecord {
    const resolved = this.schemaRegistry.resolve(schema);
    if (!resolved) return {};

    switch (resolved.type) {
      case 'object':
      case undefined:
        return this.generateObject(resolved, resourceName);
      case 'array':
        return [] as unknown as ResourceRecord;
      case 'boolean':
        return false as unknown as ResourceRecord;
      case 'integer':
        return this.integerDefault(propertyName) as unknown as ResourceRecord;
      case 'number':
        return 10.0 as unknown as ResourceRecord;
      case 'string':
        return this.stringDefault(resolved, resourceName, propertyName) as unknown as ResourceRecord;
      default:
        return {};
    }
  }

  private generateObject(schema: OpenAPISchema, resourceName: string): ResourceRecord {
    const properties = schema.properties ?? {};
    const result: ResourceRecord = {};

    for (const [name, propertySchema] of Object.entries(properties)) {
      result[name] = this.generateProperty(name, propertySchema, resourceName);
    }

    return result;
  }

  private generateProperty(
    name: string,
    propertySchema: OpenAPISchema,
    resourceName: string
  ): unknown {
    const resolved = this.schemaRegistry.resolve(propertySchema);

    if (name === 'id') {
      return this.idGenerator.generate(resourceName);
    }

    if (name.endsWith('_id')) {
      const relatedResource = name.slice(0, -3);
      return this.idGenerator.generate(relatedResource);
    }

    if (name === 'status' && RESOURCE_STATUS_DEFAULTS[resourceName]) {
      return RESOURCE_STATUS_DEFAULTS[resourceName];
    }

    if (resolved?.enum && Array.isArray(resolved.enum) && resolved.enum.length > 0) {
      return resolved.enum[0];
    }

    return this.generateFromSchema(
      resolved ?? {},
      this.nestedResourceName(name, resourceName),
      name
    );
  }

  private stringDefault(
    schema: OpenAPISchema,
    resourceName: string,
    propertyName: string | undefined
  ): string {
    if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }

    const propStr = propertyName ?? '';

    if (schema.format === 'uri' || URL_FIELDS.includes(propStr) || propStr.endsWith('_url')) {
      return `https://example.com/${propStr.replace(/_url$/, '')}`;
    }

    if (propStr === 'id') {
      return this.idGenerator.generate(resourceName);
    }

    if (propStr.endsWith('_at') || ['created_at', 'updated_at', 'due_date', 'expires_at', 'joined_at'].includes(propStr)) {
      return new Date().toISOString();
    }

    if (/amount|price|total|subtotal|fee/.test(propStr)) {
      return '10.00';
    }

    if (NAME_DEFAULTS[propStr] !== undefined) {
      return String(NAME_DEFAULTS[propStr]);
    }

    return `${propertyName ?? resourceName}_example`;
  }

  private integerDefault(propertyName: string | undefined): number {
    const propStr = propertyName ?? '';
    if (propStr.includes('exp_month')) return 12;
    if (propStr.includes('exp_year')) return 35;
    return 1;
  }

  private nestedResourceName(name: string, fallback: string): string {
    let singular = name;
    if (name.endsWith('ies')) {
      singular = name.slice(0, -3) + 'y';
    } else {
      singular = name.replace(/s$/, '');
    }

    const schemaName = this.schemaRegistry.schemaNameForResource(singular);
    return this.schemaRegistry.get(schemaName) ? singular : fallback;
  }

  private fallbackExample(resourceName: string): ResourceRecord {
    return { id: this.idGenerator.generate(resourceName) };
  }

  private deepMerge(left: ResourceRecord, right: Record<string, unknown>): ResourceRecord {
    const result = { ...left };

    for (const [key, value] of Object.entries(right)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        typeof result[key] === 'object' &&
        result[key] !== null
      ) {
        result[key] = this.deepMerge(
          result[key] as ResourceRecord,
          value as Record<string, unknown>
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}
