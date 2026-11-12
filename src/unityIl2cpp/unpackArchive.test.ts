import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("../../bridge/unity-il2cpp/unpack_archive.py", import.meta.url),
);
const roots: string[] = [];

const temp = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-unity-unpack-"));
  roots.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const python = async (): Promise<boolean> => {
  try {
    await exec("python3", ["-c", "import zipfile"]);
    return true;
  } catch {
    return false;
  }
};

describe("local archive unpack", () => {
  it("extracts a stored member and refuses a parent-path entry", async () => {
    if (!(await python())) return;
    const root = await temp();
    const good = join(root, "good.zip");
    const bad = join(root, "bad.zip");
    await exec("python3", [
      "-c",
      `
import zipfile
with zipfile.ZipFile(${JSON.stringify(good)}, "w") as archive:
    archive.writestr("assets/hello.txt", "synthetic")
with zipfile.ZipFile(${JSON.stringify(bad)}, "w") as archive:
    archive.writestr("../evil.txt", "nope")
`,
    ]);
    const destination = join(root, "out");
    await exec("python3", [script, good, destination, "1000000"]);
    expect(
      await readFile(join(destination, "assets", "hello.txt"), "utf8"),
    ).toBe("synthetic");
    const refused = await exec(
      "python3",
      [script, bad, join(root, "bad-out"), "1000000"],
      {
        // Non-zero is the assertion.
      },
    ).then(
      () => "ran",
      (cause: { stderr?: string; code?: number }) => cause,
    );
    expect(typeof refused).not.toBe("string");
    if (typeof refused === "string") return;
    expect(refused.stderr ?? "").toContain("unsafe zip entry");
    await expect(stat(join(root, "evil.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
