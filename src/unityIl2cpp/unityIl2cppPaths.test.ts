import { describe, expect, it } from "vitest";

import {
  LOCAL_ONLY_DIRECTORY_NAME,
  LOCAL_ONLY_NOTICE,
} from "../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  unityIl2cppCacheDirectory,
  unityIl2cppHostProblem,
} from "./pipeline.js";

describe("unity il2cpp local boundaries", () => {
  it("names the local-only directory and forbids packaging it", () => {
    expect(LOCAL_ONLY_DIRECTORY_NAME).toBe("LOCAL_ONLY_DO_NOT_PACKAGE");
    expect(LOCAL_ONLY_NOTICE).toContain("Do not package");
    expect(LOCAL_ONLY_NOTICE).toContain("do not upload");
    expect(LOCAL_ONLY_NOTICE).toContain("do not commit");
  });

  it("accepts Linux x64 and rejects other hosts", () => {
    expect(unityIl2cppHostProblem("linux", "x64")).toBeUndefined();
    expect(unityIl2cppHostProblem("darwin", "arm64")).toMatch(/Linux x64/u);
  });

  it("requires an absolute cache directory", () => {
    expect(
      unityIl2cppCacheDirectory({ REA_UNITY_IL2CPP_CACHE: "/var/cache/rea" }),
    ).toBe("/var/cache/rea");
    expect(
      unityIl2cppCacheDirectory({
        HOME: "/home/analyst",
        XDG_CACHE_HOME: undefined,
      }),
    ).toBe("/home/analyst/.cache/rea/unity-il2cpp");
    expect(() =>
      unityIl2cppCacheDirectory({ REA_UNITY_IL2CPP_CACHE: "relative" }),
    ).toThrow(AnalysisInputError);
  });
});
