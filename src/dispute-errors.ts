import { ApiError } from "./current-protocol.js";

// Error codes modeled for fixture recovery tests.
export function disputeFailure(code: string, message: string): never {
  throw new ApiError(400, message, code);
}

// Format byte sizes with binary units and three significant digits.
// A limit rounds down, so it cannot display as large as a slightly oversized file.
export function humanBytes(bytes: number, down = false): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "Byte" : "Bytes"}`;
  const units = ["KB", "MB", "GB", "TB"];
  const power = Math.min(
    units.length,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** power;
  const places = 2 - Math.floor(Math.log10(value));
  const factor = 10 ** places;
  const rounded =
    (down ? Math.floor(value * factor) : Math.round(value * factor)) / factor;
  return `${Number(rounded.toFixed(Math.max(0, places)))} ${units[power - 1]}`;
}
