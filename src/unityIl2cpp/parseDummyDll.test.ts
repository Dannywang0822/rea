import { describe, expect, it } from "vitest";

import { readDummyAssembly } from "./parseDummyDll.js";

const strings = (): {
  readonly bytes: Buffer;
  readonly index: Record<string, number>;
} => {
  const chunks: Buffer[] = [Buffer.from([0])];
  const index: Record<string, number> = {};
  for (const name of [
    "EngineModule",
    "Game",
    "ISP",
    "wetMass",
    "dryMassPercent",
    "thrustVector",
  ]) {
    index[name] = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    chunks.push(Buffer.from(`${name}\0`, "utf8"));
  }
  return { bytes: Buffer.concat(chunks), index };
};

const blob = (signature: number): Buffer =>
  Buffer.from([0x02, 0x06, signature]);

const buildMetadata = (): Buffer => {
  const stringHeap = strings();
  const blobs = Buffer.concat([
    Buffer.from([0x00]),
    blob(0x0d),
    blob(0x0d),
    blob(0x0c),
    blob(0x0c),
  ]);
  const blobIndex = [1, 4, 7, 10];
  const tables = Buffer.alloc(24 + 8 + 14 + 6 * 4);
  tables.writeUInt8(2, 4);
  tables.writeUInt8(0, 6);
  tables.writeBigUInt64LE((1n << 2n) | (1n << 4n), 8);
  tables.writeUInt32LE(1, 24);
  tables.writeUInt32LE(4, 28);
  let cursor = 32;
  tables.writeUInt32LE(0x00100001, cursor);
  tables.writeUInt16LE(stringHeap.index.EngineModule ?? 0, cursor + 4);
  tables.writeUInt16LE(stringHeap.index.Game ?? 0, cursor + 6);
  tables.writeUInt16LE(0, cursor + 8);
  tables.writeUInt16LE(1, cursor + 10);
  tables.writeUInt16LE(1, cursor + 12);
  cursor += 14;
  const fields = ["ISP", "wetMass", "dryMassPercent", "thrustVector"];
  for (let field = 0; field < fields.length; field += 1) {
    const name = fields[field] ?? "";
    tables.writeUInt16LE(0x0006, cursor);
    tables.writeUInt16LE(stringHeap.index[name] ?? 0, cursor + 2);
    tables.writeUInt16LE(blobIndex[field] ?? 0, cursor + 4);
    cursor += 6;
  }
  const streams = [
    { name: "#Strings", data: stringHeap.bytes },
    { name: "#Blob", data: blobs },
    { name: "#~", data: tables.subarray(0, cursor) },
  ];
  const version = Buffer.alloc(12);
  version.write("v4.0.30319\0", "utf8");
  const headers = streams.map((stream) => {
    const name = Buffer.from(`${stream.name}\0`, "utf8");
    const padded = Buffer.alloc((name.length + 3) & ~3);
    name.copy(padded);
    return { ...stream, nameBytes: padded };
  });
  let rootSize = 32;
  for (const header of headers) rootSize += 8 + header.nameBytes.length;
  const metadata = Buffer.alloc(
    rootSize + headers.reduce((sum, header) => sum + header.data.length, 0),
  );
  metadata.writeUInt32LE(0x424a5342, 0);
  metadata.writeUInt16LE(1, 4);
  metadata.writeUInt16LE(1, 6);
  metadata.writeUInt32LE(12, 12);
  version.copy(metadata, 16);
  metadata.writeUInt16LE(headers.length, 30);
  let headerCursor = 32;
  let dataCursor = rootSize;
  for (const header of headers) {
    metadata.writeUInt32LE(dataCursor, headerCursor);
    metadata.writeUInt32LE(header.data.length, headerCursor + 4);
    header.nameBytes.copy(metadata, headerCursor + 8);
    headerCursor += 8 + header.nameBytes.length;
    header.data.copy(metadata, dataCursor);
    dataCursor += header.data.length;
  }
  return metadata;
};

const wrapPe = (metadata: Buffer): Buffer => {
  const metadataOffset = 0x280;
  const file = Buffer.alloc(metadataOffset + metadata.length + 16);
  file.writeUInt16LE(0x5a4d, 0);
  file.writeUInt32LE(0x80, 0x3c);
  file.writeUInt32LE(0x00004550, 0x80);
  file.writeUInt16LE(1, 0x86);
  file.writeUInt16LE(0xe0, 0x94);
  file.writeUInt16LE(0x10b, 0x98);
  file.writeUInt32LE(16, 0x98 + 92);
  file.writeUInt32LE(0x2000, 0x98 + 96 + 14 * 8);
  file.writeUInt32LE(72, 0x98 + 96 + 14 * 8 + 4);
  const section = 0x98 + 0xe0;
  file.writeUInt32LE(0x1000, section + 8);
  file.writeUInt32LE(0x2000, section + 12);
  file.writeUInt32LE(file.length - 0x200, section + 16);
  file.writeUInt32LE(0x200, section + 20);
  file.writeUInt32LE(72, 0x200);
  file.writeUInt32LE(0x2080, 0x208);
  file.writeUInt32LE(metadata.length, 0x20c);
  metadata.copy(file, metadataOffset);
  return file;
};

describe("Cpp2IL dummy DLL structure", () => {
  it("reads class and field names without method bodies", () => {
    const types = readDummyAssembly(wrapPe(buildMetadata()));
    expect(types).toEqual([
      {
        namespace: "Game",
        name: "EngineModule",
        fields: [
          {
            name: "ISP",
            signature: "float64",
            static: false,
            literal: false,
          },
          {
            name: "wetMass",
            signature: "float64",
            static: false,
            literal: false,
          },
          {
            name: "dryMassPercent",
            signature: "float32",
            static: false,
            literal: false,
          },
          {
            name: "thrustVector",
            signature: "float32",
            static: false,
            literal: false,
          },
        ],
      },
    ]);
  });

  it("rejects a buffer that is not a PE", () => {
    expect(() => readDummyAssembly(Buffer.from("not a dll"))).toThrow(
      /DOS header/u,
    );
  });
});
