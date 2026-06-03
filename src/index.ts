import { Configuration } from './configuration.js';
import { Session } from './session.js';
import { ClientPatcher } from './client-patcher.js';
import { TestHelper } from './test-helper.js';
import type {
  WhopMockConfiguration,
  ResourceRecord,
  FallbackHandler,
} from './types.js';

export { WhopMockError, NotFoundError } from './error-injector.js';
export { ResourceNames } from './types.js';
export { Store } from './store.js';
export type {
  WhopMockConfiguration,
  ResourceRecord,
  MockRequest,
  MockResponse,
  PaginatedResponse,
} from './types.js';

// Global state
let currentSession: Session | null = null;
let globalConfiguration = new Configuration();

/**
 * Configure WhopMock globally
 */
export function configure(options: WhopMockConfiguration): void {
  globalConfiguration = new Configuration(options);
}

/**
 * Reset configuration to defaults
 */
export function resetConfiguration(): void {
  globalConfiguration = new Configuration();
}

/**
 * Get current session (throws if not started)
 */
function getSession(): Session {
  if (!currentSession) {
    throw new Error('WhopMock.start() must be called before using this method');
  }
  return currentSession;
}

/**
 * Start a new mock session
 */
export function start(options: { specPath?: string } = {}): Session {
  const specPath = options.specPath ?? globalConfiguration.specPath;
  currentSession = Session.build({
    specPath,
    configuration: globalConfiguration,
  });
  return currentSession;
}

/**
 * Stop the current mock session
 */
export function stop(): void {
  currentSession = null;
}

/**
 * Get the current requester (for advanced usage)
 */
export function requester() {
  return getSession().requester;
}

/**
 * Install mock into SDK client
 */
export function install(client: unknown, options: { specPath?: string } = {}): unknown {
  const session = currentSession ?? start(options);
  const patcher = new ClientPatcher(client, session.requester);
  patcher.install();
  return client;
}

/**
 * Uninstall mock from SDK client
 */
export function uninstall(client: unknown): unknown {
  const patcher = new ClientPatcher(client, getSession().requester);
  patcher.uninstall();
  return client;
}

/**
 * Prepare an error to be thrown on next matching action
 */
export function prepareError(
  errorClass: new (message?: string) => Error,
  actionKey: string,
  options: { message?: string; attributes?: Record<string, unknown> } = {}
): void {
  getSession().errorInjector.prepare(errorClass, actionKey, options);
}

/**
 * Generate example data for a resource type
 */
export function generateExample(
  resourceName: string,
  overrides: Record<string, unknown> = {}
): ResourceRecord {
  return getSession().exampleGenerator.generate(resourceName, overrides);
}

/**
 * Seed a record into the store
 */
export function seed(
  resourceName: string,
  overrides: Record<string, unknown> = {}
): ResourceRecord {
  const session = getSession();
  const record = session.exampleGenerator.generate(resourceName, overrides);
  return session.store.insert(resourceName, record);
}

/**
 * Seed multiple records into the store
 */
export function seedMany(
  resourceName: string,
  rows: Array<Record<string, unknown> | null>
): ResourceRecord[] {
  return rows.map((row) => seed(resourceName, row ?? {}));
}

/**
 * Create a test helper with convenience methods
 */
export function createTestHelper(): TestHelper {
  return new TestHelper(getSession());
}

/**
 * Toggle debug mode
 */
export function toggleDebug(
  enabled = true,
  output?: (message: string) => void
): boolean {
  globalConfiguration.debug = enabled;
  if (output) {
    globalConfiguration.debugOutput = output;
  }
  return enabled;
}

/**
 * Register a fallback handler for unmatched routes
 */
export function registerFallback(handler: FallbackHandler): void {
  getSession().fallbackRegistry.register(handler);
}

/**
 * Clear all fallback handlers
 */
export function clearFallbacks(): void {
  currentSession?.fallbackRegistry.clear();
}

/**
 * Search records in the store
 */
export function search(
  resourceName: string,
  options: { query: string; filters?: Record<string, unknown> }
): ResourceRecord[] {
  const session = getSession();
  let records = session.store.list(resourceName, options.filters ?? {});

  if (options.query) {
    records = session.store.search(resourceName, options.query);
  }

  return records;
}

/**
 * Get the store for direct manipulation (advanced usage)
 */
export function getStore() {
  return getSession().store;
}

/**
 * Find a record by ID
 */
export function find(resourceName: string, id: string): ResourceRecord | null {
  return getSession().store.find(resourceName, id);
}

/**
 * List all records of a resource type
 */
export function list(
  resourceName: string,
  filters: Record<string, unknown> = {}
): ResourceRecord[] {
  return getSession().store.list(resourceName, filters);
}

/**
 * Update a record
 */
export function update(
  resourceName: string,
  id: string,
  attributes: Record<string, unknown>
): ResourceRecord | null {
  return getSession().store.update(resourceName, id, attributes);
}

// Default export for convenience
export default {
  configure,
  resetConfiguration,
  start,
  stop,
  requester,
  install,
  uninstall,
  prepareError,
  generateExample,
  seed,
  seedMany,
  createTestHelper,
  toggleDebug,
  registerFallback,
  clearFallbacks,
  search,
  getStore,
  find,
  list,
  update,
};
