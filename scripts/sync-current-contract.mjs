import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// Input is the scope export produced by check:docs from docs.whop.com.
const [docsPath] = process.argv.slice(2);
if (!docsPath)
  throw new Error(
    "Usage: node scripts/sync-current-contract.mjs PUBLIC_DOCS_SCOPE_JSON",
  );
const live = JSON.parse(readFileSync(docsPath, "utf8"));
const paths = Object.fromEntries(
  Object.entries(live.paths)
    .filter(([path]) =>
      /^\/(disputes|payments|refunds|files|webhooks)(\/|$)/.test(path),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);
const strip = (value) => {
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
};
const operations = {};
for (const [path, methods] of Object.entries(paths)) {
  operations[path] = {};
  const methodOrder = ["get", "delete", "patch", "post"];
  for (const [method, operation] of Object.entries(methods).sort(
    ([a], [b]) => methodOrder.indexOf(a) - methodOrder.indexOf(b),
  )) {
    if (!["get", "post", "patch", "delete"].includes(method)) continue;
    const body = operation.requestBody?.content?.["application/json"]?.schema;
    const content = operation.requestBody?.content;
    const otherBodies = Object.fromEntries(
      Object.entries(content ?? {})
        .filter(
          ([type, value]) =>
            type !== "application/json" &&
            !isDeepStrictEqual(strip(value.schema), strip(body)),
        )
        .map(([type, value]) => [type, strip(value.schema)]),
    );
    operations[path][method] = {
      operationId: operation.operationId,
      parameters: strip(
        (operation.parameters ?? []).map((p) =>
          p.$ref ? live.components.parameters?.[p.$ref.split("/").at(-1)] : p,
        ),
      ),
      ...(body ? { body: strip(body) } : {}),
      ...(content
        ? {
            request_content_types: Object.keys(content),
            body_required: operation.requestBody.required ?? false,
          }
        : {}),
      ...(Object.keys(otherBodies).length ? { other_bodies: otherBodies } : {}),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, response]) => [
          status,
          strip(response.content?.["application/json"]?.schema ?? {}),
        ]),
      ),
    };
  }
}
// Include payload schemas only when the public export actually supplies them.
const webhooks = Object.fromEntries(
  Object.entries(live.webhooks ?? {})
    .filter(([name]) => /^(dispute|payment|refund)\./.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, methods]) => [
      name,
      {
        parameters: strip(methods.post.parameters ?? []),
        body: strip(
          methods.post.requestBody.content["application/json"].schema,
        ),
      },
    ]),
);
const allSchemas = live.components.schemas;
const schemas = {};
function visit(value) {
  if (!value || typeof value !== "object") return;
  if (value.$ref?.startsWith("#/components/schemas/")) {
    const name = value.$ref.split("/").at(-1);
    if (!schemas[name]) {
      if (!allSchemas[name]) throw new Error(`Missing schema ${name}`);
      schemas[name] = strip(allSchemas[name]);
      visit(schemas[name]);
    }
  }
  for (const child of Object.values(value)) visit(child);
}
visit(operations);
visit(webhooks);
const snapshot = {
  api_version_date: live.info["x-api-version-date"],
  paths: operations,
  webhook_events: [...(live.webhook_events ?? [])].sort(),
  ...(Object.keys(webhooks).length ? { webhooks } : {}),
  components: { schemas },
};
function format(value, depth = 0) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  // Keep short schemas/references on one line so the required snapshot stays reviewable.
  const compact = JSON.stringify(value);
  if (compact.length <= 100) return compact;
  if (
    Array.isArray(value) &&
    value.every((item) => item === null || typeof item !== "object")
  )
    return JSON.stringify(value);
  const indent = "  ".repeat(depth + 1),
    close = "  ".repeat(depth);
  if (Array.isArray(value))
    return `[\n${value.map((item) => indent + format(item, depth + 1)).join(",\n")}\n${close}]`;
  const entries = Object.entries(value);
  return entries.length
    ? `{\n${entries.map(([key, item]) => `${indent}${JSON.stringify(key)}: ${format(item, depth + 1)}`).join(",\n")}\n${close}}`
    : "{}";
}
writeFileSync(
  new URL("../vendor/current-api-schemas.json", import.meta.url),
  format(snapshot) + "\n",
);
console.log(
  `${Object.values(operations).reduce((n, methods) => n + Object.keys(methods).length, 0)} operations; ${Object.keys(schemas).length} referenced schemas`,
);
