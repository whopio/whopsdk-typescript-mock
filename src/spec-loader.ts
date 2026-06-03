import { readFileSync } from 'fs';
import type { OpenAPISpec } from './types.js';

/**
 * Loads and parses OpenAPI spec from YAML or JSON file.
 */
export class SpecLoader {
  private specPath: string;
  private debugOutput?: (message: string) => void;

  constructor(specPath: string, debugOutput?: (message: string) => void) {
    this.specPath = specPath;
    this.debugOutput = debugOutput;
  }

  load(): OpenAPISpec {
    this.debug(`Loading OpenAPI spec from: ${this.specPath}`);

    const content = readFileSync(this.specPath, 'utf-8');

    // Simple YAML parser for basic OpenAPI specs
    // For production, you'd use a proper YAML parser like js-yaml
    if (this.specPath.endsWith('.yml') || this.specPath.endsWith('.yaml')) {
      return this.parseYaml(content);
    }

    return JSON.parse(content);
  }

  private parseYaml(content: string): OpenAPISpec {
    // Basic YAML parsing - for production use js-yaml
    // This is a simplified implementation that handles common cases
    try {
      // Try to use dynamic import for js-yaml if available
      const lines = content.split('\n');
      const result: Record<string, unknown> = {};
      const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
        { obj: result, indent: -2 },
      ];

      for (const line of lines) {
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const indent = line.search(/\S/);
        const trimmed = line.trim();

        // Handle key: value pairs
        const colonIndex = trimmed.indexOf(':');
        if (colonIndex > 0) {
          const key = trimmed.slice(0, colonIndex).trim();
          const value = trimmed.slice(colonIndex + 1).trim();

          // Pop stack to find parent
          while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
          }

          const parent = stack[stack.length - 1].obj;

          if (value) {
            // Inline value
            parent[key] = this.parseValue(value);
          } else {
            // Nested object
            const newObj: Record<string, unknown> = {};
            parent[key] = newObj;
            stack.push({ obj: newObj, indent });
          }
        }
      }

      return result as unknown as OpenAPISpec;
    } catch {
      throw new Error(
        `Failed to parse YAML. Consider installing js-yaml for better YAML support.`
      );
    }
  }

  private parseValue(value: string): unknown {
    // Remove quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }

    // Booleans
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Null
    if (value === 'null' || value === '~') return null;

    // Numbers
    if (/^-?\d+$/.test(value)) return parseInt(value, 10);
    if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);

    return value;
  }

  private debug(message: string): void {
    if (this.debugOutput) {
      this.debugOutput(`[SpecLoader] ${message}`);
    }
  }
}
