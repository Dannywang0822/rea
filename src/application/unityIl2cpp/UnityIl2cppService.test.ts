import { describe, expect, it } from "vitest";

import { LOCAL_ONLY_NOTICE } from "../../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import type { UnityIl2cppReport } from "../../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import { ok } from "../../domain/result.js";
import { UnityIl2cppService } from "./UnityIl2cppService.js";

const digest = "ab".repeat(32);

const report = (path: string, output: string): UnityIl2cppReport => ({
  input: { path, sha256: digest, format: "xapk" },
  output_directory: output,
  local_only_directory: `${output}/LOCAL_ONLY_DO_NOT_PACKAGE`,
  local_only_notice: LOCAL_ONLY_NOTICE,
  derived_files: [],
  counts: {
    planets: 0,
    parts: 0,
    fuels: 0,
    parachute_modules: 0,
    ui_scenes: 0,
    il2cpp_types: 0,
    il2cpp_fields: 0,
    difficulty_candidates: 0,
  },
  tools: {
    unitypy: "1.25.4",
    cpp2il: "2022.1.0-pre-release.21",
    cpp2il_sha256: digest,
    assetripper: "2.0.0",
    assetripper_archive_sha256: digest,
    unity_version: "6000.1.17f1",
    unity_version_source: "fallback",
    abi: "arm64-v8a",
  },
  unparsed_files: [],
  limitations: ["Original bytes stay in LOCAL_ONLY_DO_NOT_PACKAGE."],
});

describe("UnityIl2cppService", () => {
  it("rejects a relative package path before extraction", async () => {
    const service = new UnityIl2cppService({
      extract: () => {
        throw new Error("extraction must not start");
      },
    });
    const result = await service.execute("extract_unity_il2cpp", {
      path: "game.xapk",
      output_directory: "/tmp/out",
    });
    expect(result.ok).toBe(false);
  });

  it("returns derived evidence for an absolute local request", async () => {
    const service = new UnityIl2cppService({
      extract: (input) =>
        Promise.resolve(ok(report(input.path, input.output_directory))),
    });
    const result = await service.execute("extract_unity_il2cpp", {
      path: "/tmp/game.xapk",
      output_directory: "/tmp/game-out",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.confidence).toBe("derived");
    expect(result.value.normalized_result).toMatchObject({
      local_only_notice: LOCAL_ONLY_NOTICE,
      input: { path: "/tmp/game.xapk", format: "xapk" },
    });
    expect(result.value.limitations.join("\n")).toContain(
      "LOCAL_ONLY_DO_NOT_PACKAGE",
    );
  });
});
