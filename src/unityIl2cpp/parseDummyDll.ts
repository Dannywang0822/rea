import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** One field from a Cpp2IL dummy DLL. Method bodies are not read. */
export interface DummyDllField {
  readonly name: string;
  readonly signature: string;
  readonly static: boolean;
  readonly literal: boolean;
  readonly constant?: string | number | boolean | null;
}

/** One type from a Cpp2IL dummy DLL. */
export interface DummyDllType {
  readonly namespace: string;
  readonly name: string;
  readonly fields: readonly DummyDllField[];
}

/** Metadata this reader does not understand. The DLL is skipped, not mis-parsed. */
export class DummyDllStructureError extends Error {
  readonly _tag = "DummyDllStructureError" as const;

  constructor(message: string) {
    super(message);
    this.name = "DummyDllStructureError";
  }
}

const MAX_DLL_BYTES = 32 * 1024 * 1024;

type Column =
  | { readonly kind: "u2" }
  | { readonly kind: "u4" }
  | { readonly kind: "str" }
  | { readonly kind: "guid" }
  | { readonly kind: "blob" }
  | { readonly kind: "table"; readonly table: number }
  | {
      readonly kind: "coded";
      readonly tagBits: number;
      readonly tables: readonly number[];
    };

const u2 = { kind: "u2" } as const;
const u4 = { kind: "u4" } as const;
const str = { kind: "str" } as const;
const guid = { kind: "guid" } as const;
const blob = { kind: "blob" } as const;
const table = (index: number): Column => ({ kind: "table", table: index });
const coded = (tagBits: number, tables: readonly number[]): Column => ({
  kind: "coded",
  tagBits,
  tables,
});

const TYPE_DEF_OR_REF = coded(2, [0x02, 0x01, 0x1b]);
const RESOLUTION_SCOPE = coded(2, [0x00, 0x1a, 0x23, 0x01]);
const HAS_CONSTANT = coded(2, [0x04, 0x08, 0x17]);
const HAS_CUSTOM_ATTRIBUTE = coded(
  5,
  [
    0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11,
    0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b,
  ],
);
const HAS_FIELD_MARSHAL = coded(1, [0x04, 0x08]);
const HAS_DECL_SECURITY = coded(2, [0x02, 0x06, 0x20]);
const MEMBER_REF_PARENT = coded(3, [0x02, 0x01, 0x1a, 0x06, 0x1b]);
const HAS_SEMANTICS = coded(1, [0x14, 0x17]);
const METHOD_DEF_OR_REF = coded(1, [0x06, 0x0a]);
const MEMBER_FORWARDED = coded(1, [0x04, 0x06]);
const IMPLEMENTATION = coded(2, [0x26, 0x23, 0x27]);
const CUSTOM_ATTRIBUTE_TYPE = coded(3, [0x06, 0x0a]);
const TYPE_OR_METHOD_DEF = coded(1, [0x02, 0x06]);

/** ECMA-335 table column layouts, index 0x00 through 0x2C. */
const TABLE_COLUMNS: readonly (readonly Column[])[] = [
  [u2, str, guid, guid, guid],
  [RESOLUTION_SCOPE, str, str],
  [u4, str, str, TYPE_DEF_OR_REF, table(0x04), table(0x06)],
  [table(0x04)],
  [u2, str, blob],
  [table(0x06)],
  [u4, u2, u2, str, blob, table(0x08)],
  [table(0x08)],
  [u2, u2, str],
  [table(0x02), TYPE_DEF_OR_REF],
  [MEMBER_REF_PARENT, str, blob],
  [u2, HAS_CONSTANT, blob],
  [HAS_CUSTOM_ATTRIBUTE, CUSTOM_ATTRIBUTE_TYPE, blob],
  [HAS_FIELD_MARSHAL, blob],
  [u2, HAS_DECL_SECURITY, blob],
  [u2, u4, table(0x02)],
  [u4, table(0x04)],
  [blob],
  [table(0x02), table(0x14)],
  [table(0x14)],
  [u2, str, TYPE_DEF_OR_REF],
  [table(0x02), table(0x17)],
  [table(0x17)],
  [u2, str, blob],
  [u2, table(0x06), HAS_SEMANTICS],
  [table(0x02), METHOD_DEF_OR_REF, METHOD_DEF_OR_REF],
  [str],
  [blob],
  [u2, MEMBER_FORWARDED, str, table(0x1a)],
  [u4, table(0x04)],
  [u4, u4],
  [u4],
  [u4, u2, u2, u2, u2, u4, blob, str, str],
  [u4],
  [u4, u4, u4],
  [u2, u2, u2, u2, u4, blob, str, str, blob],
  [u4, table(0x23)],
  [u4, u4, u4, table(0x23)],
  [u4, str, blob],
  [u4, u4, str, str, IMPLEMENTATION],
  [u4, u4, str, IMPLEMENTATION],
  [table(0x02), table(0x02)],
  [u2, u2, TYPE_OR_METHOD_DEF, str],
  [METHOD_DEF_OR_REF, blob],
  [table(0x2a), TYPE_DEF_OR_REF],
];

const ELEMENT_TYPE: Readonly<Record<number, string>> = {
  0x01: "void",
  0x02: "boolean",
  0x03: "char",
  0x04: "int8",
  0x05: "uint8",
  0x06: "int16",
  0x07: "uint16",
  0x08: "int32",
  0x09: "uint32",
  0x0a: "int64",
  0x0b: "uint64",
  0x0c: "float32",
  0x0d: "float64",
  0x0e: "string",
  0x0f: "pointer",
  0x10: "byref",
  0x11: "valuetype",
  0x12: "class",
  0x13: "generic-parameter",
  0x14: "array",
  0x15: "generic-instance",
  0x16: "typed-by-reference",
  0x18: "native-int",
  0x19: "native-uint",
  0x1b: "function-pointer",
  0x1c: "object",
  0x1d: "szarray",
  0x1e: "generic-method-parameter",
};

interface Heaps {
  readonly stringIndex: number;
  readonly guidIndex: number;
  readonly blobIndex: number;
}

const need = (bytes: Buffer, offset: number, size: number): void => {
  if (offset < 0 || size < 0 || offset + size > bytes.length)
    throw new DummyDllStructureError("truncated CLI metadata");
};

const readCompressed = (
  bytes: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } => {
  need(bytes, offset, 1);
  const first = bytes[offset] ?? 0;
  if ((first & 0x80) === 0) return { value: first, next: offset + 1 };
  if ((first & 0xc0) === 0x80) {
    need(bytes, offset, 2);
    return {
      value: ((first & 0x3f) << 8) | (bytes[offset + 1] ?? 0),
      next: offset + 2,
    };
  }
  need(bytes, offset, 4);
  return {
    value:
      ((first & 0x1f) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0),
    next: offset + 4,
  };
};

const indexWidth = (count: number): number => (count < 65536 ? 2 : 4);

const columnWidth = (
  column: Column,
  heaps: Heaps,
  counts: readonly number[],
): number => {
  switch (column.kind) {
    case "u2":
      return 2;
    case "u4":
      return 4;
    case "str":
      return heaps.stringIndex;
    case "guid":
      return heaps.guidIndex;
    case "blob":
      return heaps.blobIndex;
    case "table":
      return indexWidth(counts[column.table] ?? 0);
    case "coded": {
      let max = 0;
      for (const tableIndex of column.tables)
        max = Math.max(max, counts[tableIndex] ?? 0);
      return max < 2 ** (16 - column.tagBits) ? 2 : 4;
    }
    default: {
      const unreachable: never = column;
      return unreachable;
    }
  }
};

const readUnsigned = (bytes: Buffer, offset: number, width: number): number => {
  need(bytes, offset, width);
  if (width === 2) return bytes.readUInt16LE(offset);
  if (width === 4) return bytes.readUInt32LE(offset);
  throw new DummyDllStructureError(`unsupported index width ${String(width)}`);
};

const cString = (heap: Buffer, index: number): string => {
  if (index < 0 || index >= heap.length) return "";
  const end = heap.indexOf(0, index);
  return heap.subarray(index, end < 0 ? heap.length : end).toString("utf8");
};

const readBlob = (heap: Buffer, index: number): Buffer => {
  const length = readCompressed(heap, index);
  need(heap, length.next, length.value);
  return heap.subarray(length.next, length.next + length.value);
};

const describeType = (
  bytes: Buffer,
  offset: number,
): { readonly text: string; readonly next: number } => {
  const kind = bytes[offset];
  if (kind === undefined) return { text: "invalid", next: offset };
  if (kind === 0x11 || kind === 0x12) {
    const token = readCompressed(bytes, offset + 1);
    const label = ELEMENT_TYPE[kind] ?? "type";
    return { text: `${label}:${String(token.value)}`, next: token.next };
  }
  if (kind === 0x1d) {
    const inner = describeType(bytes, offset + 1);
    return { text: `${inner.text}[]`, next: inner.next };
  }
  return {
    text: ELEMENT_TYPE[kind] ?? `element:0x${kind.toString(16)}`,
    next: offset + 1,
  };
};

const fieldSignature = (blob: Buffer): string => {
  if (blob.length === 0) return "empty";
  const start = blob[0] === 0x06 ? 1 : 0;
  try {
    return describeType(blob, start).text;
  } catch (cause) {
    if (cause instanceof DummyDllStructureError)
      return `blob:${blob.subarray(0, 16).toString("hex")}`;
    throw cause;
  }
};

const constantValue = (
  elementType: number,
  blob: Buffer,
): string | number | boolean | null | undefined => {
  try {
    switch (elementType) {
      case 0x02:
        return (blob[0] ?? 0) !== 0;
      case 0x03:
      case 0x04:
      case 0x05:
        return blob.length >= 1 ? blob.readInt8(0) : undefined;
      case 0x06:
      case 0x07:
        return blob.length >= 2 ? blob.readInt16LE(0) : undefined;
      case 0x08:
      case 0x09:
        return blob.length >= 4 ? blob.readInt32LE(0) : undefined;
      case 0x0a:
      case 0x0b:
        return blob.length >= 8 ? blob.readBigInt64LE(0).toString() : undefined;
      case 0x0c:
        return blob.length >= 4 ? blob.readFloatLE(0) : undefined;
      case 0x0d:
        return blob.length >= 8 ? blob.readDoubleLE(0) : undefined;
      case 0x0e:
        return blob.toString("utf16le").replace(/\0$/u, "");
      case 0x12:
        return null;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

interface TypeRow {
  readonly namespace: string;
  readonly name: string;
  readonly fieldList: number;
}

interface FieldRow {
  readonly name: string;
  readonly signature: string;
  readonly static: boolean;
  readonly literal: boolean;
  readonly constant?: string | number | boolean | null;
}

const rvaToOffset = (
  sections: readonly {
    readonly virtualAddress: number;
    readonly virtualSize: number;
    readonly rawPointer: number;
    readonly rawSize: number;
  }[],
  rva: number,
): number => {
  for (const section of sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva >= section.virtualAddress + span)
      continue;
    const delta = rva - section.virtualAddress;
    if (delta >= section.rawSize)
      throw new DummyDllStructureError("CLI RVA is outside section raw data");
    return section.rawPointer + delta;
  }
  throw new DummyDllStructureError("CLI RVA is not in a section");
};

const metadataRoot = (
  bytes: Buffer,
  offset: number,
): {
  readonly tables: Buffer;
  readonly strings: Buffer;
  readonly blobs: Buffer;
} => {
  need(bytes, offset, 16);
  if (bytes.readUInt32LE(offset) !== 0x424a5342)
    throw new DummyDllStructureError("CLI metadata signature is missing");
  const versionLength = bytes.readUInt32LE(offset + 12);
  let cursor = offset + 16 + versionLength;
  need(bytes, cursor, 4);
  const streamCount = bytes.readUInt16LE(cursor + 2);
  cursor += 4;
  const streams = new Map<string, Buffer>();
  for (let index = 0; index < streamCount; index += 1) {
    need(bytes, cursor, 8);
    const streamOffset = bytes.readUInt32LE(cursor);
    const streamSize = bytes.readUInt32LE(cursor + 4);
    cursor += 8;
    const nameStart = cursor;
    while (cursor < bytes.length && bytes[cursor] !== 0) cursor += 1;
    const name = bytes.subarray(nameStart, cursor).toString("utf8");
    cursor += 1;
    cursor = (cursor + 3) & ~3;
    need(bytes, offset + streamOffset, streamSize);
    streams.set(
      name,
      bytes.subarray(offset + streamOffset, offset + streamOffset + streamSize),
    );
  }
  const tables = streams.get("#~") ?? streams.get("#-");
  const strings = streams.get("#Strings");
  if (tables === undefined || strings === undefined)
    throw new DummyDllStructureError("CLI metadata is missing #~ or #Strings");
  return { tables, strings, blobs: streams.get("#Blob") ?? Buffer.alloc(0) };
};

/**
 * Read class and field structure from one Cpp2IL dummy DLL.
 * IL method bodies are not decoded.
 */
export const readDummyAssembly = (bytes: Buffer): readonly DummyDllType[] => {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d)
    throw new DummyDllStructureError("DOS header is missing");
  const peOffset = bytes.readUInt32LE(0x3c);
  need(bytes, peOffset, 24);
  if (bytes.readUInt32LE(peOffset) !== 0x00004550)
    throw new DummyDllStructureError("PE signature is missing");
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalSize = bytes.readUInt16LE(peOffset + 20);
  const optional = peOffset + 24;
  need(bytes, optional, optionalSize);
  const magic = bytes.readUInt16LE(optional);
  const directoryCountOffset =
    magic === 0x10b ? 92 : magic === 0x20b ? 108 : -1;
  const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : -1;
  if (directoryCountOffset < 0)
    throw new DummyDllStructureError(
      "optional header magic is not PE32 or PE32+",
    );
  const directoryCount = bytes.readUInt32LE(optional + directoryCountOffset);
  if (directoryCount < 15)
    throw new DummyDllStructureError("PE has no CLI data directory");
  const cliRva = bytes.readUInt32LE(optional + directoryOffset + 14 * 8);
  const cliSize = bytes.readUInt32LE(optional + directoryOffset + 14 * 8 + 4);
  if (cliRva === 0 || cliSize < 16)
    throw new DummyDllStructureError("CLI header is absent");
  const sectionTable = optional + optionalSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const section = sectionTable + index * 40;
    need(bytes, section, 40);
    sections.push({
      virtualSize: bytes.readUInt32LE(section + 8),
      virtualAddress: bytes.readUInt32LE(section + 12),
      rawSize: bytes.readUInt32LE(section + 16),
      rawPointer: bytes.readUInt32LE(section + 20),
    });
  }
  const cliOffset = rvaToOffset(sections, cliRva);
  need(bytes, cliOffset, 16);
  const metadataRva = bytes.readUInt32LE(cliOffset + 8);
  const metadataSize = bytes.readUInt32LE(cliOffset + 12);
  const metadataOffset = rvaToOffset(sections, metadataRva);
  need(bytes, metadataOffset, metadataSize);
  const { tables, strings, blobs } = metadataRoot(
    bytes.subarray(metadataOffset, metadataOffset + metadataSize),
    0,
  );
  need(tables, 0, 24);
  const heapSizes = tables[6] ?? 0;
  const heaps: Heaps = {
    stringIndex: (heapSizes & 0x01) === 0 ? 2 : 4,
    guidIndex: (heapSizes & 0x02) === 0 ? 2 : 4,
    blobIndex: (heapSizes & 0x04) === 0 ? 2 : 4,
  };
  const valid = tables.readBigUInt64LE(8);
  const counts = Array.from({ length: 64 }, () => 0);
  let cursor = 24;
  const present: number[] = [];
  for (let index = 0; index < 64; index += 1) {
    if ((valid & (1n << BigInt(index))) === 0n) continue;
    if (index >= TABLE_COLUMNS.length)
      throw new DummyDllStructureError(
        `metadata table 0x${index.toString(16)} is not supported`,
      );
    need(tables, cursor, 4);
    counts[index] = tables.readUInt32LE(cursor);
    cursor += 4;
    present.push(index);
  }
  const widths = present.map((index) => {
    const columns = TABLE_COLUMNS[index];
    if (columns === undefined)
      throw new DummyDllStructureError("missing table schema");
    return columns.reduce(
      (sum, column) => sum + columnWidth(column, heaps, counts),
      0,
    );
  });
  const typeRows: TypeRow[] = [];
  const fieldRows: FieldRow[] = [];
  const constants = new Map<number, string | number | boolean | null>();
  for (let presentIndex = 0; presentIndex < present.length; presentIndex += 1) {
    const tableIndex = present[presentIndex] ?? 0;
    const width = widths[presentIndex] ?? 0;
    const count = counts[tableIndex] ?? 0;
    const columns = TABLE_COLUMNS[tableIndex] ?? [];
    if (tableIndex !== 0x02 && tableIndex !== 0x04 && tableIndex !== 0x0b) {
      const bytes = width * count;
      need(tables, cursor, bytes);
      cursor += bytes;
      continue;
    }
    for (let row = 0; row < count; row += 1) {
      const rowStart = cursor;
      need(tables, rowStart, width);
      const readColumn = (columnIndex: number): number => {
        let columnCursor = rowStart;
        for (let index = 0; index < columnIndex; index += 1) {
          const column = columns[index];
          if (column === undefined) break;
          columnCursor += columnWidth(column, heaps, counts);
        }
        const column = columns[columnIndex];
        if (column === undefined)
          throw new DummyDllStructureError("missing metadata column");
        return readUnsigned(
          tables,
          columnCursor,
          columnWidth(column, heaps, counts),
        );
      };
      if (tableIndex === 0x02)
        typeRows.push({
          name: cString(strings, readColumn(1)),
          namespace: cString(strings, readColumn(2)),
          fieldList: readColumn(4),
        });
      else if (tableIndex === 0x04) {
        const flags = readColumn(0);
        const signatureIndex = readColumn(2);
        fieldRows.push({
          name: cString(strings, readColumn(1)),
          signature: fieldSignature(readBlob(blobs, signatureIndex)),
          static: (flags & 0x0010) !== 0,
          literal: (flags & 0x0040) !== 0,
        });
      } else {
        const elementType = readColumn(0);
        const parent = readColumn(1);
        const tag = parent & 0x03;
        const fieldRow = parent >>> 2;
        if (tag === 0 && fieldRow > 0) {
          const value = constantValue(
            elementType,
            readBlob(blobs, readColumn(2)),
          );
          if (value !== undefined) constants.set(fieldRow, value);
        }
      }
      cursor = rowStart + width;
    }
  }
  return typeRows.map((type, typeIndex) => {
    const start = type.fieldList;
    const next = typeRows[typeIndex + 1]?.fieldList ?? fieldRows.length + 1;
    const end = next === 0 ? start : next;
    const fields =
      start <= 0
        ? []
        : fieldRows
            .slice(start - 1, Math.max(start - 1, end - 1))
            .map((field, fieldIndex) => {
              const constant = constants.get(start + fieldIndex);
              return constant === undefined ? field : { ...field, constant };
            });
    return { namespace: type.namespace, name: type.name, fields };
  });
};

export interface DummyDllDirectoryRead {
  readonly assemblies: readonly {
    readonly file: string;
    readonly types: readonly DummyDllType[];
  }[];
  readonly failures: readonly {
    readonly file: string;
    readonly reason: string;
  }[];
  readonly type_count: number;
  readonly field_count: number;
}

/** Read every dummy DLL under a Cpp2IL output directory. One bad DLL does not drop the others. */
export const readDummyDllDirectory = async (
  directory: string,
): Promise<DummyDllDirectoryRead> => {
  const files: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length > 5000) return;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".dll")) files.push(path);
    }
  };
  await visit(directory, 0);
  const assemblies: { file: string; types: readonly DummyDllType[] }[] = [];
  const failures: { file: string; reason: string }[] = [];
  for (const file of files) {
    const relativePath = relative(directory, file);
    const info = await stat(file);
    if (info.size > MAX_DLL_BYTES) {
      failures.push({
        file: relativePath,
        reason: `dummy DLL exceeds the ${String(MAX_DLL_BYTES)}-byte read limit`,
      });
      continue;
    }
    try {
      assemblies.push({
        file: relativePath,
        types: readDummyAssembly(await readFile(file)),
      });
    } catch (cause) {
      failures.push({
        file: relativePath,
        reason:
          cause instanceof Error ? cause.message : "dummy DLL parse failed",
      });
    }
  }
  const typeCount = assemblies.reduce(
    (sum, assembly) => sum + assembly.types.length,
    0,
  );
  const fieldCount = assemblies.reduce(
    (sum, assembly) =>
      sum +
      assembly.types.reduce((inner, type) => inner + type.fields.length, 0),
    0,
  );
  return {
    assemblies,
    failures,
    type_count: typeCount,
    field_count: fieldCount,
  };
};
