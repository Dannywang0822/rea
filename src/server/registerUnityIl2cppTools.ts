import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { UnityIl2cppService } from "../application/unityIl2cpp/UnityIl2cppService.js";
import type { UnityIl2cppPort } from "../application/unityIl2cpp/UnityIl2cppPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind Unity IL2CPP extraction to its named contract. */
export const registerUnityIl2cppTools = (
  server: EvidenceMcpServer,
  provider: UnityIl2cppPort,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const service = new UnityIl2cppService(provider);
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  const contract = toolContract("extract_unity_il2cpp");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
