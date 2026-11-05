import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { Session } from "./session.js";
import { TestHelper } from "./test-helper.js";
import { ApiError } from "./current-protocol.js";
import {
  disputeResponse,
  paymentResponse,
  refundResponse,
  money,
  EVIDENCE_TEXT_FIELDS,
} from "./current-responses.js";
import type { ResourceRecord } from "./types.js";
import { validateCurrentBody } from "./current-contract.js";

// Test controls only. Reuse the existing fixture helpers and validate their output
// against the independently generated Whop schema before changing the live store.
const snapshot = JSON.parse(
  readFileSync(
    new URL("../vendor/current-api-schemas.json", import.meta.url),
    "utf8",
  ),
);
const schemas = snapshot.components.schemas;
// Local allocation limit, not a restriction in Whop's public Money schema.
schemas.Money.properties.decimals.maximum = 100;
const ajv = new Ajv({
  allErrors: true,
  nullable: true,
  schemaId: "auto",
  unknownFormats: "ignore",
  logger: false,
});
ajv.addSchema(snapshot, "whop");
const inputSchema = (
  name: string,
  excluded: string[],
  extra: ResourceRecord = {},
) => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      Object.keys(schemas[name].properties)
        .filter((key) => !excluded.includes(key))
        .map((key) => [
          key,
          { $ref: `whop#/components/schemas/${name}/properties/${key}` },
        ]),
    ),
    ...extra,
  },
});
const amount = {
  anyOf: [
    { $ref: "whop#/components/schemas/Money" },
    { type: "number", minimum: 0 },
    { type: "null" },
  ],
};
const seedSchema = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: ["scenarios"],
  properties: {
    account_id: {
      type: "string",
      pattern: "^biz_[a-zA-Z0-9_]+$",
      maxLength: 18,
    },
    account: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^biz_[a-zA-Z0-9_]+$", maxLength: 18 },
        title: { type: "string", minLength: 1, maxLength: 255 },
      },
    },
    scenarios: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          payment_status: inputSchema("PaymentStatus", [
            "id",
            "object",
            "account",
          ]),
          fees: {
            type: "array",
            items: { $ref: "whop#/components/schemas/PaymentFee" },
            maxItems: 100,
          },
          runtime: {
            type: "object",
            additionalProperties: false,
            properties: {
              manual_capture: { type: "boolean" },
              return_url_editable: { type: "boolean" },
              buyer_returned: { type: "boolean" },
              resumable: { type: "boolean" },
              void_async: { type: "boolean" },
              retryable: { type: "boolean" },
              manual_retry_attempts: { type: "integer", minimum: 0 },
              refund_status: {
                enum: [
                  "pending",
                  "succeeded",
                  "failed",
                  "canceled",
                  "requires_action",
                ],
              },
              refund_provider: { type: "string" },
              pdf_file_id: { type: "string" },
            },
          },
          create_payment: {
            type: "object",
            additionalProperties: false,
            required: ["request"],
            properties: {
              request: { type: "object" },
            },
          },
          payment: inputSchema(
            "Payment",
            ["account_id", "refunded_amount", "presentment_refunded_amount"],
            { total: amount },
          ),
          dispute: inputSchema(
            "Dispute",
            [
              "account_id",
              "payment",
              "acceptable",
              "evidence_editable",
              "evidence_locked_reason",
              "fee_charged",
            ],
            {
              provider: { type: "string", minLength: 1 },
              sub_provider: { type: ["string", "null"] },
              visa_rdr: { type: "boolean" },
              status: {
                enum: [
                  "needs_response",
                  "warning_needs_response",
                  "under_review",
                  "warning_under_review",
                  "won",
                  "lost",
                  "prevented",
                  "closed",
                  "warning_closed",
                ],
              },
              reason: { type: "string", minLength: 1 },
              buyer: inputSchema("DisputeBuyer", []),
              evidence: {
                type: "object",
                additionalProperties: false,
                properties: Object.fromEntries(
                  EVIDENCE_TEXT_FIELDS.map((key) => [
                    key,
                    { type: ["string", "null"] },
                  ]),
                ),
              },
            },
          ),
          refunds: {
            type: "array",
            maxItems: 100,
            items: {
              ...inputSchema("Refund", ["account_id", "payment_id"], {
                amount,
              }),
              required: ["amount"],
            },
          },
        },
      },
    },
  },
});

function invalid(message: string): never {
  throw new ApiError(400, message);
}
function check(
  validator: Ajv.ValidateFunction,
  value: unknown,
  label: string,
): void {
  if (!validator(value))
    invalid(
      `${label}: ${ajv.errorsText(validator.errors, { dataVar: label, separator: "; " })}`,
    );
}
function checkDates(value: unknown, path = "seed"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      invalid(`Invalid field ${path}.${key}`);
    if (
      key.endsWith("_at") &&
      child !== null &&
      typeof child === "string" &&
      !Number.isFinite(Date.parse(child))
    )
      invalid(`${path}.${key} must be an ISO timestamp`);
    checkDates(child, `${path}.${key}`);
  }
}
function amountValue(value: unknown, currency: string, label: string) {
  let result;
  try {
    result = money(value, currency);
  } catch (error) {
    invalid(`${label}: ${(error as Error).message}`);
  }
  if (
    result.currency !== currency ||
    !/^[a-z]{3}$/.test(currency) ||
    result.decimals < 0 ||
    result.display_decimals < 0 ||
    Number(result.amount) < 0 ||
    !Number.isFinite(Number(result.amount))
  )
    invalid(`${label} needs a non-negative Money amount in ${currency}`);
  const fraction = result.amount.split(".")[1] ?? "";
  if (fraction.length > result.decimals)
    invalid(`${label} exceeds its declared currency precision`);
  const units =
    BigInt(result.amount.split(".")[0]) * 10n ** BigInt(result.decimals) +
    BigInt(fraction.padEnd(result.decimals, "0") || "0");
  return { money: result, units };
}
function fromUnits(units: bigint, template: ReturnType<typeof money>) {
  const digits = units.toString().padStart(template.decimals + 1, "0");
  return {
    ...template,
    amount: template.decimals
      ? `${digits.slice(0, -template.decimals)}.${digits.slice(-template.decimals)}`
      : digits,
  };
}

export function seedScenarios(
  live: Session,
  input: ResourceRecord,
): { account_id: string; scenarios: ResourceRecord[] } {
  check(seedSchema, input, "seed");
  checkDates(input);
  if (input.account && input.account_id)
    invalid(
      "Use account to create a merchant or account_id to append cases, not both",
    );
  const stage = Session.build({ configuration: live.configuration });
  const helper = new TestHelper(stage);
  const reserveId = (
    resource: string,
    value: unknown,
    prefix: string,
  ): string => {
    const id =
      value === undefined
        ? stage.idGenerator.generate(resource)
        : String(value);
    if (!new RegExp(`^${prefix}[a-zA-Z0-9_]+$`).test(id) || id.length > 18)
      invalid(
        `Invalid ${resource} fixture id: use ${prefix} and at most 18 characters`,
      );
    if (live.store.find(resource, id) || stage.store.find(resource, id))
      throw new ApiError(
        409,
        `${resource} ${id} already exists; use new IDs or reset the fixtures`,
      );
    return id;
  };
  let company: ResourceRecord;
  if (input.account_id) {
    const existing = live.store.find("company", String(input.account_id));
    if (!existing) throw new ApiError(404, "Fixture account not found");
    company = stage.store.insert("company", existing);
  } else {
    const account = (input.account ?? {}) as ResourceRecord;
    company = helper.createCompany({
      title: "Custom test merchant",
      ...account,
      id: reserveId("company", account.id, "biz_"),
    });
  }
  const cases: ResourceRecord[] = [];
  for (const entry of input.scenarios as ResourceRecord[]) {
    const p = (entry.payment ?? {}) as ResourceRecord;
    const d = (entry.dispute ?? {}) as ResourceRecord;
    const refunds = (entry.refunds ?? []) as ResourceRecord[];
    const currency = String(
      p.currency ??
        (typeof p.total === "object" && p.total
          ? (p.total as ResourceRecord).currency
          : "usd"),
    );
    const total =
      p.total === null
        ? null
        : amountValue(p.total ?? 99.99, currency, "payment.total");
    const presentment =
      p.presentment_total == null
        ? total
        : amountValue(
            p.presentment_total,
            String((p.presentment_total as ResourceRecord).currency),
            "payment.presentment_total",
          );
    if (!presentment)
      invalid("A null payment.total requires an explicit presentment_total");
    if ((total && total.units <= 0n) || presentment.units <= 0n)
      invalid("Payment amounts must be positive for a dispute fixture");
    const refundAmounts = refunds.map((refund) =>
      refund.amount === null
        ? null
        : amountValue(
            refund.amount,
            String(refund.currency ?? currency),
            "refund.amount",
          ),
    );
    let refunded = 0n;
    let settlementKnown = total !== null;
    let presentmentRefunded = 0n;
    for (let i = 0; i < refunds.length; i++) {
      const refundAmount = refundAmounts[i];
      if (
        (refunds[i].currency ?? refundAmount?.money.currency ?? currency) !==
          currency ||
        (refundAmount &&
          total &&
          refundAmount.money.decimals !== total.money.decimals)
      )
        invalid(
          "Seeded refunds must use the payment's currency and precision; FX is not simulated",
        );
      if (
        (!refundAmount || presentment.money.currency !== currency) &&
        refunds[i].original_amount === undefined
      )
        invalid(
          "Refunds with null or cross-currency amounts need explicit original_amount in the presentment currency; FX is not simulated",
        );
      const original = amountValue(
        refunds[i].original_amount ?? refundAmount!.money,
        presentment.money.currency,
        "refund.original_amount",
      );
      if (original.money.decimals !== presentment.money.decimals)
        invalid("refund.original_amount must use the presentment precision");
      if ((refunds[i].status ?? "succeeded") === "succeeded") {
        if (refundAmount) refunded += refundAmount.units;
        else settlementKnown = false;
        presentmentRefunded += original.units;
      }
    }
    if (total && refunded > total.units)
      invalid("Successful refunds exceed payment.total");
    if (presentmentRefunded > presentment.units)
      invalid(
        "Successful original refund amounts exceed payment.presentment_total",
      );
    const disputeCurrency = String(d.currency ?? presentment.money.currency);
    const disputeTotal =
      disputeCurrency === presentment.money.currency
        ? presentment.money
        : disputeCurrency === currency
          ? total?.money
          : null;
    if (!disputeTotal && d.amount === undefined)
      invalid("A dispute in another currency requires an explicit amount");
    const disputeAmount = d.amount ?? Number(disputeTotal!.amount);
    if (
      typeof disputeAmount !== "number" ||
      disputeAmount < 0 ||
      (disputeTotal && disputeAmount > Number(disputeTotal.amount))
    )
      invalid(
        "dispute.amount must be between zero and the payment amount in that currency",
      );
    const user = p.user as ResourceRecord | null | undefined;
    if (user) {
      const userId = String(user.id);
      if (!/^user_[a-zA-Z0-9_]+$/.test(userId) || userId.length > 18)
        invalid("payment.user.id must use user_ and at most 18 characters");
      const existing =
        stage.store.find("user", userId) ?? live.store.find("user", userId);
      if (existing) {
        if (
          Object.entries(user).some(
            ([key, value]) =>
              JSON.stringify(existing[key]) !== JSON.stringify(value),
          )
        )
          throw new ApiError(
            409,
            `user ${userId} already exists with different profile fields`,
          );
        stage.store.insert("user", existing);
      } else helper.createUser({ ...user, email: p.customer_email ?? null });
    }
    const payment = helper.createPayment({
      ...p,
      _payment_status: entry.payment_status ?? {},
      _fees: entry.fees ?? [],
      _runtime: entry.runtime ?? {},
      ...(user ? { user_id: user.id } : {}),
      id: reserveId("payment", p.id, "pay_"),
      company_id: company.id,
      currency,
      total: total?.money ?? null,
      refunded_amount: settlementKnown
        ? fromUnits(refunded, total!.money)
        : null,
      presentment_refunded_amount: fromUnits(
        presentmentRefunded,
        presentment.money,
      ),
      substatus:
        p.substatus ??
        ((p.status ?? "paid") !== "paid"
          ? "pending"
          : (
                settlementKnown
                  ? refunded === total!.units
                  : presentmentRefunded === presentment.units
              )
            ? "refunded"
            : refunded > 0n || presentmentRefunded > 0n
              ? "partially_refunded"
              : "succeeded"),
    });
    if (entry.create_payment) {
      const creation = entry.create_payment as ResourceRecord;
      const request = creation.request as ResourceRecord;
      if (request.account_id !== company.id)
        invalid(
          "create_payment.request.account_id must match the seeded account",
        );
      validateCurrentBody("/payments", "post", request);
      stage.store.insert("payment_creation", {
        id: String(payment.id),
        request,
        payment,
        payment_status: entry.payment_status ?? {},
      });
    }
    const dispute = helper.createDispute({
      provider: "stripe",
      ...d,
      id: reserveId("dispute", d.id, "dspt_"),
      company_id: company.id,
      payment_id: payment.id,
      currency: disputeCurrency,
      amount: disputeAmount,
    });
    const createdRefunds = refunds.map((refund, i) =>
      helper.createRefund({
        ...refund,
        id: reserveId("refund", refund.id, "rf_"),
        payment_id: payment.id,
        currency,
        amount: refundAmounts[i]?.money ?? null,
      }),
    );
    check(
      ajv.getSchema("whop#/components/schemas/Payment")!,
      paymentResponse(stage.store.find("payment", String(payment.id))!),
      "payment response",
    );
    check(
      ajv.getSchema("whop#/components/schemas/Dispute")!,
      disputeResponse(
        stage.store.find("dispute", String(dispute.id))!,
        stage.store,
      ),
      "dispute response",
    );
    for (const refund of createdRefunds)
      check(
        ajv.getSchema("whop#/components/schemas/Refund")!,
        refundResponse(refund, stage.store),
        "refund response",
      );
    cases.push({
      dispute_id: dispute.id,
      payment_id: payment.id,
      refund_ids: createdRefunds.map((refund) => refund.id),
    });
  }
  // Only commit after the whole batch passes. Staging uses the same original engine,
  // without replacing the server's global session or disturbing in-flight uploads.
  for (const resource of [
    "company",
    "user",
    "payment",
    "dispute",
    "refund",
    "payment_creation",
  ])
    for (const row of stage.store.list(resource)) {
      if (resource === "company" && input.account_id) continue;
      live.store.insert(resource, row);
    }
  return { account_id: String(company.id), scenarios: cases };
}
