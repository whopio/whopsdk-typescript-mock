import { Configuration } from './configuration.js';
import { Store } from './store.js';
import { SpecLoader } from './spec-loader.js';
import { SchemaRegistry } from './schema-registry.js';
import { RouteRegistry } from './route-registry.js';
import { IdGenerator } from './id-generator.js';
import { ExampleGenerator } from './example-generator.js';
import { ResponseBuilder } from './response-builder.js';
import { ErrorInjector } from './error-injector.js';
import { FallbackRegistry } from './fallback-registry.js';
import { Dispatcher } from './dispatcher.js';
import { MockRequester } from './mock-requester.js';
import type { OpenAPISpec } from './types.js';

/**
 * Session holds all components for a mock session.
 * Built via Session.build() factory method.
 */
export class Session {
  readonly configuration: Configuration;
  readonly store: Store;
  readonly spec: OpenAPISpec;
  readonly schemaRegistry: SchemaRegistry;
  readonly routeRegistry: RouteRegistry;
  readonly idGenerator: IdGenerator;
  readonly exampleGenerator: ExampleGenerator;
  readonly responseBuilder: ResponseBuilder;
  readonly errorInjector: ErrorInjector;
  readonly fallbackRegistry: FallbackRegistry;
  readonly dispatcher: Dispatcher;
  readonly requester: MockRequester;

  private constructor(options: {
    configuration: Configuration;
    store: Store;
    spec: OpenAPISpec;
    schemaRegistry: SchemaRegistry;
    routeRegistry: RouteRegistry;
    idGenerator: IdGenerator;
    exampleGenerator: ExampleGenerator;
    responseBuilder: ResponseBuilder;
    errorInjector: ErrorInjector;
    fallbackRegistry: FallbackRegistry;
    dispatcher: Dispatcher;
    requester: MockRequester;
  }) {
    this.configuration = options.configuration;
    this.store = options.store;
    this.spec = options.spec;
    this.schemaRegistry = options.schemaRegistry;
    this.routeRegistry = options.routeRegistry;
    this.idGenerator = options.idGenerator;
    this.exampleGenerator = options.exampleGenerator;
    this.responseBuilder = options.responseBuilder;
    this.errorInjector = options.errorInjector;
    this.fallbackRegistry = options.fallbackRegistry;
    this.dispatcher = options.dispatcher;
    this.requester = options.requester;
  }

  static build(options: { specPath?: string; configuration: Configuration }): Session {
    const { configuration } = options;
    const specPath = options.specPath ?? configuration.resolvedSpecPath;

    const debugOutput = configuration.debug ? configuration.debugOutput : undefined;

    // Load OpenAPI spec
    const specLoader = new SpecLoader(specPath, debugOutput);
    const spec = specLoader.load();

    // Build registries
    const schemaRegistry = new SchemaRegistry(spec);
    const routeRegistry = new RouteRegistry(spec, schemaRegistry);

    // Build core components
    const store = new Store();
    const idGenerator = new IdGenerator(schemaRegistry, configuration.idPrefixes);
    const exampleGenerator = new ExampleGenerator(idGenerator, schemaRegistry);
    const responseBuilder = new ResponseBuilder(store, schemaRegistry);
    const errorInjector = new ErrorInjector();
    const fallbackRegistry = new FallbackRegistry();

    // Build dispatcher
    const dispatcher = new Dispatcher({
      store,
      routeRegistry,
      idGenerator,
      exampleGenerator,
      responseBuilder,
      errorInjector,
    });

    // Build requester
    const requester = new MockRequester({
      dispatcher,
      configuration,
      fallbackRegistry,
    });

    return new Session({
      configuration,
      store,
      spec,
      schemaRegistry,
      routeRegistry,
      idGenerator,
      exampleGenerator,
      responseBuilder,
      errorInjector,
      fallbackRegistry,
      dispatcher,
      requester,
    });
  }
}
