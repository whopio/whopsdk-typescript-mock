import { createHash } from "node:crypto";
import type { ResourceRecord } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
export function bad(message: string): never {
  throw new ApiError(400, message);
}
export function unsupported(message: string): never {
  throw new ApiError(501, `Mock does not implement ${message}`);
}
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
export type IdempotencyDisposition = "record" | "release" | "unknown";
// Error metadata decides whether to retain a claim; HTTP status alone is insufficient.
// Keep this test/runtime metadata off the wire, including across URL rewriting.
const dispositions = new WeakMap<Response, IdempotencyDisposition>();
export function carryIdempotencyDisposition(
  from: Response,
  to: Response,
): Response {
  const disposition = dispositions.get(from);
  if (disposition) dispositions.set(to, disposition);
  return to;
}
export function errorResponse(error: unknown): Response {
  const e = error as {
    status?: number;
    message?: string;
    code?: string;
    idempotencyDisposition?: IdempotencyDisposition;
  };
  if (typeof e.status !== "number") throw error;
  const types: Record<number, string> = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "unprocessable_entity",
    429: "too_many_requests",
    503: "service_unavailable",
    501: "not_implemented",
  };
  const response = json(
    {
      error: {
        type: types[e.status] ?? "internal_server_error",
        message: e.message,
        ...(e.code ? { code: e.code } : {}),
      },
    },
    e.status,
  );
  dispositions.set(
    response,
    e.idempotencyDisposition ??
      (e.status === 429 ? "release" : e.status === 500 ? "unknown" : "record"),
  );
  return response;
}

/** Actor-scoped POST keys, exact response replay and 24h mock retention. */
export class IdempotencyStore {
  private claims = new Map<
    string,
    { fingerprint: string; expires: number; response?: Response }
  >();
  async run(
    request: Request,
    actor: string,
    context: unknown,
    execute: () => Promise<Response>,
  ): Promise<Response> {
    const key = request.headers.get("idempotency-key");
    if (request.method !== "POST" || key === null) return execute();
    if (!key.trim() || Buffer.byteLength(key) > 255)
      return errorResponse(
        new ApiError(400, "Idempotency-Key must be 1-255 non-blank bytes"),
      );
    const url = new URL(request.url);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([request.method, url.pathname, url.search, context]),
      )
      .update(new Uint8Array(await request.clone().arrayBuffer()))
      .digest("hex");
    const scopedKey = JSON.stringify([actor, key]);
    const old = this.claims.get(scopedKey);
    if (old && old.expires > Date.now()) {
      if (old.fingerprint !== fingerprint)
        return errorResponse(
          new ApiError(
            400,
            "This Idempotency-Key was already used with a different request",
            "idempotency_key_mismatch",
          ),
        );
      if (!old.response)
        return errorResponse(
          new ApiError(
            409,
            "A request with this Idempotency-Key is still in progress",
            "idempotency_request_in_progress",
          ),
        );
      const response = old.response.clone();
      response.headers.set("idempotent-replayed", "true");
      return response;
    }
    const claim = {
      fingerprint,
      expires: Date.now() + 86400000,
      response: undefined as Response | undefined,
    };
    this.claims.set(scopedKey, claim);
    const response = await execute(); // Unknown outcomes leave the claim in flight.
    const disposition = dispositions.get(response) ?? "record";
    if (disposition === "release") this.claims.delete(scopedKey);
    else if (disposition === "record") claim.response = response.clone();
    return response;
  }
}

/** Fixture grants are explicit inputs, not an OAuth or permissions-policy evaluator. */
export interface FetchOptions {
  actorId?: string;
  accountIds?: string[];
  accountId?: string;
  actorKind?: "app" | "account" | "user" | "user_api_key";
  grants?: Record<string, string[]>;
  uploadAllowlist?: boolean;
}
export function can(
  options: FetchOptions,
  account: unknown,
  scope: string,
): boolean {
  if (options.accountIds && !options.accountIds.includes(String(account)))
    return false;
  if (!options.grants) return true;
  const scopes = options.grants[String(account)] ?? [];
  return scopes.includes(scope) || scopes.includes("*");
}
export function readScope(resource: string): string {
  return resource === "dispute" ? "payment:dispute:read" : "payment:basic:read";
}

/** Keyset pagination using fixture insertion order as a stable tie breaker. */
export function paginate(
  rows: { value: ResourceRecord; keys: (string | number | null)[] }[],
  query: URLSearchParams,
  signature: string,
  defaultLimit: number,
): ResourceRecord {
  const limit = (
    value: string | null,
    fallback: number | null,
  ): number | null =>
    value !== null && /^\+?\d+$/.test(value.trim())
      ? Math.min(100, Number(value))
      : fallback;
  const last = limit(query.get("last"), null);
  const first = limit(query.get("first"), last === null ? defaultLimit : null);
  const empty = {
    data: [],
    page_info: {
      start_cursor: null,
      end_cursor: null,
      has_next_page: false,
      has_previous_page: false,
    },
  };
  if (first === 0 || last === 0) return empty;
  const direction = query.get("direction") || "desc";
  const compare = (
    a: (string | number | null)[],
    b: (string | number | null)[],
  ) => {
    for (let i = 0; i < a.length; i++) {
      const av = a[i],
        bv = b[i];
      const result =
        av === bv ? 0 : av === null ? -1 : bv === null ? 1 : av < bv ? -1 : 1;
      if (result) return direction === "asc" ? result : -result;
    }
    return 0;
  };
  const decode = (cursor: string | null): (string | number | null)[] | null => {
    try {
      const [sig, keys] = JSON.parse(
        Buffer.from(cursor ?? "", "base64url").toString(),
      );
      return sig === signature &&
        Array.isArray(keys) &&
        keys.length === (rows[0]?.keys.length ?? keys.length) &&
        keys.length > 0 &&
        keys.length <= 2
        ? keys
        : null;
    } catch {
      return null;
    }
  };
  const after = decode(query.get("after")),
    before = decode(query.get("before"));
  const window = rows
    .sort((a, b) => compare(a.keys, b.keys))
    .filter(
      (row) =>
        (!after || compare(row.keys, after) > 0) &&
        (!before || compare(row.keys, before) < 0),
    );
  const backward = first === null && last !== null;
  const size = (backward ? last : first) ?? defaultLimit;
  let page = backward ? window.slice(-size) : window.slice(0, size);
  const trimmed = first !== null && last !== null && page.length > last;
  if (trimmed) page = page.slice(-last!);
  const next = backward ? before !== null : window.length > size;
  const previous =
    (backward ? window.length > size : after !== null) || trimmed;
  const cursor = (row: (typeof rows)[number]) =>
    Buffer.from(JSON.stringify([signature, row.keys])).toString("base64url");
  return {
    data: page.map((row) => row.value),
    page_info: {
      start_cursor: page.length ? cursor(page[0]) : null,
      end_cursor: next && page.length ? cursor(page.at(-1)!) : null,
      has_next_page: next,
      has_previous_page: previous,
    },
  };
}
