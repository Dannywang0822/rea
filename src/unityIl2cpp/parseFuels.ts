import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  childMapping,
  mapping,
  readUnityDocuments,
  simplifyUnityValue,
} from "./unityYaml.js";

export interface FuelRecord {
  readonly name: string;
  readonly source: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface FuelParse {
  readonly fuels: readonly FuelRecord[];
  readonly failures: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

/** Parse fuel ScriptableObjects. Every non-engine field is kept, including density and transfer rate. */
export const parseFuelAssets = async (
  assetsRoot: string,
): Promise<FuelParse> => {
  const directory = join(assetsRoot, "Resources", "fuels");
  let names: string[] = [];
  try {
    names = (await readdir(directory)).filter((name) =>
      name.endsWith(".asset"),
    );
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code === "ENOENT") return { fuels: [], failures: [] };
    throw cause;
  }
  names.sort();
  const fuels: FuelRecord[] = [];
  const failures: { path: string; reason: string }[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const source = relative(assetsRoot, path);
    const text = await readFile(path, "utf8");
    const documents = readUnityDocuments(text);
    const fields: Record<string, unknown> = {};
    for (const document of documents) {
      if (document.error !== undefined) {
        failures.push({ path: source, reason: document.error });
        continue;
      }
      if (document.classId !== 114) continue;
      const behaviour = childMapping(document.value, "MonoBehaviour");
      const simplified = mapping(simplifyUnityValue(behaviour ?? {}));
      if (simplified !== undefined) Object.assign(fields, simplified);
    }
    fuels.push({
      name: name.replace(/\.asset$/u, ""),
      source,
      fields,
    });
  }
  return { fuels, failures };
};

export const formatFuelText = (fuels: readonly FuelRecord[]): string =>
  fuels
    .map((fuel) => {
      const lines = Object.entries(fuel.fields).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      );
      return `== ${fuel.name}.asset\n${lines.join("\n")}`;
    })
    .join("\n");
