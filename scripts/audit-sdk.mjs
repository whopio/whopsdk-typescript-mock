// Runtime DTOs are checked by TypeScript against the pinned SDK declarations.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { WhopClient } from "@whop/sdk";
import WhopMock, { API_VERSION_DATE } from "../dist/index.js";

WhopMock.start();
try {
  const fetch = WhopMock.createFetch();
  const client = new WhopClient({
    token: "test-only",
    fetch,
    apiVersionDate: API_VERSION_DATE,
    maxRetries: 0,
  });
  const helper = WhopMock.createTestHelper();
  const stack = helper.createDisputeWithPayment({ payment: { total: 99.99 } });
  const refund = helper.createRefund({
    payment_id: stack.payment.id,
    amount: 20,
  });
  const alert = helper.createDisputeAlert({
    payment_id: stack.payment.id,
    type: "early_fraud_warning",
    source: "tc40",
  });
  const pending = await client.files.create({ filename: "evidence.pdf" });
  await fetch(pending.upload_url, {
    method: "PUT",
    headers: pending.upload_headers,
    body: "%PDF-1.4\n%%EOF",
  });
  await client.disputes.update({
    id: stack.dispute.id,
    evidence: {
      notes: "Contract audit",
      documents: [{ id: pending.id, document_type: "digital_fulfillment" }],
    },
  });
  const samples = {
    Dispute: await client.disputes.retrieve({ id: stack.dispute.id }),
    Payment: await client.payments.retrieve({ id: stack.payment.id }),
    Refund: await client.refunds.retrieve({ id: refund.id }),
    File_: await client.files.retrieve({ id: pending.id }),
    DisputeAlert: await client.disputeAlerts.retrieve({ id: alert.id }),
  };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const virtualPath = path.join(root, "scripts/__current_contract__.mts");
  const source =
    'import type { Whop } from "@whop/sdk";\n' +
    Object.entries(samples)
      .map(
        ([type, value]) =>
          `const ${type.toLowerCase()} = ${JSON.stringify(value)} satisfies Whop.${type}${type === "Dispute" ? " & { fee_charged: boolean }" : type === "Payment" ? " & { user_agent: string | null; wuid: string | null }" : type === "DisputeAlert" ? ' & { category: "fraud" | "customer_dispute" | null }' : ""};`,
      )
      .join("\n");
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, ...args) =>
    filename === virtualPath
      ? ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true)
      : originalGetSourceFile(filename, ...args);
  const diagnostics = ts.getPreEmitDiagnostics(
    ts.createProgram([virtualPath], options, host),
  );
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n",
      }),
    );
  for (const [type, value] of Object.entries(samples)) {
    assert.ok(
      Number.isFinite(Date.parse(value.created_at)),
      `${type} created_at must be ISO time`,
    );
    assert.ok(
      !("company_id" in value),
      `${type} must use the current account vocabulary`,
    );
  }
  assert.equal(samples.Dispute.fee_charged, false);
  assert.equal(samples.Dispute.evidence.documents[0].id, samples.File_.id);
  assert.equal(samples.Refund.payment_id, samples.Payment.id);
  assert.equal(samples.DisputeAlert.payment_id, samples.Payment.id);
  assert.equal(samples.DisputeAlert.category, "fraud");
  const report = {
    checked_at: new Date().toISOString(),
    sdk: JSON.parse(
      readFileSync(
        new URL("../node_modules/@whop/sdk/package.json", import.meta.url),
      ),
    ).version,
    api_version_date: API_VERSION_DATE,
    status: "passed",
    checks: [
      "Current SDK public fetch transport",
      "Dispute, Payment, Refund, File, DisputeAlert DTOs satisfy SDK declarations (including nested values)",
      "ISO creation timestamps",
      "Current account vocabulary",
      "Linked payment/refund/file/alert references",
      "Current fee_charged and alert category fields",
    ],
    limitations:
      "Selected fixture samples and contracts, not live API certification. Additive fields newer than SDK 2.7.0 are checked explicitly and against the vendored OpenAPI. Run npm run test:compat for lifecycle and negative cases.",
  };
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(report, null, 2)
      : `Contract audit passed: SDK ${report.sdk}, API ${API_VERSION_DATE}; five runtime DTOs type-check.`,
  );
} finally {
  WhopMock.stop();
}
