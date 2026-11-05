import { bad } from "./current-protocol.js";

export const API_VERSION_DATE = "2026-10-28";
// Behavior checkpoints, not an allowlist. Unknown dates use the preceding checkpoint.
export const MODELED_API_VERSIONS = [
  API_VERSION_DATE,
  "2026-11-03-1",
  "2026-11-04-1",
] as const;

export interface MockApiVersion {
  requested: string;
  effective: string;
}

function parts(value: string): [string, bigint] {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-([1-9]\d*))?$/.exec(value);
  const date = match && new Date(`${match[1]}T00:00:00.000Z`);
  if (
    !match ||
    !date ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== match[1]
  )
    bad(
      "Api-Version-Date must be a valid YYYY-MM-DD or YYYY-MM-DD-N date (N >= 1)",
    );
  return [match![1], BigInt(match![2] ?? "0")];
}

/** Mock convenience: clamp old dates and floor newer dates to implemented behavior. */
export function resolveApiVersion(value?: string | null): MockApiVersion {
  const requested = value ?? API_VERSION_DATE;
  const [day, release] = parts(requested);
  let effective: string = MODELED_API_VERSIONS[0];
  for (const candidate of MODELED_API_VERSIONS) {
    const [candidateDay, candidateRelease] = parts(candidate);
    if (
      candidateDay < day ||
      (candidateDay === day && candidateRelease <= release)
    )
      effective = candidate;
  }
  return { requested, effective };
}

export function apiVersionHeaders(
  version: MockApiVersion,
): Record<string, string> {
  return {
    "x-whop-mock-requested-api-version": version.requested,
    "x-whop-mock-api-version": version.effective,
  };
}

export function withApiVersion(
  response: Response,
  version: MockApiVersion,
): Response {
  for (const [key, value] of Object.entries(apiVersionHeaders(version)))
    response.headers.set(key, value);
  return response;
}
