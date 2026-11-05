import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCaptures } from "../scripts/check-parity.mjs";

// These exercise the comparator, not actual backend parity; no reference capture
// is generated or saved from this test.
const requirements = {
  scope: "Comparator unit fixture",
  api_version_date: "2026-10-28",
  required_cases: ["read"],
};
const capture = (kind) => ({
  source: {
    kind,
    revision: "synthetic-comparator-fixture",
    run_id: "unit-test",
    captured_at: "2026-11-04T00:00:00Z",
  },
  api_version_date: "2026-10-28",
  synthetic_data: true,
  cases: [
    {
      id: "read",
      exchanges: [
        {
          request: { method: "GET", path: "/api/v1/disputes/$dispute" },
          response: {
            status: 200,
            body: { evidence_editable: false, evidence_submitted_at: null },
          },
        },
      ],
    },
  ],
});

test("parity stays unverified without independent reference evidence", () => {
  assert.equal(
    compareCaptures(undefined, capture("mock"), requirements).status,
    "unverified",
  );
  assert.equal(
    compareCaptures(capture("mock"), capture("mock"), requirements).status,
    "unverified",
  );
});
test("matching captures cover only the declared contract scope", () => {
  const result = compareCaptures(
    capture("whop_backend"),
    capture("mock"),
    requirements,
  );
  assert.equal(result.status, "scope_matched");
  assert.equal(result.matched_cases, 1);
});
test("status, missing/null distinctions and unexpected fields are differences", () => {
  const reference = capture("whop_backend"),
    candidate = capture("mock");
  candidate.cases[0].exchanges[0].response.status = 400;
  delete candidate.cases[0].exchanges[0].response.body.evidence_submitted_at;
  candidate.cases[0].exchanges[0].response.body.company_id = "unexpected";
  const result = compareCaptures(reference, candidate, requirements);
  assert.equal(result.status, "drift_detected");
  assert.equal(result.differences[0].paths.length, 3);
  assert.ok(!JSON.stringify(result.differences).includes("unexpected")); // report paths, not fixture values
});
test("missing cases, wrong API dates and empty exchanges cannot pass", () => {
  for (const mutate of [
    (value) => (value.cases = []),
    (value) => (value.api_version_date = "old"),
    (value) => (value.cases[0].exchanges = []),
    (value) => (value.cases = [null]),
    (value) => (value.cases[0].exchanges = [null]),
  ]) {
    const candidate = capture("mock");
    mutate(candidate);
    assert.equal(
      compareCaptures(capture("whop_backend"), candidate, requirements).status,
      "unverified",
    );
  }
});
