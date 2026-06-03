import type { WhopMockConfiguration } from './types.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Configuration {
  debug: boolean;
  debugOutput: (message: string) => void;
  specPath?: string;
  apiBasePath: string;
  idPrefixes: Record<string, string>;

  constructor(options: WhopMockConfiguration = {}) {
    this.debug = options.debug ?? false;
    this.debugOutput = options.debugOutput ?? console.log;
    this.specPath = options.specPath;
    this.apiBasePath = options.apiBasePath ?? '/api/v1';
    this.idPrefixes = options.idPrefixes ?? {};
  }

  get resolvedSpecPath(): string {
    if (this.specPath) {
      return this.specPath;
    }

    // Check vendored artifact
    const vendoredPath = join(__dirname, '..', 'vendor', 'openapi', 'whop-openapi.yml');
    if (existsSync(vendoredPath)) {
      return vendoredPath;
    }

    // Check default fixtures path
    const fixturesPath = join(__dirname, '..', 'vendor', 'openapi.yml');
    if (existsSync(fixturesPath)) {
      return fixturesPath;
    }

    throw new Error(
      'No OpenAPI spec found. Please provide specPath in configuration or place spec at vendor/openapi/whop-openapi.yml'
    );
  }
}
