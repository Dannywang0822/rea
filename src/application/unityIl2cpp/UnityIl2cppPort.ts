import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Result } from "../../domain/result.js";
import type {
  UnityIl2cppInput,
  UnityIl2cppReport,
} from "../../domain/unityIl2cpp/unityIl2cppAnalysis.js";

/** Local Unity IL2CPP extraction. The package is not executed. */
export interface UnityIl2cppPort {
  close?(): Promise<void>;
  extract(
    input: UnityIl2cppInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityIl2cppReport, AnalysisError>>;
}
