import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { UnityIl2cppPort } from "./UnityIl2cppPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, type Result } from "../../domain/result.js";
import {
  UNITY_IL2CPP_PROVIDER,
  unityIl2cppInputSchema,
  unityIl2cppResultSchema,
} from "../../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";

const OPERATION = "extract_unity_il2cpp";

/** Shared CLI and MCP validation for one local Unity IL2CPP extraction. */
export class UnityIl2cppService {
  constructor(readonly provider: UnityIl2cppPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async execute(
    operation: typeof OPERATION,
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (operation !== OPERATION)
      return err(
        new AnalysisInputError(operation, {
          userMessage: "Unknown Unity IL2CPP operation.",
        }),
      );
    if (options?.signal?.aborted === true)
      return err(
        new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
      );
    const input = unityIl2cppInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    const extracted = await this.provider.extract(input.data, options);
    if (!extracted.ok) return extracted;
    const report = unityIl2cppResultSchema.safeParse(extracted.value);
    if (
      !report.success ||
      report.data.input.path !== input.data.path ||
      report.data.output_directory !== input.data.output_directory
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Unity IL2CPP extraction returned a report that does not match the selected paths.",
        ),
      );
    return completeProviderEvidence(
      createEvidence(
        {
          path: input.data.path,
          sha256: report.data.input.sha256,
          format: report.data.input.format === "apk" ? "apk" : "zip",
        },
        UNITY_IL2CPP_PROVIDER,
        {
          operation: OPERATION,
          parameters: input.data,
          result: report.data,
          confidence: "derived",
          limitations: [...report.data.limitations],
          locations: [
            { kind: "artifact-path", path: input.data.path },
            { kind: "artifact-path", path: input.data.output_directory },
          ],
        },
      ),
      options?.signal,
    );
  }
}
