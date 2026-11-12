import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { mapping, readUnityDocuments } from "./unityYaml.js";

export interface RectTransformRow {
  readonly path: string;
  readonly active: string;
  readonly anchorMin: string;
  readonly anchorMax: string;
  readonly pivot: string;
  readonly anchoredPos: string;
  readonly sizeDelta: string;
  readonly scale: string;
  readonly components: string;
}

const TSV_HEADER =
  "path\tactive\tanchorMin\tanchorMax\tpivot\tanchoredPos\tsizeDelta\tscale\tcomponents";

const cell = (value: string): string => value.replace(/[\t\r\n]/gu, " ");

const pair = (value: unknown): string => {
  const record = mapping(value);
  if (record === undefined) return "";
  return `(${String(record.x ?? "")},${String(record.y ?? "")})`;
};

const walk = async (directory: string, suffix: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (cause) {
      if ((cause as { code?: string }).code === "ENOENT") return;
      throw cause;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && path.endsWith(suffix)) found.push(path);
    }
  };
  await visit(directory);
  return found;
};

/** Dump RectTransform rows from one exported scene. */
export const parseSceneLayout = async (
  scenePath: string,
  assetsRoot: string,
): Promise<{
  readonly rows: readonly RectTransformRow[];
  readonly failures: readonly string[];
}> => {
  const metas = await walk(join(assetsRoot, "Scripts"), ".cs.meta");
  const guidToName = new Map<string, string>();
  for (const meta of metas) {
    const text = await readFile(meta, "utf8");
    const guid = /guid:\s*([0-9a-fA-F]+)/u.exec(text)?.[1];
    if (guid !== undefined)
      guidToName.set(guid, basename(meta).replace(/\.cs\.meta$/u, ""));
  }
  const text = await readFile(scenePath, "utf8");
  const documents = readUnityDocuments(text);
  const failures = documents.flatMap((document) =>
    document.error === undefined ? [] : [document.error],
  );
  const gameObjects = new Map<string, Record<string, unknown>>();
  const transforms = new Map<
    string,
    { readonly classId: number; readonly value: Record<string, unknown> }
  >();
  const components = new Map<string, string[]>();
  for (const document of documents) {
    if (document.error !== undefined || document.value === null) continue;
    const root = mapping(document.value);
    const key = root === undefined ? undefined : Object.keys(root)[0];
    const value = key === undefined ? undefined : mapping(root?.[key]);
    if (key === undefined || value === undefined) continue;
    if (document.classId === 1) gameObjects.set(document.fileId, value);
    if (document.classId === 224 || document.classId === 4)
      transforms.set(document.fileId, { classId: document.classId, value });
    const gameObject = mapping(value.m_GameObject);
    const owner = gameObject?.fileID;
    if (typeof owner !== "string" && typeof owner !== "number") continue;
    let componentName = key;
    if (document.classId === 114) {
      const guid = mapping(value.m_Script)?.guid;
      componentName =
        typeof guid === "string" ? (guidToName.get(guid) ?? "MB") : "MB";
    }
    const list = components.get(String(owner)) ?? [];
    list.push(componentName);
    components.set(String(owner), list);
  }
  const objectName = (transform: Record<string, unknown>): string => {
    const owner = mapping(transform.m_GameObject)?.fileID;
    if (typeof owner !== "string" && typeof owner !== "number") return "?";
    const name = gameObjects.get(String(owner))?.m_Name;
    return typeof name === "string" ? name : "?";
  };
  const hierarchy = (fileId: string): string => {
    const names: string[] = [];
    let current: string | undefined = fileId;
    const seen = new Set<string>();
    while (current !== undefined && current !== "0" && !seen.has(current)) {
      seen.add(current);
      const transform = transforms.get(current);
      if (transform === undefined) break;
      names.push(objectName(transform.value));
      const father = mapping(transform.value.m_Father)?.fileID;
      current =
        typeof father === "string" || typeof father === "number"
          ? String(father)
          : undefined;
      if (names.length > 40) break;
    }
    return names.reverse().join("/");
  };
  const rows: RectTransformRow[] = [];
  for (const [fileId, transform] of transforms) {
    if (transform.classId !== 224) continue;
    const owner = mapping(transform.value.m_GameObject)?.fileID;
    const gameObject =
      typeof owner === "string" || typeof owner === "number"
        ? gameObjects.get(String(owner))
        : undefined;
    const componentList = (
      typeof owner === "string" || typeof owner === "number"
        ? (components.get(String(owner)) ?? [])
        : []
    ).filter((name) => name !== "RectTransform" && name !== "CanvasRenderer");
    rows.push({
      path: hierarchy(fileId),
      active: String(gameObject?.m_IsActive ?? ""),
      anchorMin: pair(transform.value.m_AnchorMin),
      anchorMax: pair(transform.value.m_AnchorMax),
      pivot: pair(transform.value.m_Pivot),
      anchoredPos: pair(transform.value.m_AnchoredPosition),
      sizeDelta: pair(transform.value.m_SizeDelta),
      scale: pair(transform.value.m_LocalScale),
      components: componentList.join(","),
    });
  }
  rows.sort((left, right) => left.path.localeCompare(right.path));
  return { rows, failures };
};

export const formatLayoutTsv = (rows: readonly RectTransformRow[]): string =>
  [
    TSV_HEADER,
    ...rows.map((row) =>
      [
        row.path,
        row.active,
        row.anchorMin,
        row.anchorMax,
        row.pivot,
        row.anchoredPos,
        row.sizeDelta,
        row.scale,
        row.components,
      ]
        .map(cell)
        .join("\t"),
    ),
  ].join("\n") + "\n";

/** Unique CanvasScaler excerpts, eight lines of context, matching the verified grep. */
export const canvasScalerExcerpt = async (
  assetsRoot: string,
): Promise<string> => {
  const scenes = await walk(join(assetsRoot, "Scenes"), ".unity");
  const blocks = new Set<string>();
  for (const scene of scenes) {
    const lines = (await readFile(scene, "utf8")).split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!(lines[index] ?? "").includes("m_UiScaleMode")) continue;
      blocks.add(
        lines
          .slice(index, index + 9)
          .map((line) => line.trimEnd())
          .join("\n"),
      );
    }
  }
  return [...blocks].sort().join("\n");
};

export const sceneFiles = async (assetsRoot: string): Promise<string[]> => {
  const mobile = join(assetsRoot, "Scenes", "Mobile");
  const files = await walk(mobile, ".unity");
  if (files.length > 0) return files.sort();
  const all = await walk(join(assetsRoot, "Scenes"), ".unity");
  return all.sort((left, right) =>
    relative(assetsRoot, left).localeCompare(relative(assetsRoot, right)),
  );
};

export const sceneBaseName = (scenePath: string): string =>
  basename(scenePath).replace(/\.unity$/u, "");
