import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  constants,
  cp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { UnityIl2cppPort } from "../application/unityIl2cpp/UnityIl2cppPort.js";
import { artifactDecompressionBudgetBytes } from "../domain/artifactDecompressionBudget.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  LOCAL_ONLY_DIRECTORY_NAME,
  LOCAL_ONLY_NOTICE,
  UNITY_IL2CPP_PINS,
  UNITY_IL2CPP_PROVIDER,
  UNITY_IL2CPP_STANDING_LIMITATIONS,
  type UnityIl2cppInput,
  type UnityIl2cppReport,
  unityIl2cppResultSchema,
} from "../domain/unityIl2cpp/unityIl2cppAnalysis.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { waitForAbortableDelay } from "../process/ProviderDeadline.js";
import { planUnityDataMerge, splitSequenceError } from "./dataMerge.js";
import { deriveUnityIl2cppTables } from "./deriveTables.js";

const OPERATION = "extract_unity_il2cpp";
const PROVIDER_ID = UNITY_IL2CPP_PROVIDER.id;
const ABI_PREFERENCE = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"];
const UNITY_VERSION = /[0-9]{4}\.[0-9]+\.[0-9]+f[0-9]+/u;

const bridgeScript = (name: string): string =>
  fileURLToPath(new URL(`../../bridge/unity-il2cpp/${name}`, import.meta.url));

/** Linux x64 is the verified host for the pinned Cpp2IL and AssetRipper binaries. */
export const unityIl2cppHostProblem = (
  platform: string,
  arch: string,
): string | undefined =>
  platform === "linux" && arch === "x64"
    ? undefined
    : "extract-unity-il2cpp is verified on Linux x64. The pinned Cpp2IL and AssetRipper binaries are Linux x64 builds.";

/** Cache directory for pinned helpers. Relative overrides are rejected. */
export const unityIl2cppCacheDirectory = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const override = env.REA_UNITY_IL2CPP_CACHE;
  if (override !== undefined) {
    if (!isAbsolute(override))
      throw new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["REA_UNITY_IL2CPP_CACHE"],
          reason: "invalid_format",
          message: "REA_UNITY_IL2CPP_CACHE must be an absolute directory.",
        },
      ]);
    return override;
  }
  const xdg = env.XDG_CACHE_HOME;
  if (xdg !== undefined && isAbsolute(xdg))
    return join(xdg, "rea", "unity-il2cpp");
  const home = env.HOME;
  if (home !== undefined && isAbsolute(home))
    return join(home, ".cache", "rea", "unity-il2cpp");
  throw new AnalysisInputError(
    OPERATION,
    {
      userMessage:
        "Set REA_UNITY_IL2CPP_CACHE to an absolute directory for pinned Unity helpers.",
    },
    [
      {
        path: ["REA_UNITY_IL2CPP_CACHE"],
        reason: "missing_argument",
        message: "No absolute cache directory is available.",
      },
    ],
  );
};

const cancelled = (signal?: AbortSignal): AnalysisError | undefined =>
  signal?.aborted === true
    ? new AnalysisCancelledError(OPERATION, { cause: signal.reason })
    : undefined;

const commandError = (cause: unknown, timeoutMs: number): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof OwnedCommandFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(OPERATION, { cause });
    if (cause.reason === "timeout")
      return new AnalysisTimeoutError(OPERATION, timeoutMs, {
        cause,
        userMessage: cause.message,
      });
    const stderr = cause.snapshot?.stderr.text.slice(0, 500) ?? "";
    return new AnalysisOutputError(OPERATION, cause.message, {
      cause,
      userMessage:
        stderr.length === 0 ? cause.message : `${cause.message}\n${stderr}`,
    });
  }
  return new ProviderAdapterError(PROVIDER_ID, OPERATION, {
    cause: cause instanceof Error ? cause : undefined,
    userMessage:
      cause instanceof Error ? cause.message : "Unity IL2CPP extraction failed",
  });
};

const resolveExecutable = async (command: string): Promise<string> => {
  if (command.includes(sep) || command.startsWith("/")) {
    await access(command, constants.X_OK);
    return realpath(command);
  }
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(":")) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  throw new AnalysisCapabilityUnavailableError(
    PROVIDER_ID,
    OPERATION,
    `${command} was not found on PATH`,
    {
      userMessage: `Install ${command} or set an absolute path before extracting a Unity IL2CPP package.`,
      retryable: true,
    },
  );
};

const runCommand = async (
  command: string,
  args: readonly string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  acceptNonZeroExit = false,
) => {
  const executable = await resolveExecutable(command);
  const blocked = cancelled(signal);
  if (blocked !== undefined) throw blocked;
  try {
    return await runOwnedCommand(
      {
        command: executable,
        arguments: args,
        expectedCommand: executable,
        runId: `rea-unity-il2cpp-${randomUUID()}`,
        hostEnvironment: process.env,
        ...(signal === undefined ? {} : { signal }),
      },
      {
        timeoutMs,
        diagnosticBytes: 8 * 1024 * 1024,
        ...(acceptNonZeroExit ? { acceptNonZeroExit: true } : {}),
      },
      signal === undefined ? {} : { signal },
    );
  } catch (cause) {
    throw commandError(cause, timeoutMs);
  }
};

const sha256File = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  const hash = createHash("sha256");
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

const sameDigest = (actual: string, expected: string): boolean =>
  actual.length === expected.length &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

const downloadPinned = async (
  url: string,
  destination: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (
    url !== UNITY_IL2CPP_PINS.cpp2ilUrl &&
    url !== UNITY_IL2CPP_PINS.assetRipperUrl
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Refusing a download that is not a pinned Unity helper",
    );
  await mkdir(dirname(destination), { recursive: true });
  try {
    if (sameDigest(await sha256File(destination, signal), expectedSha256))
      return;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code !== "ENOENT") throw cause;
  }
  const partial = `${destination}.partial`;
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "rea-unity-il2cpp" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok || response.body === null)
    throw new AnalysisOutputError(
      OPERATION,
      `Pinned helper download failed with HTTP ${String(response.status)}`,
      {
        userMessage:
          "The pinned helper could not be downloaded. Package bytes were not sent.",
      },
    );
  const hash = createHash("sha256");
  const handle = await open(partial, "w");
  try {
    const reader = response.body.getReader();
    while (true) {
      const step = await reader.read();
      if (step.done) break;
      const bytes = Buffer.from(step.value);
      hash.update(bytes);
      let view = bytes.subarray(0);
      while (view.length > 0) {
        const { bytesWritten } = await handle.write(view);
        view = view.subarray(bytesWritten);
      }
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  if (!sameDigest(digest, expectedSha256)) {
    await rm(partial, { force: true });
    throw new AnalysisOutputError(
      OPERATION,
      "Pinned helper SHA-256 did not match the recorded digest",
      {
        userMessage:
          "The downloaded helper was discarded because its SHA-256 did not match. It was not executed.",
      },
    );
  }
  await rename(partial, destination);
};

const countBySuffix = async (root: string, suffix: string): Promise<number> => {
  let count = 0;
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1;
    }
  };
  await visit(root, 0);
  return count;
};

const findNamed = async (root: string, fileName: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name === fileName) found.push(path);
    }
  };
  await visit(root, 0);
  return found.sort();
};

const chooseIl2Cpp = (paths: readonly string[]): string => {
  const ranked = [...paths].sort((left, right) => {
    const leftRank = ABI_PREFERENCE.findIndex((abi) =>
      left.includes(`${sep}${abi}${sep}`),
    );
    const rightRank = ABI_PREFERENCE.findIndex((abi) =>
      right.includes(`${sep}${abi}${sep}`),
    );
    const leftScore = leftRank < 0 ? ABI_PREFERENCE.length : leftRank;
    const rightScore = rightRank < 0 ? ABI_PREFERENCE.length : rightRank;
    return leftScore - rightScore || left.localeCompare(right);
  });
  const selected = ranked[0];
  if (selected === undefined)
    throw new AnalysisOutputError(
      OPERATION,
      "libil2cpp.so was not found. This command reads IL2CPP packages only.",
    );
  return selected;
};

const abiName = (soPath: string): string => {
  const parts = soPath.split(sep);
  return parts.at(-2) ?? "unknown";
};

const unityVersionIn = async (
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined> => {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    let carry = Buffer.alloc(0);
    const chunk = Buffer.alloc(1024 * 1024);
    while (true) {
      const blocked = cancelled(signal);
      if (blocked !== undefined) throw blocked;
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return undefined;
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const match = UNITY_VERSION.exec(window.toString("latin1"));
      if (match?.[0] !== undefined) return match[0];
      carry = window.subarray(Math.max(0, window.length - 64));
    }
  } finally {
    await handle.close();
  }
};

const concatenate = async (
  parts: readonly string[],
  destination: string,
  signal?: AbortSignal,
): Promise<void> => {
  const output = await open(destination, "w");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (const part of parts) {
      const input = await open(part, "r");
      try {
        while (true) {
          const blocked = cancelled(signal);
          if (blocked !== undefined) throw blocked;
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (bytesRead === 0) break;
          let view = buffer.subarray(0, bytesRead);
          while (view.length > 0) {
            const { bytesWritten } = await output.write(view);
            view = view.subarray(bytesWritten);
          }
        }
      } finally {
        await input.close();
      }
    }
  } finally {
    await output.close();
  }
};

const mergeUnityData = async (
  dataDirectory: string,
  mergedDirectory: string,
  signal?: AbortSignal,
): Promise<void> => {
  await rm(mergedDirectory, { recursive: true, force: true });
  await mkdir(mergedDirectory, { recursive: true });
  const names = await readdir(dataDirectory);
  const plan = planUnityDataMerge(names);
  for (const name of plan.link) {
    await symlink(join(dataDirectory, name), join(mergedDirectory, name));
  }
  for (const group of plan.groups) {
    const sequence = splitSequenceError(group.parts);
    if (sequence !== undefined)
      throw new AnalysisOutputError(OPERATION, `${group.base}: ${sequence}`);
    await concatenate(
      group.parts.map((part) => join(dataDirectory, part.name)),
      join(mergedDirectory, group.base),
      signal,
    );
  }
};

const ensurePythonEnvironment = async (
  cache: string,
  python: string,
  signal?: AbortSignal,
): Promise<string> => {
  const venvPython = join(cache, "venv", "bin", "python");
  const versionCheck = await runCommand(
    python,
    [
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)",
    ],
    30_000,
    signal,
    true,
  );
  if (versionCheck.exitCode !== 0)
    throw new AnalysisCapabilityUnavailableError(
      PROVIDER_ID,
      OPERATION,
      "Python 3.11 or newer is required for UnityPy",
      { retryable: true },
    );
  try {
    await access(venvPython, constants.X_OK);
  } catch {
    await runCommand(
      python,
      ["-m", "venv", join(cache, "venv")],
      120_000,
      signal,
    );
  }
  const installed = await runCommand(
    venvPython,
    ["-c", "import UnityPy; print(getattr(UnityPy, '__version__', ''))"],
    60_000,
    signal,
    true,
  );
  if (installed.stdout.text.trim() === UNITY_IL2CPP_PINS.unityPy)
    return venvPython;
  await runCommand(
    venvPython,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--no-input",
      "--index-url",
      "https://pypi.org/simple",
      `UnityPy==${UNITY_IL2CPP_PINS.unityPy}`,
    ],
    10 * 60_000,
    signal,
  );
  const confirmed = await runCommand(
    venvPython,
    ["-c", "import UnityPy; print(getattr(UnityPy, '__version__', ''))"],
    60_000,
    signal,
  );
  if (confirmed.stdout.text.trim() !== UNITY_IL2CPP_PINS.unityPy)
    throw new AnalysisOutputError(
      OPERATION,
      `UnityPy ${UNITY_IL2CPP_PINS.unityPy} was not importable after installation`,
    );
  return venvPython;
};

const findAssetRipper = async (root: string): Promise<string> => {
  const found: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name === "AssetRipper.GUI.Free")
        found.push(path);
    }
  };
  await visit(root, 0);
  const binary = found.sort()[0];
  if (binary === undefined)
    throw new AnalysisOutputError(
      OPERATION,
      "AssetRipper.GUI.Free was not in the pinned archive",
    );
  await chmod(binary, 0o755);
  return binary;
};

const pickPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      listener.close((error) =>
        error === undefined ? resolve(port) : reject(error),
      );
    });
  });

const localRequest = async (
  port: number,
  route: string,
  body: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ readonly ok: boolean; readonly status: number }> => {
  const url = new URL(`http://127.0.0.1:${String(port)}${route}`);
  if (url.hostname !== "127.0.0.1")
    throw new AnalysisOutputError(
      OPERATION,
      "AssetRipper requests stay on 127.0.0.1",
    );
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "content-type": "application/x-www-form-urlencoded" },
    ...(body === undefined ? {} : { body }),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  await response.arrayBuffer();
  return { ok: response.ok, status: response.status };
};

const exportWithAssetRipper = async (
  binary: string,
  gameDirectory: string,
  exportDirectory: string,
  logPath: string,
  signal?: AbortSignal,
): Promise<void> => {
  await mkdir(dirname(logPath), { recursive: true });
  await rm(exportDirectory, { recursive: true, force: true });
  let lastError: AnalysisError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const blocked = cancelled(signal);
    if (blocked !== undefined) throw blocked;
    const port = await pickPort();
    const launched = await spawnOwnedProviderProcess({
      command: binary,
      arguments: ["--headless", "--port", String(port), "--log-path", logPath],
      expectedCommand: binary,
      cwd: dirname(binary),
      runId: `rea-assetripper-${randomUUID()}`,
      hostEnvironment: process.env,
      ...(signal === undefined ? {} : { signal }),
    });
    const supervisor = new ProviderProcessSupervisor(
      {
        ...launched,
        ownsProcessLifetime: true,
        cleanup:
          launched.cleanup ??
          (() => cleanupOwnedProcessGroup(launched.ownership)),
      },
      { maxDiagnosticBytes: 256 * 1024 },
    );
    let cleanup: AnalysisError | undefined;
    let finished = false;
    try {
      let ready = false;
      for (let probe = 0; probe < 60; probe += 1) {
        const aborted = cancelled(signal);
        if (aborted !== undefined) throw aborted;
        if (supervisor.observedExit() !== undefined) break;
        try {
          const response = await localRequest(
            port,
            "/",
            undefined,
            2_000,
            signal,
          );
          if (response.ok) {
            ready = true;
            break;
          }
        } catch (cause) {
          const abortedDuringProbe = cancelled(signal);
          if (abortedDuringProbe !== undefined) throw abortedDuringProbe;
          if (cause instanceof AnalysisError) throw cause;
        }
        if ((await waitForAbortableDelay(1_000, signal)) === "aborted")
          throw new AnalysisCancelledError(OPERATION, {
            cause: signal?.reason,
          });
      }
      if (!ready)
        throw new AnalysisOutputError(
          OPERATION,
          "AssetRipper did not accept connections on 127.0.0.1",
        );
      const loaded = await localRequest(
        port,
        "/LoadFolder",
        new URLSearchParams({ path: gameDirectory }).toString(),
        10 * 60_000,
        signal,
      );
      if (!loaded.ok)
        throw new AnalysisOutputError(
          OPERATION,
          `AssetRipper LoadFolder returned HTTP ${String(loaded.status)}`,
        );
      const exported = await localRequest(
        port,
        "/Export/UnityProject",
        new URLSearchParams({ path: exportDirectory }).toString(),
        30 * 60_000,
        signal,
      );
      if (!exported.ok)
        throw new AnalysisOutputError(
          OPERATION,
          `AssetRipper export returned HTTP ${String(exported.status)}`,
        );
      finished = true;
    } catch (cause) {
      lastError =
        cause instanceof AnalysisError
          ? cause
          : commandError(cause, 30 * 60_000);
    } finally {
      const stopped = await supervisor.stop();
      supervisor.dispose();
      if (stopped.status === "incomplete")
        cleanup = new ProviderCleanupError(
          PROVIDER_ID,
          [`pid:${String(launched.ownership.leaderPid)}`, binary],
          { reason: stopped.reason },
          { operation: OPERATION },
        );
    }
    if (cleanup !== undefined) throw cleanup;
    if (finished) return;
    if (lastError instanceof AnalysisCancelledError) throw lastError;
  }
  throw (
    lastError ??
    new AnalysisOutputError(OPERATION, "AssetRipper export did not finish")
  );
};

const writeLocalOnlyMarker = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "README_DO_NOT_PACKAGE.txt"),
    `${LOCAL_ONLY_NOTICE}\n`,
    "utf8",
  );
  await writeFile(
    join(directory, ".gitignore"),
    [
      "# Unpacked original package bytes and exported original assets.",
      "# Do not package, upload, or commit this directory.",
      "*",
      "!.gitignore",
      "!README_DO_NOT_PACKAGE.txt",
      "",
    ].join("\n"),
    "utf8",
  );
};

const emptyOrCreate = async (directory: string): Promise<void> => {
  const parent = dirname(directory);
  let parentInfo;
  try {
    parentInfo = await stat(parent);
  } catch {
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["output_directory"],
        reason: "invalid_value",
        message: "The output directory's parent must exist.",
      },
    ]);
  }
  if (!parentInfo.isDirectory())
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["output_directory"],
        reason: "invalid_value",
        message: "The output directory's parent is not a directory.",
      },
    ]);
  try {
    const info = await stat(directory);
    if (!info.isDirectory())
      throw new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["output_directory"],
          reason: "invalid_value",
          message: "The output path exists and is not a directory.",
        },
      ]);
    const entries = await readdir(directory);
    if (entries.length > 0)
      throw new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["output_directory"],
          reason: "invalid_value",
          message: "The output directory must be absent or empty.",
        },
      ]);
  } catch (cause) {
    if (cause instanceof AnalysisInputError) throw cause;
    if ((cause as { code?: string }).code !== "ENOENT") throw cause;
  }
  await mkdir(directory, { recursive: true });
};

const extractPackage = async (
  input: UnityIl2cppInput,
  signal?: AbortSignal,
): Promise<UnityIl2cppReport> => {
  const hostProblem = unityIl2cppHostProblem(process.platform, process.arch);
  if (hostProblem !== undefined)
    throw new AnalysisCapabilityUnavailableError(
      PROVIDER_ID,
      OPERATION,
      hostProblem,
      { userMessage: hostProblem },
    );
  const blocked = cancelled(signal);
  if (blocked !== undefined) throw blocked;
  let inputReal: string;
  try {
    inputReal = await realpath(input.path);
  } catch (cause) {
    if ((cause as { code?: string }).code === "ENOENT")
      throw new AnalysisInputError(OPERATION, undefined, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: "The package path does not exist.",
        },
      ]);
    throw cause;
  }
  const inputInfo = await stat(inputReal);
  if (!inputInfo.isFile())
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: "The package path must be a regular file.",
      },
    ]);
  await emptyOrCreate(input.output_directory);
  const outputReal = await realpath(input.output_directory);
  if (
    inputReal === outputReal ||
    isPathWithinRoot(outputReal, inputReal) ||
    isPathWithinRoot(inputReal, outputReal)
  )
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["output_directory"],
        reason: "invalid_value",
        message:
          "The output directory must not contain or be inside the package.",
      },
    ]);
  const cache = unityIl2cppCacheDirectory(process.env);
  const pythonOverride = process.env.REA_UNITY_IL2CPP_PYTHON;
  if (pythonOverride !== undefined && !isAbsolute(pythonOverride))
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["REA_UNITY_IL2CPP_PYTHON"],
        reason: "invalid_format",
        message: "REA_UNITY_IL2CPP_PYTHON must be an absolute path.",
      },
    ]);
  const localOnly = join(outputReal, LOCAL_ONLY_DIRECTORY_NAME);
  await writeLocalOnlyMarker(localOnly);
  const packageSha = await sha256File(inputReal, signal);
  const budget = artifactDecompressionBudgetBytes(inputInfo.size);
  const rawRoot = join(localOnly, "raw");
  await rm(rawRoot, { recursive: true, force: true });
  const packageRoot = join(rawRoot, "package");
  await runCommand(
    pythonOverride ?? "python3",
    [bridgeScript("unpack_archive.py"), inputReal, packageRoot, String(budget)],
    30 * 60_000,
    signal,
  );
  const top = await readdir(packageRoot);
  const innerApks = top.filter((name) => name.endsWith(".apk")).sort();
  const format = innerApks.length > 0 ? "xapk" : "apk";
  if (innerApks.length > 0) {
    for (const name of innerApks) {
      const apk = join(packageRoot, name);
      const apkInfo = await stat(apk);
      await runCommand(
        pythonOverride ?? "python3",
        [
          bridgeScript("unpack_archive.py"),
          apk,
          join(rawRoot, `apk_${name.replace(/\.apk$/u, "")}`),
          String(artifactDecompressionBudgetBytes(apkInfo.size)),
        ],
        30 * 60_000,
        signal,
      );
    }
  }
  const searchRoot = innerApks.length > 0 ? rawRoot : packageRoot;
  const metadataFiles = await findNamed(searchRoot, "global-metadata.dat");
  const metadata = metadataFiles.find((path) =>
    path.endsWith(`${sep}Managed${sep}Metadata${sep}global-metadata.dat`),
  );
  if (metadata === undefined)
    throw new AnalysisOutputError(
      OPERATION,
      "global-metadata.dat was not found under Managed/Metadata",
    );
  const dataDirectory = dirname(dirname(dirname(metadata)));
  const assetsIndex = dataDirectory.lastIndexOf(
    `${sep}assets${sep}bin${sep}Data`,
  );
  if (assetsIndex < 0)
    throw new AnalysisOutputError(
      OPERATION,
      "Player data was not under assets/bin/Data",
    );
  const assetsDirectory = dataDirectory.slice(
    0,
    assetsIndex + `${sep}assets`.length,
  );
  const soPath = chooseIl2Cpp(await findNamed(searchRoot, "libil2cpp.so"));
  const libDirectory = dirname(dirname(soPath));
  const gameDirectory = join(localOnly, "game");
  await rm(gameDirectory, { recursive: true, force: true });
  await mkdir(gameDirectory, { recursive: true });
  await cp(assetsDirectory, join(gameDirectory, "assets"), { recursive: true });
  await cp(libDirectory, join(gameDirectory, "lib"), { recursive: true });
  const merged = join(localOnly, "Data_merged");
  await mergeUnityData(dataDirectory, merged, signal);
  const observedVersion = await unityVersionIn(
    join(merged, "globalgamemanagers"),
    signal,
  );
  const unityVersion =
    observedVersion ?? UNITY_IL2CPP_PINS.fallbackUnityVersion;
  const cpp2ilPath = join(
    cache,
    `Cpp2IL-${UNITY_IL2CPP_PINS.cpp2ilVersion}-linux`,
  );
  await downloadPinned(
    UNITY_IL2CPP_PINS.cpp2ilUrl,
    cpp2ilPath,
    UNITY_IL2CPP_PINS.cpp2ilSha256,
    signal,
  );
  await chmod(cpp2ilPath, 0o755);
  const archivePath = join(
    cache,
    `AssetRipper_${UNITY_IL2CPP_PINS.assetRipperVersion}_linux_x64.tar.xz`,
  );
  await downloadPinned(
    UNITY_IL2CPP_PINS.assetRipperUrl,
    archivePath,
    UNITY_IL2CPP_PINS.assetRipperSha256,
    signal,
  );
  const ripperRoot = join(cache, "assetripper");
  const ripperBinary = join(ripperRoot, "AssetRipper.GUI.Free");
  let binaryReady = false;
  try {
    await access(ripperBinary, constants.X_OK);
    binaryReady = true;
  } catch {
    binaryReady = false;
  }
  if (!binaryReady) {
    await rm(ripperRoot, { recursive: true, force: true });
    await mkdir(ripperRoot, { recursive: true });
    await runCommand(
      "tar",
      ["-xJf", archivePath, "-C", ripperRoot],
      120_000,
      signal,
    );
  }
  const assetRipper = await findAssetRipper(ripperRoot);
  const venvPython = await ensurePythonEnvironment(
    cache,
    pythonOverride ?? "python3",
    signal,
  );
  const textAssets = join(localOnly, "textassets");
  await rm(textAssets, { recursive: true, force: true });
  const dumped = await runCommand(
    venvPython,
    [bridgeScript("dump_textassets.py"), merged, textAssets],
    20 * 60_000,
    signal,
  );
  const unityPyLine = dumped.stdout.text
    .split("\n")
    .find((line) => line.startsWith("UNITYPY "));
  const dummyDirectory = join(localOnly, "cpp2il_dummydll");
  await rm(dummyDirectory, { recursive: true, force: true });
  await mkdir(dummyDirectory, { recursive: true });
  const cpp2il = await runCommand(
    cpp2ilPath,
    [
      "--force-binary-path",
      soPath,
      "--force-metadata-path",
      metadata,
      "--force-unity-version",
      unityVersion,
      "--output-as",
      "dummydll",
      "--output-to",
      dummyDirectory,
    ],
    20 * 60_000,
    signal,
    true,
  );
  const dllCount = await countBySuffix(dummyDirectory, ".dll");
  if (dllCount === 0)
    throw new AnalysisOutputError(
      OPERATION,
      "Cpp2IL did not write dummy DLLs",
      {
        userMessage:
          cpp2il.stderr.text.slice(0, 500) || cpp2il.stdout.text.slice(0, 500),
      },
    );
  const exportDirectory = join(localOnly, "ar_out");
  await exportWithAssetRipper(
    assetRipper,
    gameDirectory,
    exportDirectory,
    join(localOnly, "assetripper.log"),
    signal,
  );
  const exportedAssets = await findExportedAssets(exportDirectory);
  const derived = await deriveUnityIl2cppTables({
    outputDirectory: outputReal,
    textAssetsDirectory: textAssets,
    exportedAssetsDirectory: exportedAssets,
    dummyDllDirectory: dummyDirectory,
    metadataPath: metadata,
  });
  await writeLocalOnlyMarker(localOnly);
  const limitations = [
    ...UNITY_IL2CPP_STANDING_LIMITATIONS,
    ...derived.notes,
    ...(observedVersion === undefined
      ? [
          `Unity version text was not observed. Cpp2IL used the fallback ${UNITY_IL2CPP_PINS.fallbackUnityVersion}.`,
        ]
      : []),
    ...(cpp2il.exitCode !== 0
      ? [
          `Cpp2IL exited ${String(cpp2il.exitCode)} after writing dummy DLLs. Class and field structure was still read. Method bodies were not recovered.`,
        ]
      : []),
  ];
  const report = unityIl2cppResultSchema.parse({
    input: { path: input.path, sha256: packageSha, format },
    output_directory: input.output_directory,
    local_only_directory: localOnly,
    local_only_notice: LOCAL_ONLY_NOTICE,
    derived_files: derived.derived_files,
    counts: derived.counts,
    tools: {
      unitypy:
        unityPyLine?.slice("UNITYPY ".length) ?? UNITY_IL2CPP_PINS.unityPy,
      cpp2il: UNITY_IL2CPP_PINS.cpp2ilVersion,
      cpp2il_sha256: UNITY_IL2CPP_PINS.cpp2ilSha256,
      assetripper: UNITY_IL2CPP_PINS.assetRipperVersion,
      assetripper_archive_sha256: UNITY_IL2CPP_PINS.assetRipperSha256,
      unity_version: unityVersion,
      unity_version_source:
        observedVersion === undefined ? "fallback" : "observed",
      abi: abiName(soPath),
    },
    unparsed_files: derived.unparsed_files,
    limitations,
  });
  await writeFile(
    join(outputReal, "extraction_report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
};

const findExportedAssets = async (exportDirectory: string): Promise<string> => {
  const found: string[] = [];
  const visit = async (current: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (cause) {
      if ((cause as { code?: string }).code === "ENOENT") return;
      throw cause;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(current, entry.name);
      if (entry.name === "Assets" && current.endsWith(`${sep}ExportedProject`))
        found.push(path);
      else await visit(path, depth + 1);
    }
  };
  await visit(exportDirectory, 0);
  const assets = found.sort()[0];
  if (assets === undefined)
    throw new AnalysisOutputError(
      OPERATION,
      "AssetRipper did not write ExportedProject/Assets",
    );
  return assets;
};

/** Pinned local Unity IL2CPP extraction. One instance runs one package at a time. */
export class UnityIl2cppPipeline implements UnityIl2cppPort {
  #tail: Promise<void> = Promise.resolve();
  readonly #controllers = new Set<AbortController>();

  async extract(
    input: UnityIl2cppInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityIl2cppReport, AnalysisError>> {
    const run = this.#tail.then(() => this.#extract(input, options));
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #extract(
    input: UnityIl2cppInput,
    options?: ExecutionOptions,
  ): Promise<Result<UnityIl2cppReport, AnalysisError>> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
    try {
      return ok(await extractPackage(input, signal));
    } catch (cause) {
      return err(
        cause instanceof AnalysisError ? cause : commandError(cause, 0),
      );
    } finally {
      this.#controllers.delete(controller);
    }
  }

  close(): Promise<void> {
    for (const controller of this.#controllers) controller.abort();
    return Promise.resolve();
  }
}

export const createUnityIl2cppPipeline = (): UnityIl2cppPipeline =>
  new UnityIl2cppPipeline();
