export interface SplitPiece {
  readonly index: number;
  readonly name: string;
}

export interface UnityDataMergePlan {
  readonly link: readonly string[];
  readonly groups: readonly {
    readonly base: string;
    readonly parts: readonly SplitPiece[];
  }[];
}

/** Group Unity `name.splitN` files and leave other file names to be linked. */
export const planUnityDataMerge = (
  names: readonly string[],
): UnityDataMergePlan => {
  const groups = new Map<string, SplitPiece[]>();
  const link: string[] = [];
  for (const name of names) {
    const match = /^(.*)\.split(\d+)$/u.exec(name);
    const base = match?.[1];
    const indexText = match?.[2];
    if (base === undefined || indexText === undefined || base.length === 0) {
      link.push(name);
      continue;
    }
    const pieces = groups.get(base) ?? [];
    pieces.push({ index: Number(indexText), name });
    groups.set(base, pieces);
  }
  return {
    link: [...link].sort(),
    groups: [...groups.entries()]
      .map(([base, parts]) => ({
        base,
        parts: [...parts].sort((left, right) => left.index - right.index),
      }))
      .sort((left, right) => left.base.localeCompare(right.base)),
  };
};

/** Contiguous split indexes starting at 0. */
export const splitSequenceError = (
  parts: readonly SplitPiece[],
): string | undefined => {
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]?.index !== index)
      return `split indexes must be contiguous from 0; missing .split${String(index)}`;
  }
  return undefined;
};
