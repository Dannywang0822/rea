import type { UnityIl2cppPort } from "../application/unityIl2cpp/UnityIl2cppPort.js";
import { createUnityIl2cppPipeline } from "../unityIl2cpp/pipeline.js";

/** Construct the pinned local Unity IL2CPP extractor. */
export const createUnityIl2cppProvider = (): UnityIl2cppPort =>
  createUnityIl2cppPipeline();
