/** JSON value with bigint reduced to a decimal string. */
export const jsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] = jsonSafe(item);
  }
  return out;
};

/**
 * Parse JSON that may contain // comments, block comments, and trailing
 * commas. Single-quoted strings are not accepted.
 */
export const parseRelaxedJson = (text: string): unknown => {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = "";
  let quote: '"' | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (quote !== null) {
      out += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"') {
      quote = '"';
      out += current;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n")
        index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      )
        index += 1;
      index += 1;
      continue;
    }
    out += current;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/gu, "$1"));
};

export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
