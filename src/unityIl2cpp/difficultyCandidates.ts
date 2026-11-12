export interface DifficultyCandidate {
  readonly offset: number;
  readonly values: readonly [number, number, number];
}

/**
 * Unlabeled 3-element little-endian doubles that start at 1.0.
 * The field each array belongs to is unknown. This does not map them.
 */
export const scanDifficultyCandidates = (
  bytes: Buffer,
): readonly DifficultyCandidate[] => {
  const marker = Buffer.alloc(8);
  marker.writeDoubleLE(1);
  const found: DifficultyCandidate[] = [];
  let offset = 0;
  while (offset <= bytes.length - 24) {
    const index = bytes.indexOf(marker, offset);
    if (index < 0 || index + 24 > bytes.length) break;
    const values = [0, 1, 2].map((slot) =>
      bytes.readDoubleLE(index + slot * 8),
    ) as [number, number, number];
    const distinct =
      values[0] === 1 &&
      values.every((value) => value > 0.01 && value < 1000) &&
      !(values[1] === 1 && values[2] === 1);
    if (distinct) found.push({ offset: index, values });
    offset = index + 1;
  }
  return found;
};

export const formatDifficultyCandidates = (
  candidates: readonly DifficultyCandidate[],
): string => {
  const header = [
    "# Candidate 3-element little-endian double arrays whose first value is 1.0.",
    "# Field-name mapping is unknown. This file does not infer which Difficulty field an array belongs to.",
    "# Obfuscated IL is not disassembled for this table.",
  ];
  const rows = candidates.map(
    (candidate) =>
      `0x${candidate.offset.toString(16)} ${candidate.values.join(" ")}`,
  );
  return [...header, ...rows, ""].join("\n");
};
