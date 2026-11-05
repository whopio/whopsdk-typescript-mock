import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const manifest = JSON.parse(
  readFileSync(new URL("../tests/parity-cases.json", import.meta.url)),
);

// Exact comparison of already canonicalized synthetic HTTP traces. Do not strip
// unexpected response fields, sort arrays, or silently mask values here.
function differences(a, b, pointer = "") {
  if (Object.is(a, b)) return [];
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return [pointer || "/"];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) => {
    const next = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    return !(key in a) || !(key in b)
      ? [next]
      : differences(a[key], b[key], next);
  });
}

export function compareCaptures(reference, candidate, requirements = manifest) {
  const missing = [];
  for (const [name, capture, kind] of [
    ["reference", reference, "whop_backend"],
    ["candidate", candidate, "mock"],
  ]) {
    if (
      !capture ||
      capture.source?.kind !== kind ||
      !capture.source?.revision ||
      !capture.source?.run_id ||
      !Number.isFinite(Date.parse(capture.source?.captured_at ?? ""))
    )
      missing.push(`${name}: independent source provenance is required`);
    if (capture?.api_version_date !== requirements.api_version_date)
      missing.push(
        `${name}: API date must be ${requirements.api_version_date}`,
      );
    if (capture?.synthetic_data !== true)
      missing.push(`${name}: use synthetic fixtures only`);
    if (!Array.isArray(capture?.cases))
      missing.push(`${name}: cases are required`);
    else if (
      capture.cases.some((row) => !row || typeof row.id !== "string" || !row.id)
    )
      missing.push(`${name}: every case needs an ID`);
  }
  const report = {
    status: "unverified",
    scope: requirements.scope,
    api_version_date: requirements.api_version_date,
    required_cases: requirements.required_cases.length,
    matched_cases: 0,
    missing,
    differences: [],
  };
  if (missing.length) return report;
  const ref = new Map(reference.cases.map((row) => [row.id, row]));
  const mock = new Map(candidate.cases.map((row) => [row.id, row]));
  if (
    ref.size !== reference.cases.length ||
    mock.size !== candidate.cases.length
  )
    missing.push("Duplicate case IDs are not allowed");
  for (const id of requirements.required_cases) {
    const a = ref.get(id),
      b = mock.get(id);
    if (!a || !b) {
      missing.push(id);
      continue;
    }
    if (
      !Array.isArray(a.exchanges) ||
      !a.exchanges.length ||
      !Array.isArray(b.exchanges) ||
      !b.exchanges.length
    ) {
      missing.push(`${id}: request/response exchanges are required`);
      continue;
    }
    if (
      [...a.exchanges, ...b.exchanges].some(
        (row) =>
          !row ||
          !row.request?.method ||
          !row.request?.path ||
          !Number.isInteger(row.response?.status) ||
          !row.response ||
          typeof row.response !== "object" ||
          !("body" in row.response),
      )
    ) {
      missing.push(`${id}: incomplete exchange`);
      continue;
    }
    const diff = differences(a.exchanges, b.exchanges);
    if (diff.length) report.differences.push({ case: id, paths: diff });
    else report.matched_cases++;
  }
  report.status = missing.length
    ? "unverified"
    : report.differences.length
      ? "drift_detected"
      : "scope_matched";
  report.reference = reference.source;
  report.candidate = candidate.source;
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [referencePath, candidatePath] = process.argv.slice(2);
  let reference, candidate;
  try {
    reference = referencePath
      ? JSON.parse(readFileSync(referencePath, "utf8"))
      : undefined;
    candidate = candidatePath
      ? JSON.parse(readFileSync(candidatePath, "utf8"))
      : undefined;
  } catch {
    console.error("Unable to read the capture JSON files.");
    process.exit(2);
  }
  const report = compareCaptures(reference, candidate);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode =
    report.status === "scope_matched"
      ? 0
      : report.status === "drift_detected"
        ? 1
        : 2;
}
