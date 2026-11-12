import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  childMapping,
  decodeVariableDouble,
  mapping,
  readUnityDocuments,
  simplifyUnityValue,
} from "./unityYaml.js";

/**
 * Gameplay modules whose serialized fields are kept in full.
 * Engine bookkeeping (`m_*`) is dropped. wetMass, dryMassPercent, ISP, and
 * thrustVector stay when the asset stores them; they are not filtered out.
 */
export const PART_MODULE_NAMES = [
  "Part",
  "EngineModule",
  "BoosterModule",
  "ResourceModule",
  "FlowModule",
  "ParachuteModule",
  "HeatModule",
  "TorqueModule",
  "DetachModule",
  "RcsModule",
  "WheelModule",
  "MassModule",
  "LES_Module",
  "DockingPortModule",
  "ControlModule",
  "SplitModule",
  "MagnetModule",
  "ToggleModule",
  "CrewModule",
  "SeparatorColor",
] as const;

const MODULES = new Set<string>(PART_MODULE_NAMES);

export interface PartModuleRecord {
  readonly class_name: string;
  readonly game_object: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface PartRecord {
  readonly source: string;
  readonly modules: readonly PartModuleRecord[];
  readonly double_variables: Readonly<Record<string, number | null>>;
}

export interface PartParse {
  readonly parts: Readonly<Record<string, PartRecord>>;
  readonly failures: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

const walk = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  await visit(directory);
  return found;
};

const classFromMeta = (assetsRoot: string, metaPath: string): string => {
  const scripts = join(assetsRoot, "Scripts");
  const relativePath = relative(scripts, metaPath);
  const withoutSuffix = relativePath.endsWith(".cs.meta")
    ? relativePath.slice(0, -".cs.meta".length)
    : relativePath;
  return withoutSuffix.split(sep).join(".");
};

const shortName = (className: string): string =>
  className.split(".").at(-1) ?? className;

const fileIdOf = (value: unknown): string | null => {
  const id = mapping(value)?.fileID;
  return typeof id === "string" || typeof id === "number" ? String(id) : null;
};

/** Parse AssetRipper part prefabs. Unknown modules are omitted; known modules keep every non-engine field. */
export const parsePartPrefabs = async (
  assetsRoot: string,
): Promise<PartParse> => {
  const files = await walk(assetsRoot);
  const guidToClass = new Map<string, string>();
  for (const file of files) {
    if (!file.endsWith(".cs.meta")) continue;
    const text = await readFile(file, "utf8");
    const guid = /guid:\s*([0-9a-fA-F]+)/u.exec(text)?.[1];
    if (guid !== undefined)
      guidToClass.set(guid, classFromMeta(assetsRoot, file));
  }
  const partsRoot = join(assetsRoot, "Resources", "parts");
  const prefabs = files.filter(
    (file) => file.endsWith(".prefab") && file.startsWith(partsRoot + sep),
  );
  const parts: Record<string, PartRecord> = {};
  const failures: { path: string; reason: string }[] = [];
  for (const prefab of prefabs) {
    const source = relative(assetsRoot, prefab);
    const name = relative(partsRoot, prefab).replace(/\.prefab$/u, "");
    let text: string;
    try {
      text = await readFile(prefab, "utf8");
    } catch (cause) {
      failures.push({
        path: source,
        reason: cause instanceof Error ? cause.message : "unreadable",
      });
      continue;
    }
    const documents = readUnityDocuments(text);
    const gameObjects = new Map<string, string | null>();
    for (const document of documents) {
      if (document.error !== undefined) {
        failures.push({ path: source, reason: document.error });
        continue;
      }
      if (document.classId !== 1) continue;
      const gameObject = childMapping(document.value, "GameObject");
      const objectName = gameObject?.m_Name;
      gameObjects.set(
        document.fileId,
        typeof objectName === "string" ? objectName : null,
      );
    }
    const modules: PartModuleRecord[] = [];
    const doubles: Record<string, number | null> = {};
    for (const document of documents) {
      if (document.classId !== 114 || document.error !== undefined) continue;
      const behaviour = childMapping(document.value, "MonoBehaviour");
      if (behaviour === undefined) continue;
      const guid = mapping(behaviour.m_Script)?.guid;
      const scriptGuid = typeof guid === "string" ? guid : null;
      const className =
        scriptGuid === null
          ? "unknown"
          : (guidToClass.get(scriptGuid) ?? scriptGuid);
      const short = shortName(className);
      if (short === "VariablesModule") {
        const saves = mapping(behaviour.doubleVariables)?.saves;
        if (Array.isArray(saves)) {
          for (const save of saves) {
            const entry = mapping(save);
            const saveName = entry?.name;
            const data = entry?.data;
            if (typeof saveName === "string" && typeof data === "string")
              doubles[saveName] = decodeVariableDouble(data);
          }
        }
        continue;
      }
      if (!MODULES.has(short)) continue;
      const fields = simplifyUnityValue(behaviour);
      const fieldRecord = mapping(fields) ?? {};
      const gameObjectId = fileIdOf(behaviour.m_GameObject);
      modules.push({
        class_name: className,
        game_object:
          gameObjectId === null
            ? null
            : (gameObjects.get(gameObjectId) ?? null),
        fields: fieldRecord,
      });
    }
    modules.sort((left, right) =>
      left.class_name.localeCompare(right.class_name),
    );
    parts[name] = {
      source,
      modules,
      double_variables: doubles,
    };
  }
  return { parts, failures };
};

export interface ParachuteModuleRecord {
  readonly part: string;
  readonly class_name: string;
  readonly game_object: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface PlanetParachuteMultiplier {
  readonly name: string;
  readonly parachute_multiplier: number | null;
  readonly source: "observed";
}

/** Parachute module fields plus observed per-planet parachute multipliers. */
export const parachuteRecords = (
  parts: Readonly<Record<string, PartRecord>>,
  planetMultipliers: readonly PlanetParachuteMultiplier[],
): {
  readonly modules: readonly ParachuteModuleRecord[];
  readonly planet_parachute_multipliers: readonly PlanetParachuteMultiplier[];
} => ({
  modules: Object.entries(parts).flatMap(([part, record]) =>
    record.modules
      .filter(
        (module) => module.class_name.split(".").at(-1) === "ParachuteModule",
      )
      .map((module) => ({
        part,
        class_name: module.class_name,
        game_object: module.game_object,
        fields: module.fields,
      })),
  ),
  planet_parachute_multipliers: planetMultipliers,
});
