import { parse as parseYaml } from "yaml";

import { jsonSafe } from "./jsonText.js";

/** One Unity YAML document after the `--- !u!class &fileID` header. */
export interface UnityDocument {
  readonly classId: number;
  readonly fileId: string;
  readonly value: unknown;
  readonly error?: string;
}

const quoteIdentifiers = (body: string): string =>
  body
    .replace(/\bguid:\s*([0-9a-fA-F]+)/gu, 'guid: "$1"')
    .replace(/\bfileID:\s*(-?\d+)/gu, 'fileID: "$1"');

/** Split a Unity serialized file into documents. Malformed documents are retained with an error. */
export const readUnityDocuments = (text: string): readonly UnityDocument[] => {
  const parts = text.split(/^--- !u!(\d+) &(-?\d+).*$/mu);
  const documents: UnityDocument[] = [];
  for (let index = 1; index < parts.length; index += 3) {
    const classText = parts[index];
    const fileId = parts[index + 1];
    const body = parts[index + 2];
    if (classText === undefined || fileId === undefined || body === undefined)
      continue;
    const classId = Number(classText);
    try {
      const value = jsonSafe(
        parseYaml(quoteIdentifiers(body), {
          // YAML 1.2 keeps vector keys such as `y`. YAML 1.1 would read `y` as true.
          version: "1.2",
          uniqueKeys: false,
        }),
      );
      documents.push({ classId, fileId, value });
    } catch (cause) {
      documents.push({
        classId,
        fileId,
        value: null,
        error: cause instanceof Error ? cause.message : "YAML parse failed",
      });
    }
  }
  return documents;
};

export const mapping = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const childMapping = (
  value: unknown,
  key: string,
): Record<string, unknown> | undefined => {
  const record = mapping(value);
  return record === undefined ? undefined : mapping(record[key]);
};

/** Drop Unity engine bookkeeping and asset references. Keep caller-visible fields. */
export const simplifyUnityValue = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(simplifyUnityValue);
  const record = mapping(value);
  if (record === undefined) return value ?? null;
  if ("variables" in record && "input" in record) return record.input ?? null;
  if (Array.isArray(record.m_Curve))
    return record.m_Curve.map((key) => {
      const point = mapping(key);
      return [point?.time ?? null, point?.value ?? null];
    });
  const x = mapping(record.x);
  const y = mapping(record.y);
  if (x !== undefined && y !== undefined && "input" in x && "input" in y)
    return { x: x.input ?? null, y: y.input ?? null };
  if ("variableName" in record)
    return {
      var: record.variableName ?? null,
      local: record.localValue ?? null,
    };
  const simplified: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key.startsWith("m_")) continue;
    const itemRecord = mapping(item);
    if (
      itemRecord !== undefined &&
      "fileID" in itemRecord &&
      Object.keys(itemRecord).length <= 3
    )
      continue;
    simplified[key] = simplifyUnityValue(item);
  }
  return simplified;
};

/** Decode a VariablesModule double blob. The layout is the one UnityPy/AssetRipper emit around `m_value`. */
export const decodeVariableDouble = (hexText: string): number | null => {
  const hex = hexText.trim();
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(hex))
    return null;
  const bytes = Buffer.from(hex, "hex");
  const marker = bytes.indexOf("m_value");
  if (marker < 0 || marker + 17 > bytes.length) return null;
  return bytes.readDoubleLE(marker + 9);
};
