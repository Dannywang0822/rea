import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  formatDifficultyCandidates,
  scanDifficultyCandidates,
} from "./difficultyCandidates.js";
import { formatFuelText, parseFuelAssets } from "./parseFuels.js";
import { parsePlanetTextAssets, type PlanetTableRow } from "./parsePlanets.js";
import { parachuteRecords, parsePartPrefabs } from "./parseParts.js";
import { readDummyDllDirectory } from "./parseDummyDll.js";
import {
  canvasScalerExcerpt,
  formatLayoutTsv,
  parseSceneLayout,
  sceneBaseName,
  sceneFiles,
} from "./parseUiLayout.js";

export interface DerivedFile {
  readonly path: string;
  readonly sha256: string;
  readonly role: string;
}

export interface DerivedTables {
  readonly counts: {
    readonly planets: number;
    readonly parts: number;
    readonly fuels: number;
    readonly parachute_modules: number;
    readonly ui_scenes: number;
    readonly il2cpp_types: number;
    readonly il2cpp_fields: number;
    readonly difficulty_candidates: number;
  };
  readonly derived_files: readonly DerivedFile[];
  readonly unparsed_files: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
  readonly notes: readonly string[];
}

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const fileDigest = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const recordFile = async (
  files: DerivedFile[],
  path: string,
  role: string,
): Promise<void> => {
  files.push({ path, sha256: await fileDigest(path), role });
};

/**
 * Write derived tables from already extracted local inputs.
 * Missing inputs produce empty tables and a note, not a thrown error.
 */
export const deriveUnityIl2cppTables = async (input: {
  readonly outputDirectory: string;
  readonly textAssetsDirectory?: string | undefined;
  readonly exportedAssetsDirectory?: string | undefined;
  readonly dummyDllDirectory?: string | undefined;
  readonly metadataPath?: string | undefined;
}): Promise<DerivedTables> => {
  await mkdir(input.outputDirectory, { recursive: true });
  const failures: { path: string; reason: string }[] = [];
  const notes: string[] = [];
  const files: DerivedFile[] = [];
  let planets: readonly PlanetTableRow[] = [];
  if (input.textAssetsDirectory === undefined) {
    notes.push(
      "No TextAsset directory was produced, so the planet tables are empty.",
    );
    await writeJson(join(input.outputDirectory, "planets_all.json"), {});
    await writeJson(join(input.outputDirectory, "planets_table.json"), []);
  } else {
    const parsed = await parsePlanetTextAssets(input.textAssetsDirectory);
    planets = parsed.table;
    failures.push(...parsed.failures);
    await writeJson(
      join(input.outputDirectory, "planets_all.json"),
      parsed.bodies,
    );
    await writeJson(
      join(input.outputDirectory, "planets_table.json"),
      parsed.table,
    );
    if (parsed.table.length === 0)
      notes.push("No BASE_DATA text assets were found.");
  }
  await recordFile(
    files,
    join(input.outputDirectory, "planets_all.json"),
    "planets-observed",
  );
  await recordFile(
    files,
    join(input.outputDirectory, "planets_table.json"),
    "planets-table",
  );

  let partCount = 0;
  let parachuteCount = 0;
  let fuelCount = 0;
  if (input.exportedAssetsDirectory === undefined) {
    notes.push(
      "No AssetRipper export was produced, so part, fuel, parachute, and UI tables are empty.",
    );
    await writeJson(join(input.outputDirectory, "parts.json"), {});
    await writeJson(join(input.outputDirectory, "fuels.json"), []);
    await writeFile(join(input.outputDirectory, "fuels.txt"), "", "utf8");
    await writeJson(join(input.outputDirectory, "parachutes.json"), {
      modules: [],
      planet_parachute_multipliers: [],
    });
  } else {
    const parts = await parsePartPrefabs(input.exportedAssetsDirectory);
    failures.push(...parts.failures);
    partCount = Object.keys(parts.parts).length;
    await writeJson(join(input.outputDirectory, "parts.json"), parts.parts);
    const fuels = await parseFuelAssets(input.exportedAssetsDirectory);
    failures.push(...fuels.failures);
    fuelCount = fuels.fuels.length;
    await writeJson(join(input.outputDirectory, "fuels.json"), fuels.fuels);
    await writeFile(
      join(input.outputDirectory, "fuels.txt"),
      formatFuelText(fuels.fuels),
      "utf8",
    );
    const parachutes = parachuteRecords(
      parts.parts,
      planets.map((planet) => ({
        name: planet.name,
        parachute_multiplier: planet.parachute_multiplier,
        source: "observed" as const,
      })),
    );
    parachuteCount = parachutes.modules.length;
    await writeJson(join(input.outputDirectory, "parachutes.json"), parachutes);
  }
  await recordFile(files, join(input.outputDirectory, "parts.json"), "parts");
  await recordFile(files, join(input.outputDirectory, "fuels.json"), "fuels");
  await recordFile(
    files,
    join(input.outputDirectory, "fuels.txt"),
    "fuels-text",
  );
  await recordFile(
    files,
    join(input.outputDirectory, "parachutes.json"),
    "parachutes",
  );

  const uiDirectory = join(input.outputDirectory, "ui_layout");
  await mkdir(uiDirectory, { recursive: true });
  let uiScenes = 0;
  if (input.exportedAssetsDirectory !== undefined) {
    const scenes = await sceneFiles(input.exportedAssetsDirectory);
    for (const scene of scenes) {
      const parsed = await parseSceneLayout(
        scene,
        input.exportedAssetsDirectory,
      );
      failures.push(
        ...parsed.failures.map((reason) => ({ path: scene, reason })),
      );
      const tsv = join(uiDirectory, `${sceneBaseName(scene)}.tsv`);
      await writeFile(tsv, formatLayoutTsv(parsed.rows), "utf8");
      await recordFile(files, tsv, "ui-layout");
      uiScenes += 1;
    }
    const scaler = await canvasScalerExcerpt(input.exportedAssetsDirectory);
    await writeFile(
      join(uiDirectory, "canvas_scaler.txt"),
      scaler.length === 0 ? "" : `${scaler}\n`,
      "utf8",
    );
  } else {
    await writeFile(join(uiDirectory, "canvas_scaler.txt"), "", "utf8");
  }
  await recordFile(
    files,
    join(uiDirectory, "canvas_scaler.txt"),
    "canvas-scaler",
  );

  let typeCount = 0;
  let fieldCount = 0;
  if (input.dummyDllDirectory === undefined) {
    notes.push("No Cpp2IL dummy DLL directory was produced.");
    await writeJson(join(input.outputDirectory, "il2cpp_types.json"), {
      source: "cpp2il-dummydll",
      method_bodies: "not-recovered",
      assemblies: [],
      failures: [],
    });
  } else {
    const dlls = await readDummyDllDirectory(input.dummyDllDirectory);
    typeCount = dlls.type_count;
    fieldCount = dlls.field_count;
    failures.push(
      ...dlls.failures.map((failure) => ({
        path: failure.file,
        reason: failure.reason,
      })),
    );
    await writeJson(join(input.outputDirectory, "il2cpp_types.json"), {
      source: "cpp2il-dummydll",
      method_bodies: "not-recovered",
      assemblies: dlls.assemblies,
      failures: dlls.failures,
    });
  }
  await recordFile(
    files,
    join(input.outputDirectory, "il2cpp_types.json"),
    "il2cpp-types",
  );

  let difficultyCount = 0;
  if (input.metadataPath === undefined) {
    notes.push(
      "global-metadata.dat was not scanned for difficulty candidates.",
    );
    await writeFile(
      join(input.outputDirectory, "difficulty_array_candidates.txt"),
      formatDifficultyCandidates([]),
      "utf8",
    );
  } else {
    const candidates = scanDifficultyCandidates(
      await readFile(input.metadataPath),
    );
    difficultyCount = candidates.length;
    await writeFile(
      join(input.outputDirectory, "difficulty_array_candidates.txt"),
      formatDifficultyCandidates(candidates),
      "utf8",
    );
  }
  await recordFile(
    files,
    join(input.outputDirectory, "difficulty_array_candidates.txt"),
    "difficulty-candidates",
  );

  const visibleFailures = failures.slice(0, 50).map((failure) => ({
    path: failure.path,
    reason: failure.reason.slice(0, 300),
  }));
  if (failures.length > visibleFailures.length) {
    notes.push(
      `${String(failures.length - visibleFailures.length)} additional parse failures were omitted from the result.`,
    );
    await writeJson(
      join(input.outputDirectory, "parse_failures.json"),
      failures.map((failure) => ({
        path: failure.path,
        reason: failure.reason.slice(0, 500),
      })),
    );
    await recordFile(
      files,
      join(input.outputDirectory, "parse_failures.json"),
      "parse-failures",
    );
  }
  return {
    counts: {
      planets: planets.length,
      parts: partCount,
      fuels: fuelCount,
      parachute_modules: parachuteCount,
      ui_scenes: uiScenes,
      il2cpp_types: typeCount,
      il2cpp_fields: fieldCount,
      difficulty_candidates: difficultyCount,
    },
    derived_files: files,
    unparsed_files: visibleFailures,
    notes,
  };
};
