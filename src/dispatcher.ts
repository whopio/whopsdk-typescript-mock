import type { ResourceRecord, RouteEntry, PaginatedResponse } from './types.js';
import { ResourceNames } from './types.js';
import { Store } from './store.js';
import { RequestMatcher } from './request-matcher.js';
import { IdGenerator } from './id-generator.js';
import { ExampleGenerator } from './example-generator.js';
import { Paginator } from './paginator.js';
import { ResponseBuilder } from './response-builder.js';
import { ErrorInjector, NotFoundError, WhopMockError } from './error-injector.js';
import { PayoutGraph } from './dispatcher/payout-graph.js';
import { DisputeGraph } from './dispatcher/dispute-graph.js';
import { PaymentsGraph } from './dispatcher/payments-graph.js';
import { RouteRegistry } from './route-registry.js';

const PAGINATION_QUERY_KEYS = ['after', 'before', 'first', 'last', 'limit'];
const TRANSIENT_CREATE_RESOURCES: string[] = [ResourceNames.ACCOUNT_LINK];
const DEFAULT_LIMIT = 20;

type DispatchResult = [number, unknown];

/**
 * Main request dispatcher - routes requests to appropriate handlers.
 */
export class Dispatcher {
  private store: Store;
  private matcher: RequestMatcher;
  private idGenerator: IdGenerator;
  private exampleGenerator: ExampleGenerator;
  private paginator: Paginator;
  private responseBuilder: ResponseBuilder;
  private errorInjector: ErrorInjector;
  private payoutGraph: PayoutGraph;
  private disputeGraph: DisputeGraph;
  private paymentsGraph: PaymentsGraph;

  constructor(options: {
    store: Store;
    routeRegistry: RouteRegistry;
    idGenerator: IdGenerator;
    exampleGenerator: ExampleGenerator;
    responseBuilder: ResponseBuilder;
    errorInjector: ErrorInjector;
  }) {
    this.store = options.store;
    this.matcher = new RequestMatcher(options.routeRegistry);
    this.idGenerator = options.idGenerator;
    this.exampleGenerator = options.exampleGenerator;
    this.responseBuilder = options.responseBuilder;
    this.errorInjector = options.errorInjector;
    this.paginator = new Paginator();
    this.payoutGraph = new PayoutGraph(this.store, this.exampleGenerator);
    this.disputeGraph = new DisputeGraph(this.store, this.exampleGenerator);
    this.paymentsGraph = new PaymentsGraph(this.store, this.exampleGenerator);
  }

  dispatch(options: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
  }): DispatchResult {
    const { method, path, query = {}, body } = options;

    const match = this.matcher.match(method, path);
    if (!match) {
      throw new WhopMockError(`No mock route for ${method.toUpperCase()} ${path}`);
    }

    const { route, pathParams } = match;

    // Check for injected errors
    this.errorInjector.raiseIfPrepared(route);

    switch (route.action) {
      case 'list':
        return this.handleList(route, query);

      case 'search':
        return this.handleSearch(route, query);

      case 'create':
        return this.handleCreate(route, body);

      case 'retrieve':
        return this.handleRetrieve(route, pathParams);

      case 'update':
        return this.handleUpdate(route, pathParams, body);

      case 'delete':
        return this.handleDelete(route, pathParams);

      default:
        return this.handleCustomAction(route, pathParams, body);
    }
  }

  private handleList(route: RouteEntry, query: Record<string, unknown>): DispatchResult {
    const records = this.filterRecords(route.resourceName, query);
    const sortedRecords = this.sortRecords(route.resourceName, records, query);
    const paginatedResult = this.paginator.paginate(sortedRecords, {
      limit: this.listLimit(query),
      after: query.after as string | undefined,
    });

    return [200, paginatedResult];
  }

  private handleSearch(route: RouteEntry, query: Record<string, unknown>): DispatchResult {
    const records = this.filterRecords(route.resourceName, query);
    const searchQuery = (query.query as string) ?? '';
    const filteredRecords = this.store.search(route.resourceName, searchQuery);
    const sortedRecords = this.sortRecords(route.resourceName, filteredRecords, query);
    const paginatedResult = this.paginator.paginate(sortedRecords, {
      limit: this.listLimit(query),
      after: query.after as string | undefined,
    });

    return [200, paginatedResult];
  }

  private handleCreate(route: RouteEntry, body: unknown): DispatchResult {
    const payload = this.createPayload(body);
    const record = this.exampleGenerator.generate(route.resourceName, payload);

    if (!record.id) {
      record.id = this.idGenerator.generate(route.resourceName);
    }

    // Handle transient resources (like account_link that don't persist)
    if (TRANSIENT_CREATE_RESOURCES.includes(route.resourceName)) {
      const result = this.applyTransientSideEffects(route.resourceName, record, payload);
      return [201, this.buildResource(route, result)];
    }

    const stored = this.store.insert(route.resourceName, record);
    const withSideEffects = this.applyCreateSideEffects(route.resourceName, stored, payload);

    return [201, this.buildResource(route, withSideEffects)];
  }

  private handleRetrieve(route: RouteEntry, pathParams: Record<string, string>): DispatchResult {
    const id = this.identifierFor(route, pathParams);
    const record = this.store.find(route.resourceName, id);

    if (!record) {
      throw new NotFoundError(`${route.resourceName} not found`);
    }

    return [200, this.buildResource(route, record)];
  }

  private handleUpdate(
    route: RouteEntry,
    pathParams: Record<string, string>,
    body: unknown
  ): DispatchResult {
    const id = this.identifierFor(route, pathParams);
    const current = this.store.find(route.resourceName, id);

    if (!current) {
      throw new NotFoundError(`${route.resourceName} not found`);
    }

    const attributes = this.stringifyKeys(body as Record<string, unknown> ?? {});
    const updated = this.store.update(route.resourceName, id, attributes);

    if (!updated) {
      throw new NotFoundError(`${route.resourceName} not found`);
    }

    const withSideEffects = this.applyUpdateSideEffects(
      route.resourceName,
      current,
      updated,
      attributes
    );

    return [200, this.buildResource(route, withSideEffects)];
  }

  private handleDelete(route: RouteEntry, pathParams: Record<string, string>): DispatchResult {
    const id = this.identifierFor(route, pathParams);
    const record = this.store.delete(route.resourceName, id);

    if (!record) {
      throw new NotFoundError(`${route.resourceName} not found`);
    }

    // Check if response should be boolean
    if (this.isBooleanResponse(route)) {
      return [200, true];
    }

    return [200, record];
  }

  private handleCustomAction(
    route: RouteEntry,
    pathParams: Record<string, string>,
    body: unknown
  ): DispatchResult {
    const id = this.identifierFor(route, pathParams);
    const current = this.store.find(route.resourceName, id);

    if (!current) {
      throw new NotFoundError(`${route.resourceName} not found`);
    }

    // Read-only fee breakdown for a payment.
    if (route.resourceName === ResourceNames.PAYMENT && route.action === 'fees') {
      const fees = this.paymentsGraph.feesForPayment(current);
      const paginated = this.paginator.paginate(fees, { limit: this.listLimit({}) });
      return [200, paginated];
    }

    const attributes = this.stringifyKeys(body as Record<string, unknown> ?? {});

    // Apply status transitions based on action
    const updates = this.applyStatusTransition(route.resourceName, route.action, current);
    const updated = this.store.update(route.resourceName, id, updates) ?? current;

    const withSideEffects = this.applyActionSideEffects(
      route.resourceName,
      route.action,
      current,
      updated,
      attributes
    );

    if (this.isBooleanResponse(route)) {
      return [200, true];
    }

    return [200, this.buildResource(route, withSideEffects)];
  }

  private applyTransientSideEffects(
    resourceName: string,
    record: ResourceRecord,
    payload: Record<string, unknown>
  ): ResourceRecord {
    if (resourceName === ResourceNames.ACCOUNT_LINK) {
      // For transient account_link, just return enriched record without storing
      const companyId = (record.company_id ?? payload.company_id) as string;
      if (companyId) {
        // Ensure company exists
        this.ensureCompanyExists(companyId);
      }

      const useCase = String(record.use_case ?? payload.use_case ?? 'account_onboarding');
      const expiresAt =
        record.expires_at ?? payload.expires_at ?? new Date(Date.now() + 30 * 60 * 1000).toISOString();

      return {
        ...record,
        company_id: companyId,
        expires_at: expiresAt,
        refresh_url: record.refresh_url ?? payload.refresh_url,
        return_url: record.return_url ?? payload.return_url,
        url: `https://whop.test/companies/${companyId}/account_links/${useCase}?session=${record.id}`,
        use_case: useCase,
      };
    }

    return record;
  }

  private applyCreateSideEffects(
    resourceName: string,
    record: ResourceRecord,
    payload: Record<string, unknown>
  ): ResourceRecord {
    switch (resourceName) {
      case ResourceNames.TRANSFER:
        return this.payoutGraph.ensureTransferGraph(record, payload);

      case ResourceNames.WITHDRAWAL:
        return this.payoutGraph.ensureWithdrawalGraph(record, payload);

      case ResourceNames.FEE_MARKUP:
        return this.payoutGraph.ensureFeeMarkupGraph(record, payload);

      case ResourceNames.TOPUP:
        return this.payoutGraph.ensureTopupGraph(record, payload);

      case ResourceNames.ACCOUNT_LINK:
        return this.payoutGraph.ensureAccountLinkGraph(record, payload);

      case ResourceNames.LEDGER_ACCOUNT:
        return this.payoutGraph.ensureLedgerAccountGraph(record, payload);

      case ResourceNames.PAYOUT_ACCOUNT:
        return this.payoutGraph.ensurePayoutAccountGraph(record, payload);

      case ResourceNames.PAYOUT_METHOD:
        return this.payoutGraph.ensurePayoutMethodGraph(record, payload);

      case ResourceNames.DISPUTE:
        return this.disputeGraph.ensureDisputeGraph(record, payload);

      case ResourceNames.DISPUTE_ALERT:
        return this.disputeGraph.ensureDisputeAlertGraph(record, payload);

      case ResourceNames.RESOLUTION_CASE:
        return this.disputeGraph.ensureResolutionCaseGraph(record, payload);

      case ResourceNames.PRODUCT:
        return this.paymentsGraph.ensureProductGraph(record, payload);

      case ResourceNames.PLAN:
        return this.paymentsGraph.ensurePlanGraph(record, payload);

      case ResourceNames.CHECKOUT_CONFIGURATION:
        return this.paymentsGraph.ensureCheckoutConfigurationGraph(record, payload);

      case ResourceNames.PAYMENT:
        return this.paymentsGraph.ensurePaymentGraph(record, payload);

      case ResourceNames.MEMBERSHIP:
        return this.paymentsGraph.ensureMembershipGraph(record, payload);

      case ResourceNames.INVOICE:
        return this.paymentsGraph.ensureInvoiceGraph(record, payload);

      case ResourceNames.REFUND:
        return this.paymentsGraph.ensureRefundGraph(record, payload);

      case ResourceNames.PROMO_CODE:
        return this.paymentsGraph.ensurePromoCodeGraph(record, payload);

      case ResourceNames.PAYMENT_METHOD:
        return this.paymentsGraph.ensurePaymentMethodGraph(record, payload);

      case ResourceNames.SETUP_INTENT:
        return this.paymentsGraph.ensureSetupIntentGraph(record, payload);

      case ResourceNames.COMPANY:
        // Ensure related resources exist
        this.ensureCompanyExists(record.company_id as string);
        return this.store.find(resourceName, record.id as string) ?? record;

      default:
        return record;
    }
  }

  private applyUpdateSideEffects(
    _resourceName: string,
    _previous: ResourceRecord,
    updated: ResourceRecord,
    _attributes: Record<string, unknown>
  ): ResourceRecord {
    // Placeholder for resource-specific update side effects
    return updated;
  }

  private applyActionSideEffects(
    resourceName: string,
    action: string,
    _previous: ResourceRecord,
    updated: ResourceRecord,
    attributes: Record<string, unknown>
  ): ResourceRecord {
    if (resourceName === ResourceNames.PAYMENT && action === 'refund') {
      const requested = attributes.amount as number | undefined;
      const paymentAmount = (updated.amount as number) ?? 0;
      const refundAmount = requested ?? paymentAmount;
      this.paymentsGraph.createRefundForPayment(updated, refundAmount);

      const partial = refundAmount < paymentAmount;
      const refundUpdates = {
        substatus: partial ? 'partially_refunded' : 'refunded',
        refunded_at: new Date().toISOString(),
      };
      return this.store.update(resourceName, updated.id as string, refundUpdates) ?? updated;
    }

    if (resourceName === ResourceNames.INVOICE && action === 'mark_paid') {
      const currentPlan = updated.current_plan as ResourceRecord | undefined;
      const payment = this.exampleGenerator.generate(ResourceNames.PAYMENT, {
        company_id: updated.company_id,
        member_id: updated.member_id,
        plan_id: updated.plan_id,
        product_id: updated.product_id,
        currency: currentPlan?.currency ?? 'usd',
        status: 'paid',
      });
      const storedPayment = this.store.insert(ResourceNames.PAYMENT, payment);
      this.paymentsGraph.ensurePaymentGraph(storedPayment, {
        company_id: updated.company_id as string,
      });
      return updated;
    }

    return updated;
  }

  private applyStatusTransition(
    resourceName: string,
    action: string,
    _record: ResourceRecord
  ): Record<string, unknown> {
    // Status transition mappings
    const transitions: Record<string, Record<string, Record<string, unknown>>> = {
      [ResourceNames.WITHDRAWAL]: {
        approve: { status: 'approved' },
        complete: { status: 'completed' },
        cancel: { status: 'canceled' },
      },
      [ResourceNames.TRANSFER]: {
        complete: { status: 'paid' },
        cancel: { status: 'canceled' },
      },
      [ResourceNames.PAYMENT]: {
        retry: { status: 'paid', substatus: 'succeeded' },
        void: { status: 'void', substatus: 'failed' },
      },
      [ResourceNames.MEMBERSHIP]: {
        cancel: { status: 'canceled' },
        pause: { status: 'paused' },
        resume: { status: 'active' },
        uncancel: { status: 'active' },
      },
      [ResourceNames.INVOICE]: {
        mark_paid: { status: 'paid' },
        mark_uncollectible: { status: 'uncollectible' },
        void: { status: 'void' },
      },
    };

    return transitions[resourceName]?.[action] ?? {};
  }

  private ensureCompanyExists(companyId: string | undefined): ResourceRecord | null {
    if (!companyId) return null;

    const existing = this.store.find(ResourceNames.COMPANY, companyId);
    if (existing) return existing;

    const company = this.exampleGenerator.generate(ResourceNames.COMPANY, { id: companyId });
    return this.store.insert(ResourceNames.COMPANY, company);
  }

  private filterRecords(
    resourceName: string,
    query: Record<string, unknown>
  ): ResourceRecord[] {
    const filters: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(query)) {
      if (!PAGINATION_QUERY_KEYS.includes(key) && key !== 'query') {
        filters[key] = value;
      }
    }

    return this.store.list(resourceName, filters);
  }

  private sortRecords(
    _resourceName: string,
    records: ResourceRecord[],
    _query: Record<string, unknown>
  ): ResourceRecord[] {
    // Default sort by created_at descending
    return [...records].sort((a, b) => {
      const aDate = a.created_at ? new Date(a.created_at as string).getTime() : 0;
      const bDate = b.created_at ? new Date(b.created_at as string).getTime() : 0;
      return bDate - aDate;
    });
  }

  private buildResource(route: RouteEntry, record: ResourceRecord): ResourceRecord {
    return this.responseBuilder.build({
      resourceName: route.resourceName,
      record,
      schema: route.responseSchema,
    });
  }

  private identifierFor(route: RouteEntry, pathParams: Record<string, string>): string {
    const values = Object.values(pathParams);
    if (values.length === 0) {
      throw new WhopMockError(`No identifier available for ${route.path}`);
    }
    return values[0];
  }

  private createPayload(body: unknown): Record<string, unknown> {
    const payload = this.stringifyKeys(body as Record<string, unknown> ?? {});
    // Handle nested body structure
    if (typeof payload.body === 'object' && payload.body !== null) {
      return payload.body as Record<string, unknown>;
    }
    return payload;
  }

  private stringifyKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        result[key] = this.stringifyKeys(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === 'object' && item !== null
            ? this.stringifyKeys(item as Record<string, unknown>)
            : item
        );
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  private listLimit(query: Record<string, unknown>): number {
    const limit = query.limit ?? query.first;
    if (typeof limit === 'number') return limit;
    if (typeof limit === 'string') {
      const parsed = parseInt(limit, 10);
      if (!isNaN(parsed)) return parsed;
    }
    return DEFAULT_LIMIT;
  }

  private isBooleanResponse(route: RouteEntry): boolean {
    return route.responseSchema?.type === 'boolean';
  }
}
