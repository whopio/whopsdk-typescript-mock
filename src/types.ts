export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type RouteAction =
  | 'list'
  | 'search'
  | 'create'
  | 'retrieve'
  | 'update'
  | 'delete'
  | string; // custom actions

export interface RouteEntry {
  action: RouteAction;
  method: HttpMethod;
  operationId?: string;
  path: string;
  resourceName: string;
  memberAction: boolean;
  requestSchema?: OpenAPISchema;
  responseSchema?: OpenAPISchema;
}

export interface RouteMatch {
  route: RouteEntry;
  pathParams: Record<string, string>;
}

export interface OpenAPISpec {
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: {
    schemas?: Record<string, OpenAPISchema>;
  };
}

export interface OpenAPIOperation {
  operationId?: string;
  requestBody?: {
    content?: {
      'application/json'?: {
        schema?: OpenAPISchema;
      };
    };
  };
  responses?: Record<string, {
    content?: {
      'application/json'?: {
        schema?: OpenAPISchema;
      };
    };
  }>;
}

export interface OpenAPISchema {
  type?: string;
  properties?: Record<string, OpenAPISchema>;
  items?: OpenAPISchema;
  $ref?: string;
  enum?: string[];
  format?: string;
  allOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
}

export interface MockRequest {
  method: HttpMethod | string;
  url?: string;
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface PaginatedResponse<T = Record<string, unknown>> {
  data: T[];
  page_info: {
    end_cursor: string | null;
    has_next_page: boolean;
  };
}

export type ResourceRecord = Record<string, unknown>;

// ========== Resource Interfaces ==========

export interface CompanyRecord extends ResourceRecord {
  id: string;
  title: string;
  route?: string;
}

export interface UserRecord extends ResourceRecord {
  id: string;
  username: string;
  name: string | null;
  email?: string | null;
}

export interface PaymentRecord extends ResourceRecord {
  id: string;
  total: number;
  subtotal: number;
  usd_total?: number;
  currency: string;
  created_at: string;
  paid_at: string | null;
  status: string;
  company_id?: string;
  dispute_alerted_at?: string | null;
  payment_method_type?: string;
  billing_reason?: string | null;
  card_brand?: string;
  card_last4?: string;
  user?: UserRecord | null;
  member?: { id: string; phone?: string | null } | null;
  membership?: { id: string; status: string } | null;
}

export interface CompactCompany {
  id: string;
  title: string;
}

export interface CompactUser {
  id: string;
  name: string | null;
  username: string;
}

export interface CompactPayment {
  id: string;
  total: number;
  subtotal: number;
  usd_total: number | null;
  currency: string;
  created_at: string;
  paid_at: string | null;
  dispute_alerted_at: string | null;
  payment_method_type: string;
  billing_reason: string | null;
  card_brand: string;
  card_last4: string;
  user: UserRecord | null;
  member: { id: string; phone?: string | null } | null;
  membership: { id: string; status: string } | null;
}

export interface CompactDispute {
  id: string;
  amount: number;
  currency: string;
  status: string;
  reason: string | null;
  created_at: string;
}

export interface CompactResolutionPayment {
  id: string;
  currency: string;
  created_at: string;
  paid_at: string | null;
  total: number;
  subtotal: number;
}

export interface DisputeRecord extends ResourceRecord {
  id: string;
  status: DisputeStatus;
  amount: number;
  currency: string;
  reason: string | null;
  created_at: string;
  visa_rdr: boolean;
  editable: boolean;
  needs_response_by: string | null;
  company?: CompactCompany | null;
  payment?: CompactPayment | null;
}

export interface DisputeAlertRecord extends ResourceRecord {
  id: string;
  alert_type: DisputeAlertType;
  amount: number;
  currency: string;
  created_at: string;
  charge_for_alert: boolean;
  transaction_date: string | null;
  payment?: CompactPayment | null;
  dispute?: CompactDispute | null;
}

export interface ResolutionCaseRecord extends ResourceRecord {
  id: string;
  status: ResolutionCaseStatus;
  issue: string;
  created_at: string;
  updated_at: string;
  due_date: string | null;
  customer_appealed: boolean;
  merchant_appealed: boolean;
  company?: CompactCompany | null;
  user?: CompactUser | null;
  payment?: CompactResolutionPayment | null;
}

// ========== Status Enums ==========

export type DisputeStatus =
  | 'warning_needs_response'
  | 'warning_under_review'
  | 'warning_closed'
  | 'needs_response'
  | 'under_review'
  | 'won'
  | 'lost'
  | 'closed'
  | 'other';

export type DisputeAlertType = 'DISPUTE' | 'DISPUTE_RDR' | 'FRAUD';

export type ResolutionCaseStatus =
  | 'merchant_response_needed'
  | 'customer_response_needed'
  | 'merchant_info_needed'
  | 'customer_info_needed'
  | 'under_platform_review'
  | 'customer_won'
  | 'merchant_won'
  | 'customer_withdrew';

export type PayoutAccountStatus =
  | 'connected'
  | 'disabled'
  | 'action_required'
  | 'pending_verification'
  | 'verification_failed'
  | 'not_started';

export type WithdrawalStatus =
  | 'requested'
  | 'awaiting_payment'
  | 'completed'
  | 'denied'
  | 'canceled'
  | 'drafted'
  | 'failed';

export interface WhopMockConfiguration {
  debug?: boolean;
  debugOutput?: (message: string) => void;
  specPath?: string;
  apiBasePath?: string;
  idPrefixes?: Record<string, string>;
}

export interface ErrorInjection {
  errorClass: new (message?: string) => Error;
  actionKey: string;
  message?: string;
  attributes?: Record<string, unknown>;
}

export type FallbackHandler = (params: {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
}) => [number, unknown] | unknown | null;

export const ResourceNames = {
  ACCOUNT_LINK: 'account_link',
  CHECKOUT_CONFIGURATION: 'checkout_configuration',
  COMPANY: 'company',
  DISPUTE: 'dispute',
  DISPUTE_ALERT: 'dispute_alert',
  FEE_MARKUP: 'fee_markup',
  INVOICE: 'invoice',
  LEDGER_ACCOUNT: 'ledger_account',
  LEDGER_PAYOUT_ACCOUNT: 'ledger_payout_account',
  MEMBER: 'member',
  MEMBERSHIP: 'membership',
  PAYMENT: 'payment',
  PAYMENT_METHOD: 'payment_method',
  PAYMENT_TOKEN: 'payment_token',
  PROMO_CODE: 'promo_code',
  SETUP_INTENT: 'setup_intent',
  PAYOUT_ACCOUNT: 'payout_account',
  PAYOUT_DESTINATION: 'payout_destination',
  PAYOUT_METHOD: 'payout_method',
  PLAN: 'plan',
  PRODUCT: 'product',
  REFUND: 'refund',
  RESOLUTION_CASE: 'resolution_case',
  RESOLUTION_EVENT: 'resolution_event',
  TOPUP: 'topup',
  TRANSFER: 'transfer',
  USER: 'user',
  VERIFICATION: 'verification',
  WITHDRAWAL: 'withdrawal',
} as const;

export type ResourceName = typeof ResourceNames[keyof typeof ResourceNames];
