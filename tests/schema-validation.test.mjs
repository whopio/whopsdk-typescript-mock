import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, afterEach } from "node:test";
import Ajv from "ajv";
import WhopMock from "../dist/index.js";

const snapshot = JSON.parse(
  readFileSync(
    new URL("../vendor/current-api-schemas.json", import.meta.url),
  ),
);
const ajv = new Ajv({
  allErrors: true,
  nullable: true,
  schemaId: "auto",
  unknownFormats: "ignore",
  logger: false,
});
ajv.addSchema(snapshot, "whop");
afterEach(() => WhopMock.stop());
test("actual HTTP bodies conform to the independently generated Whop OpenAPI schemas", async () => {
  WhopMock.start();
  const helper = WhopMock.createTestHelper();
  const stack = helper.createDisputeWithPayment({
    dispute: { provider: "stripe" },
  });
  const refund = helper.createRefund({
    payment_id: stack.payment.id,
    amount: 10,
  });
  const transport = WhopMock.createFetch();
  const validate = (name, value) => {
    const validator = ajv.getSchema(`whop#/components/schemas/${name}`);
    assert.ok(validator(value), `${name}: ${JSON.stringify(validator.errors)}`);
  };
  for (const [path, schema] of [
    [`disputes/${stack.dispute.id}`, "Dispute"],
    [`payments/${stack.payment.id}`, "Payment"],
    [`refunds/${refund.id}`, "Refund"],
  ]) {
    const response = await transport(`https://api.whop.mock/api/v1/${path}`);
    assert.equal(response.status, 200);
    validate(schema, await response.json());
  }
  const file = await (
    await transport("https://api.whop.mock/api/v1/files", {
      method: "POST",
      body: JSON.stringify({ filename: "fixture.pdf" }),
    })
  ).json();
  validate("File", file);
  await transport(file.upload_url, {
    method: "PUT",
    headers: file.upload_headers,
    body: Buffer.from("%PDF-1.4\n%%EOF"),
  });
  validate(
    "File",
    await (
      await transport(`https://api.whop.mock/api/v1/files/${file.id}`)
    ).json(),
  );
  const patched = await (
    await transport(
      `https://api.whop.mock/api/v1/disputes/${stack.dispute.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          evidence: {
            documents: [{ id: file.id, document_type: "digital_fulfillment" }],
          },
        }),
      },
    )
  ).json();
  validate("Dispute", patched);
  validate(
    "Dispute",
    WhopMock.emitWebhookEvent("dispute.updated", {
      data: { id: stack.dispute.id },
    }).data,
  );
});
