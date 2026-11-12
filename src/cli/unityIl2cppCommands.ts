import { z } from "incur";

import { UnityIl2cppService } from "../application/unityIl2cpp/UnityIl2cppService.js";
import { createUnityIl2cppProvider } from "../composition/unityIl2cpp.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { localPathStringSchema } from "../domain/localPath.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";

/** One-shot Unity IL2CPP extraction. Paths stay absolute; nothing is uploaded. */
export const registerUnityIl2cppCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  const service = new UnityIl2cppService(createUnityIl2cppProvider());
  cli.command(CLI_COMMANDS.extractUnityIl2cpp, {
    description:
      "Extract derived Unity IL2CPP tables from a local XAPK or APK. Original bytes stay in LOCAL_ONLY_DO_NOT_PACKAGE.",
    args: z.object({
      path: localPathStringSchema.describe(
        "Absolute local XAPK or APK path. The package is not executed.",
      ),
    }),
    options: z.object({
      output: localPathStringSchema.describe(
        "Absolute output directory. Derived tables are written here. Original bytes go in LOCAL_ONLY_DO_NOT_PACKAGE inside it.",
      ),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.extractUnityIl2cpp, () =>
          finishAnalysisCommand(
            () =>
              service.execute(
                "extract_unity_il2cpp",
                { path: args.path, output_directory: options.output },
                { signal },
              ),
            service,
            "unity-il2cpp",
            "extract_unity_il2cpp",
            signal,
          ),
        ),
      ),
  });
};
