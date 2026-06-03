import type { ResourceRecord } from './types.js';

/**
 * In-memory data store with CRUD operations and filtering.
 * Thread-safe via synchronous operations (JS is single-threaded).
 */
export class Store {
  private data: Map<string, Map<string, ResourceRecord>> = new Map();

  insert(resourceName: string, attributes: ResourceRecord): ResourceRecord {
    const record = this.deepCopy(attributes);
    const id = record.id as string;
    if (!id) {
      throw new Error(`Record must have an id field`);
    }

    if (!this.data.has(resourceName)) {
      this.data.set(resourceName, new Map());
    }
    this.data.get(resourceName)!.set(id, record);

    return this.deepCopy(record);
  }

  find(resourceName: string, id: string): ResourceRecord | null {
    const resourceMap = this.data.get(resourceName);
    if (!resourceMap) return null;

    const record = resourceMap.get(id);
    return record ? this.deepCopy(record) : null;
  }

  update(resourceName: string, id: string, attributes: ResourceRecord): ResourceRecord | null {
    const resourceMap = this.data.get(resourceName);
    if (!resourceMap) return null;

    const current = resourceMap.get(id);
    if (!current) return null;

    const updated = { ...current, ...this.deepCopy(attributes) };
    resourceMap.set(id, updated);

    return this.deepCopy(updated);
  }

  delete(resourceName: string, id: string): ResourceRecord | null {
    const resourceMap = this.data.get(resourceName);
    if (!resourceMap) return null;

    const record = resourceMap.get(id);
    if (!record) return null;

    resourceMap.delete(id);
    return this.deepCopy(record);
  }

  list(resourceName: string, filters: Record<string, unknown> = {}): ResourceRecord[] {
    const resourceMap = this.data.get(resourceName);
    if (!resourceMap) return [];

    const records = Array.from(resourceMap.values());

    return records
      .filter((record) => {
        return Object.entries(filters).every(([key, value]) => {
          return record[key] === value;
        });
      })
      .map((record) => this.deepCopy(record));
  }

  search(
    resourceName: string,
    query: string,
    matcher?: (record: ResourceRecord, needle: string) => boolean
  ): ResourceRecord[] {
    const resourceMap = this.data.get(resourceName);
    if (!resourceMap) return [];

    const needle = query.toLowerCase();
    const records = Array.from(resourceMap.values());

    return records
      .filter((record) => {
        if (!needle) return true;
        if (matcher) return matcher(this.deepCopy(record), needle);
        return this.deepSearch(record, needle);
      })
      .map((record) => this.deepCopy(record));
  }

  clear(): void {
    this.data.clear();
  }

  private deepCopy<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  private deepSearch(value: unknown, needle: string): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.some((item) => this.deepSearch(item, needle));
      }
      return Object.values(value).some((child) => this.deepSearch(child, needle));
    }

    return String(value).toLowerCase().includes(needle);
  }
}
