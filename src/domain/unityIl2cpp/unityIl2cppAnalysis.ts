import { isAbsolute } from "node:path";
import { z } from "zod";

import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

/**
 * Directory name, under the caller-selected output, that holds unpacked
 * package bytes and AssetRipper-exported original textures, audio, fonts, and
 * text. The repository gitignore ignores this name. Do not package, upload,
 * or commit it.
 */
export const LOCAL_ONLY_DIRECTORY_NAME = "LOCAL_ONLY_DO_NOT_PACKAGE";

/** Written into the local-only directory and returned with every result. */
export const LOCAL_ONLY_NOTICE = [
  "This directory contains unpacked original package bytes and AssetRipper-exported original textures, audio, fonts, and text.",
  "It is for local static analysis only.",
  "Do not package it into a product, do not upload it, do not commit it to a repository, and do not share it.",
].join(" ");

/** Pinned helpers. Binary archives are SHA-256 pinned; UnityPy is version pinned. */
export const UNITY_IL2CPP_PINS = {
  unityPy: "1.25.4",
  cpp2ilVersion: "2022.1.0-pre-release.21",
  cpp2ilSha256:
    "526998e593c52c029c5a6215c5c6c9f9d963706bfc409fc9ff80a95c4c500349",
  cpp2ilUrl:
    "https://github.com/SamboyCoding/Cpp2IL/releases/download/2022.1.0-pre-release.21/Cpp2IL-2022.1.0-pre-release.21-Linux",
  assetRipperVersion: "2.0.0",
  assetRipperSha256:
    "6f5d4352d36795b944243eb3ec790ec37dbca6d6756e52605bc8616e042d384e",
  assetRipperUrl:
    "https://github.com/AssetRipper/AssetRipper/releases/download/2.0.0/AssetRipper_linux_x64.tar.xz",
  /** Used only when the player data does not contain an observed Unity version. */
  fallbackUnityVersion: "6000.1.17f1",
} as const;

export const UNITY_IL2CPP_PROVIDER = {
  id: "unity-il2cpp",
  name: "Unity IL2CPP static extractor",
  version: `unitypy-${UNITY_IL2CPP_PINS.unityPy}+cpp2il-${UNITY_IL2CPP_PINS.cpp2ilVersion}+assetripper-${UNITY_IL2CPP_PINS.assetRipperVersion}`,
} as const;

const absolutePath = (field: string) =>
  localPathStringSchema.refine(isAbsolute, {
    message: `${field} must be an absolute local filesystem path`,
  });

/** Caller-selected package and output. Relative paths are rejected. */
export const unityIl2cppInputSchema = z.strictObject({
  path: absolutePath("path").describe(
    "Absolute local XAPK or APK path. The package is not executed, modified, or uploaded.",
  ),
  output_directory: absolutePath("output_directory").describe(
    "Absolute output directory, created if absent and empty if it already exists. Derived tables are written here. Original bytes go in LOCAL_ONLY_DO_NOT_PACKAGE inside this directory and must not be packaged, uploaded, or committed.",
  ),
});

export type UnityIl2cppInput = z.infer<typeof unityIl2cppInputSchema>;

const derivedFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  role: z.string().min(1),
});

const failureSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().min(1),
});

/**
 * Summary returned to CLI and MCP. Full tables stay on disk. Planet SOI
 * estimates are not in this summary; the planet table marks them as inference.
 */
export const unityIl2cppResultSchema = z.strictObject({
  input: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    format: z.enum(["apk", "xapk"]),
  }),
  output_directory: z.string().min(1),
  local_only_directory: z.string().min(1),
  local_only_notice: z.literal(LOCAL_ONLY_NOTICE),
  derived_files: z.array(derivedFileSchema),
  counts: z.strictObject({
    planets: z.number().int().nonnegative(),
    parts: z.number().int().nonnegative(),
    fuels: z.number().int().nonnegative(),
    parachute_modules: z.number().int().nonnegative(),
    ui_scenes: z.number().int().nonnegative(),
    il2cpp_types: z.number().int().nonnegative(),
    il2cpp_fields: z.number().int().nonnegative(),
    difficulty_candidates: z.number().int().nonnegative(),
  }),
  tools: z.strictObject({
    unitypy: z.string().min(1),
    cpp2il: z.string().min(1),
    cpp2il_sha256: digestSchema,
    assetripper: z.string().min(1),
    assetripper_archive_sha256: digestSchema,
    unity_version: z.string().min(1),
    unity_version_source: z.enum(["observed", "fallback"]),
    abi: z.string().min(1),
  }),
  unparsed_files: z.array(failureSchema),
  limitations: z.array(z.string().min(1)),
});

export type UnityIl2cppReport = z.infer<typeof unityIl2cppResultSchema>;

/** Facts that are true of every successful extraction. */
export const UNITY_IL2CPP_STANDING_LIMITATIONS = [
  "Original unpacked package bytes and AssetRipper-exported textures, audio, fonts, and text are written only under LOCAL_ONLY_DO_NOT_PACKAGE. Do not package, upload, or commit that directory or extracted game tables.",
  "Derived tables are serialized-asset observations plus explicitly marked inferences. IL method bodies are not recovered.",
  "Cpp2IL runs in dummydll mode. The class and field table is type structure only. Obfuscated flight formulas, physics integration, thrust conversion, and drag equations are not reconstructed.",
  "Nested PrefabInstance overrides are not expanded.",
  "Planet soi_estimate uses the Laplace approximation a*(mu/muParent)^0.4*multiplierSOI. It is an inference, not a value read from code. multiplierSOI itself is serialized when present.",
  "Difficulty candidates are unlabeled 3-element double arrays. Field-name mapping is unknown and is not inferred from IL.",
  "Serialized oldMass is reported as stored. A runtime mass variable reference is not verified against IL.",
  "AssetRipper is a pinned local helper. It listens on 127.0.0.1 only and does not receive the package over the network.",
] as const;
