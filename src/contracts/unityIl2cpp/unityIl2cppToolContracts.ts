import {
  unityIl2cppInputSchema,
  unityIl2cppResultSchema,
} from "../../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** Local Unity IL2CPP package extraction. The game package is not executed. */
export const UNITY_IL2CPP_TOOL_CONTRACTS = [
  {
    name: "extract_unity_il2cpp",
    ...toolContractMetadata("extract_unity_il2cpp"),
    kind: "unity-il2cpp-provider",
    description:
      "Extract derived tables from a local Unity IL2CPP XAPK or APK: planet values, part and fuel fields (including wet mass, dry-mass percent, ISP, and thrust vector when serialized), parachute fields, scene RectTransform layout, and Cpp2IL dummy-DLL class and field structure. Original unpacked bytes and AssetRipper textures, audio, fonts, and text are written under LOCAL_ONLY_DO_NOT_PACKAGE and must not be packaged, uploaded, or committed. Does not execute the package, recover IL method bodies, or reconstruct obfuscated flight formulas. Linux x64. First use downloads pinned UnityPy 1.25.4, Cpp2IL 2022.1.0-pre-release.21, and AssetRipper 2.0.0 into a local cache and checks the recorded binary SHA-256. Package bytes are not uploaded.",
    inputSchema: unityIl2cppInputSchema,
    outputSchema: evidenceResultOf(unityIl2cppResultSchema),
    examples: [
      {
        title: "Extract derived Unity IL2CPP tables",
        input: {
          path: "/tmp/game.xapk",
          output_directory: "/tmp/game-unity-out",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
