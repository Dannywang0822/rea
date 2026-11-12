import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planUnityDataMerge } from "./dataMerge.js";
import { deriveUnityIl2cppTables } from "./deriveTables.js";
import {
  formatDifficultyCandidates,
  scanDifficultyCandidates,
} from "./difficultyCandidates.js";
import { parseFuelAssets } from "./parseFuels.js";
import { parsePartPrefabs } from "./parseParts.js";
import { parsePlanetTextAssets } from "./parsePlanets.js";
import { canvasScalerExcerpt, parseSceneLayout } from "./parseUiLayout.js";
import { decodeVariableDouble } from "./unityYaml.js";

const roots: string[] = [];

const temp = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-unity-il2cpp-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("unity data merge plan", () => {
  it("links ordinary files and orders split pieces from zero", () => {
    expect(
      planUnityDataMerge([
        "resources.assets",
        "data.unity3d.split1",
        "data.unity3d.split0",
        "globalgamemanagers",
      ]),
    ).toEqual({
      link: ["globalgamemanagers", "resources.assets"],
      groups: [
        {
          base: "data.unity3d",
          parts: [
            { index: 0, name: "data.unity3d.split0" },
            { index: 1, name: "data.unity3d.split1" },
          ],
        },
      ],
    });
  });
});

describe("planet text assets", () => {
  it("keeps observed fields and marks the Laplace SOI as an inference", async () => {
    const directory = await temp();
    await writeFile(
      join(directory, "Sun__abcd_1.txt"),
      `{
        "BASE_DATA": { "radius": 1000, "gravity": 20 }
      }`,
    );
    await writeFile(
      join(directory, "Earth__abcd_2.txt"),
      `{
        // synthetic body
        "BASE_DATA": {
          "radius": 100,
          "gravity": 10,
          "gravityDifficultyScale": 1,
          "timewarpHeight": 50,
        },
        "ATMOSPHERE_PHYSICS_DATA": {
          "height": 80,
          "density": 1.2,
          "parachuteMultiplier": 1.5,
          "upperAtmosphere": 40,
        },
        "ORBIT_DATA": {
          "parent": "Sun",
          "semiMajorAxis": 10000,
          "eccentricity": 0.01,
          "multiplierSOI": 2,
        },
      }`,
    );
    const parsed = await parsePlanetTextAssets(directory);
    expect(parsed.failures).toEqual([]);
    expect(parsed.table).toHaveLength(2);
    const earth = parsed.table.find((row) => row.name === "Earth");
    expect(earth).toMatchObject({
      radius: 100,
      gravity: 10,
      parachute_multiplier: 1.5,
      parent: "Sun",
      semi_major_axis: 10000,
      multiplier_soi: 2,
      soi_estimate_basis: "inference_laplace_0_4",
    });
    const sunMu = 20 * 1000 ** 2;
    const earthMu = 10 * 100 ** 2;
    expect(earth?.soi_estimate).toBeCloseTo(
      10000 * (earthMu / sunMu) ** 0.4 * 2,
    );
    expect(parsed.bodies.Earth).toMatchObject({
      ATMOSPHERE_PHYSICS_DATA: { parachuteMultiplier: 1.5 },
    });
  });
});

const syntheticAssets = async (
  root: string,
): Promise<{ readonly assets: string; readonly massHex: string }> => {
  const assets = join(root, "Assets");
  await mkdir(join(assets, "Scripts", "Game"), { recursive: true });
  await mkdir(join(assets, "Resources", "parts"), { recursive: true });
  await mkdir(join(assets, "Resources", "fuels"), { recursive: true });
  await mkdir(join(assets, "Scenes", "Mobile"), { recursive: true });
  const guid = "aabbccddeeff00112233445566778899";
  const chuteGuid = "00112233445566778899aabbccddeeff";
  const variableGuid = "ffeeddccbbaa99887766554433221100";
  const ignoredGuid = "0123456789abcdef0123456789abcdef";
  const metas: Readonly<Record<string, string>> = {
    EngineModule: guid,
    ParachuteModule: chuteGuid,
    VariablesModule: variableGuid,
    UiButton: ignoredGuid,
  };
  await Promise.all(
    Object.entries(metas).map(([name, value]) =>
      writeFile(
        join(assets, "Scripts", "Game", `${name}.cs.meta`),
        `guid: ${value}\n`,
      ),
    ),
  );
  const mass = Buffer.alloc(8);
  mass.writeDoubleLE(3.25);
  const massHex = Buffer.concat([
    Buffer.from("xxm_value"),
    Buffer.from([0, 0]),
    mass,
  ]).toString("hex");
  await writeFile(
    join(assets, "Resources", "parts", "engine.prefab"),
    enginePrefab(guid, variableGuid, ignoredGuid, massHex),
  );
  await writeFile(
    join(assets, "Resources", "parts", "chute.prefab"),
    chutePrefab(chuteGuid),
  );
  await writeFile(
    join(assets, "Resources", "fuels", "Liquid.asset"),
    fuelAsset(),
  );
  await writeFile(join(assets, "Scenes", "Mobile", "Build.unity"), sceneText());
  return { assets, massHex };
};

const enginePrefab = (
  guid: string,
  variableGuid: string,
  ignoredGuid: string,
  massHex: string,
): string => `--- !u!1 &100
GameObject:
  m_Name: Engine
--- !u!114 &200
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${guid}, type: 3}
  thrust: 12
  ISP: 280
  wetMass: 4.5
  dryMassPercent: 0.2
  thrustVector: {x: 0, y: 1, z: 0}
  oldMass: 1.5
--- !u!114 &201
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${variableGuid}, type: 3}
  doubleVariables:
    saves:
    - name: wetMass
      data: ${massHex}
--- !u!114 &202
MonoBehaviour:
  m_GameObject: {fileID: 100}
  m_Script: {fileID: 11500000, guid: ${ignoredGuid}, type: 3}
  caption: hidden
`;

const chutePrefab = (guid: string): string => `--- !u!1 &10
GameObject:
  m_Name: Chute
--- !u!114 &11
MonoBehaviour:
  m_GameObject: {fileID: 10}
  m_Script: {fileID: 11500000, guid: ${guid}, type: 3}
  maxDeployHeight: 1000
  maxDeployVelocity: 20
  drag:
    m_Curve:
    - time: 0
      value: 1
    - time: 1
      value: 4
`;

const fuelAsset = (): string => `--- !u!114 &1
MonoBehaviour:
  m_Name: Liquid
  density: 1.2
  transferRate: 3
  m_EditorClassIdentifier: Fuel
`;

const sceneText = (): string => `--- !u!1 &1
GameObject:
  m_Name: Panel
  m_IsActive: 1
--- !u!224 &2
RectTransform:
  m_GameObject: {fileID: 1}
  m_Father: {fileID: 0}
  m_AnchorMin: {x: 0, y: 0}
  m_AnchorMax: {x: 1, y: 1}
  m_Pivot: {x: 0.5, y: 0.5}
  m_AnchoredPosition: {x: 0, y: 10}
  m_SizeDelta: {x: 100, y: 40}
  m_LocalScale: {x: 1, y: 1}
CanvasScaler:
  m_UiScaleMode: 1
  m_ReferenceResolution: {x: 1080, y: 1920}
`;

describe("part prefabs", () => {
  it("keeps wetMass, dryMassPercent, ISP, thrustVector, and parachute fields", async () => {
    const root = await temp();
    const { assets, massHex } = await syntheticAssets(root);
    expect(decodeVariableDouble(massHex)).toBeCloseTo(3.25);
    const parts = await parsePartPrefabs(assets);
    expect(parts.failures).toEqual([]);
    expect(parts.parts.engine?.modules).toEqual([
      {
        class_name: "Game.EngineModule",
        game_object: "Engine",
        fields: {
          thrust: 12,
          ISP: 280,
          wetMass: 4.5,
          dryMassPercent: 0.2,
          thrustVector: { x: 0, y: 1, z: 0 },
          oldMass: 1.5,
        },
      },
    ]);
    expect(parts.parts.engine?.double_variables.wetMass).toBeCloseTo(3.25);
    expect(JSON.stringify(parts.parts.engine)).not.toContain("hidden");
    const chute = parts.parts.chute?.modules[0];
    expect(chute?.fields).toMatchObject({
      maxDeployHeight: 1000,
      maxDeployVelocity: 20,
      drag: [
        [0, 1],
        [1, 4],
      ],
    });
    const fuels = await parseFuelAssets(assets);
    expect(fuels.fuels[0]?.fields).toEqual({ density: 1.2, transferRate: 3 });
    const layout = await parseSceneLayout(
      join(assets, "Scenes", "Mobile", "Build.unity"),
      assets,
    );
    expect(layout.rows).toEqual([
      expect.objectContaining({
        path: "Panel",
        active: "1",
        anchorMin: "(0,0)",
        anchorMax: "(1,1)",
        sizeDelta: "(100,40)",
      }),
    ]);
    const scaler = await canvasScalerExcerpt(assets);
    expect(scaler).toContain("m_UiScaleMode: 1");
    expect(scaler).toContain("m_ReferenceResolution");
    const output = join(root, "out");
    const derived = await deriveUnityIl2cppTables({
      outputDirectory: output,
      textAssetsDirectory: undefined,
      exportedAssetsDirectory: assets,
    });
    const written = JSON.parse(
      await readFile(join(output, "parts.json"), "utf8"),
    ) as {
      engine: { modules: { fields: { wetMass: number; ISP: number } }[] };
    };
    expect(written.engine?.modules[0]?.fields.wetMass).toBe(4.5);
    expect(written.engine?.modules[0]?.fields.ISP).toBe(280);
    expect(derived.counts.parts).toBe(2);
    expect(derived.counts.parachute_modules).toBe(1);
    expect(derived.counts.fuels).toBe(1);
    expect(derived.counts.ui_scenes).toBe(1);
  });
});

describe("difficulty candidates", () => {
  it("reports unlabeled triples and skips the all-ones triple", () => {
    const bytes = Buffer.alloc(24 * 2);
    bytes.writeDoubleLE(1, 0);
    bytes.writeDoubleLE(1.5, 8);
    bytes.writeDoubleLE(2, 16);
    bytes.writeDoubleLE(1, 24);
    bytes.writeDoubleLE(1, 32);
    bytes.writeDoubleLE(1, 40);
    const candidates = scanDifficultyCandidates(bytes);
    expect(candidates).toEqual([{ offset: 0, values: [1, 1.5, 2] }]);
    expect(formatDifficultyCandidates(candidates)).toContain(
      "Field-name mapping is unknown",
    );
  });
});
