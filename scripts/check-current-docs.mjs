import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import yaml from "js-yaml";

// Read-only drift check. A pass establishes published shape agreement, not backend execution.
const snapshot = JSON.parse(
  readFileSync(
    new URL("../vendor/current-api-schemas.json", import.meta.url),
    "utf8",
  ),
);
const root = "https://docs.whop.com";
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}
function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "description",
            "example",
            "examples",
            "summary",
            "externalDocs",
            "tags",
            "discriminator",
          ].includes(key) && !key.startsWith("x-"),
      )
      .map(([key, child]) => [key, strip(child)]),
  );
}
try {
  const indexes = await Promise.all(
    [
      "/_llms/for-developers/api-reference/current-api.txt",
      "/_llms/for-developers/api-reference/current-api/payments.txt",
    ].map((path) => download(root + path)),
  );
  const urls = [
    ...new Set(
      indexes
        .join("\n")
        .match(
          /https:\/\/docs\.whop\.com\/api-reference\/beta\/(?:disputes|dispute-alerts|payments|refunds|files|webhooks)\/[^)\s]+\.md/g,
        ),
    ),
  ];
  const schemas = {},
    operations = {},
    extracted = {
      paths: {},
      webhooks: {},
      components: { schemas, parameters: {} },
    };
  const versions = new Set();
  const webhookPages = new Set(),
    missingWebhookBodies = new Set();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      while (cursor < urls.length) {
        const url = urls[cursor++];
        const page = await download(url),
          block = page.match(/````yaml[^\n]*\n([\s\S]*?)\n````/);
        if (!block) {
          // These six model overview pages have no embedded OpenAPI; endpoint pages do.
          if (
            /\/(dispute|dispute-alert|payment|refund|file|webhook)\.md$/.test(
              url,
            )
          )
            continue;
          throw new Error(`No readable OpenAPI block in ${url}`);
        }
        const spec = yaml.load(block[1]);
        const webhookName = page.match(/````yaml[^\n]* webhook ([^\s]+)/)?.[1];
        if (webhookName) {
          webhookPages.add(webhookName);
          if (!spec.webhooks?.[webhookName])
            missingWebhookBodies.add(webhookName);
        }
        Object.assign(extracted.webhooks, spec.webhooks ?? {});
        extracted.info = spec.info;
        versions.add(spec.info?.["x-api-version-date"]);
        Object.assign(schemas, spec.components?.schemas ?? {});
        Object.assign(
          extracted.components.parameters,
          spec.components?.parameters ?? {},
        );
        for (const [path, methods] of Object.entries(spec.paths ?? {})) {
          extracted.paths[path] ??= {};
          for (const [method, op] of Object.entries(methods))
            if (["get", "post", "patch", "delete"].includes(method)) {
              extracted.paths[path][method] = op;
              const body =
                op.requestBody?.content?.["application/json"]?.schema;
              const content = op.requestBody?.content;
              const otherBodies = Object.fromEntries(
                Object.entries(content ?? {})
                  .filter(
                    ([type, value]) =>
                      type !== "application/json" &&
                      !isDeepStrictEqual(strip(value.schema), strip(body)),
                  )
                  .map(([type, value]) => [type, strip(value.schema)]),
              );
              operations[`${method.toUpperCase()} ${path}`] = {
                operationId: op.operationId,
                parameters: strip(
                  (op.parameters ?? []).map((p) =>
                    p.$ref
                      ? spec.components.parameters[p.$ref.split("/").at(-1)]
                      : p,
                  ),
                ),
                ...(body ? { body: strip(body) } : {}),
                ...(content
                  ? {
                      request_content_types: Object.keys(content),
                      body_required: op.requestBody.required ?? false,
                    }
                  : {}),
                ...(Object.keys(otherBodies).length
                  ? { other_bodies: otherBodies }
                  : {}),
                responses: Object.fromEntries(
                  Object.entries(op.responses).map(([status, response]) => [
                    status,
                    strip(response.content?.["application/json"]?.schema ?? {}),
                  ]),
                ),
              };
            }
        }
      }
    }),
  );
  const differences = [];
  extracted.webhook_events = [...webhookPages].sort();
  for (const name of webhookPages)
    if (!snapshot.webhook_events?.includes(name))
      differences.push({ webhook: name, reason: "new_documented_webhook" });
  for (const name of snapshot.webhook_events ?? [])
    if (!webhookPages.has(name))
      differences.push({ webhook: name, reason: "webhook_missing_from_index" });
  for (const name of webhookPages) {
    const actual = extracted.webhooks[name]?.post;
    const expected = snapshot.webhooks?.[name];
    if (
      actual &&
      !isDeepStrictEqual(
        {
          parameters: strip(actual.parameters ?? []),
          body: strip(actual.requestBody.content["application/json"].schema),
        },
        expected,
      )
    )
      differences.push({
        webhook: name,
        reason: "published_webhook_shape_added_or_changed",
      });
    else if (!actual && expected)
      differences.push({
        webhook: name,
        reason: "published_webhook_shape_missing",
      });
  }
  if (versions.size !== 1 || !versions.has(snapshot.api_version_date))
    differences.push({
      reason: "published_version_changed",
      expected: snapshot.api_version_date,
      actual: [...versions],
    });
  for (const [operation, actual] of Object.entries(operations)) {
    const [method, path] = operation.split(" "),
      expected = snapshot.paths[path]?.[method.toLowerCase()];
    if (!expected)
      differences.push({ operation, reason: "new_documented_operation" });
    else if (!isDeepStrictEqual(actual, expected))
      differences.push({ operation, reason: "request_or_response_changed" });
  }
  for (const [name, expected] of Object.entries(snapshot.components.schemas))
    if (!schemas[name])
      differences.push({ schema: name, reason: "missing_documented_schema" });
    else if (!isDeepStrictEqual(strip(schemas[name]), expected))
      differences.push({ schema: name, reason: "schema_changed" });
  for (const [path, methods] of Object.entries(snapshot.paths))
    for (const method of Object.keys(methods)) {
      const operation = `${method.toUpperCase()} ${path}`;
      if (!operations[operation])
        differences.push({
          operation,
          reason: "no_longer_in_documentation_index",
        });
    }
  // Optional audit input for sync-current-contract; keep it under an ignored local directory.
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(extracted, null, 2) + "\n");
  console.log(
    JSON.stringify(
      {
        status: differences.length
          ? "review_required"
          : "published_contract_matches",
        pages_read: urls.length,
        documented_operations: Object.keys(operations).length,
        documented_webhook_events: webhookPages.size,
        webhook_payload_verification: missingWebhookBodies.size
          ? "unavailable_in_public_export"
          : "published_shapes_checked",
        referenced_schemas: Object.keys(schemas).length,
        documented_version: extracted.info?.["x-api-version-date"],
        backend_execution: "unverified",
        differences,
      },
      null,
      2,
    ),
  );
  process.exitCode = differences.length ? 1 : 0;
} catch (error) {
  console.error(`Documentation check incomplete: ${error.message}`);
  process.exitCode = 2;
}
