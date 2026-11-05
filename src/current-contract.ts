import { readFileSync } from "node:fs";
import Ajv from "ajv";
import { bad } from "./current-protocol.js";

/** Public docs snapshot, shared by fixture validation and independent wire tests. */
export const currentContract = JSON.parse(
  readFileSync(
    new URL("../vendor/current-api-schemas.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({
  allErrors: true,
  nullable: true,
  schemaId: "auto",
  unknownFormats: "ignore",
  logger: false,
});
ajv.addSchema(currentContract, "current");
export function validateCurrentSchema(name: string, data: unknown): void {
  const validator = ajv.getSchema(`current#/components/schemas/${name}`)!;
  if (!validator(data)) bad(`${name}: ${ajv.errorsText(validator.errors)}`);
}
export function validateCurrentBody(
  path: string,
  method: string,
  data: unknown,
): void {
  const schema = currentContract.paths[path]?.[method]?.body;
  if (!schema) return;
  const validator = ajv.compile({
    ...schema,
    components: currentContract.components,
  });
  if (!validator(data)) bad(ajv.errorsText(validator.errors));
}
export function queryChoices(path: string, name: string): string[] {
  const schema = currentContract.paths[path].get.parameters.find(
    (p: { name: string }) => p.name === name,
  )?.schema;
  return schema?.items?.enum ?? schema?.enum ?? [];
}
