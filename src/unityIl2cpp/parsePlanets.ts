import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { asNumber, asString, jsonSafe, parseRelaxedJson } from "./jsonText.js";

export interface PlanetTableRow {
  readonly name: string;
  readonly file: string;
  readonly radius: number | null;
  readonly gravity: number | null;
  readonly gravity_difficulty_scale: number | null;
  readonly radius_difficulty_scale: number | null;
  readonly timewarp_height: number | null;
  readonly atmosphere_height: number | null;
  readonly atmosphere_density: number | null;
  readonly atmosphere_curve: unknown;
  readonly parachute_multiplier: number | null;
  readonly upper_atmosphere: number | null;
  readonly heating_velocity_multiplier: number | null;
  readonly parent: string | null;
  readonly semi_major_axis: number | null;
  readonly eccentricity: number | null;
  readonly argument_of_periapsis: number | null;
  readonly multiplier_soi: number | null;
  readonly sma_difficulty_scale: number | null;
  /** Laplace approximation. Null when the parent body was not in this extract. */
  readonly soi_estimate: number | null;
  readonly soi_estimate_basis: "inference_laplace_0_4" | null;
}

export interface PlanetParse {
  readonly bodies: Readonly<Record<string, unknown>>;
  readonly table: readonly PlanetTableRow[];
  readonly failures: readonly {
    readonly path: string;
    readonly reason: string;
  }[];
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read planet_data-style TextAssets into an observed body map and a derived table. */
export const parsePlanetTextAssets = async (
  directory: string,
): Promise<PlanetParse> => {
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".txt"),
  );
  names.sort();
  const bodies: Record<string, unknown> = {};
  const sources: {
    name: string;
    file: string;
    body: Record<string, unknown>;
  }[] = [];
  const failures: { path: string; reason: string }[] = [];
  for (const name of names) {
    const path = join(directory, name);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      failures.push({
        path: name,
        reason: cause instanceof Error ? cause.message : "unreadable",
      });
      continue;
    }
    if (!text.includes('"BASE_DATA"')) continue;
    try {
      const parsed = jsonSafe(parseRelaxedJson(text));
      const body = record(parsed);
      const base = record(body?.BASE_DATA);
      if (body === undefined || base === undefined)
        throw new Error("BASE_DATA is not an object");
      const planet = basename(name).split("__")[0] ?? basename(name);
      bodies[planet] = body;
      sources.push({ name: planet, file: name, body });
    } catch (cause) {
      failures.push({
        path: name,
        reason: cause instanceof Error ? cause.message : "JSON parse failed",
      });
    }
  }
  const mu = new Map<string, number>();
  for (const source of sources) {
    const base = record(source.body.BASE_DATA);
    const gravity = asNumber(base?.gravity);
    const radius = asNumber(base?.radius);
    if (gravity !== null && radius !== null)
      mu.set(source.name, gravity * radius ** 2);
  }
  const table = sources.map((source): PlanetTableRow => {
    const base = record(source.body.BASE_DATA) ?? {};
    const atmosphere = record(source.body.ATMOSPHERE_PHYSICS_DATA) ?? {};
    const orbit = record(source.body.ORBIT_DATA) ?? {};
    const parent = asString(orbit.parent);
    const selfMu = mu.get(source.name);
    const parentMu = parent === null ? undefined : mu.get(parent);
    const semiMajor = asNumber(orbit.semiMajorAxis);
    const multiplier = asNumber(orbit.multiplierSOI);
    const estimated =
      parent !== null &&
      selfMu !== undefined &&
      parentMu !== undefined &&
      parentMu !== 0 &&
      semiMajor !== null
        ? semiMajor * (selfMu / parentMu) ** 0.4 * (multiplier ?? 1)
        : null;
    return {
      name: source.name,
      file: source.file,
      radius: asNumber(base.radius),
      gravity: asNumber(base.gravity),
      gravity_difficulty_scale: asNumber(base.gravityDifficultyScale),
      radius_difficulty_scale: asNumber(base.radiusDifficultyScale),
      timewarp_height: asNumber(base.timewarpHeight),
      atmosphere_height: asNumber(atmosphere.height),
      atmosphere_density: asNumber(atmosphere.density),
      atmosphere_curve: atmosphere.curve ?? null,
      parachute_multiplier: asNumber(atmosphere.parachuteMultiplier),
      upper_atmosphere: asNumber(atmosphere.upperAtmosphere),
      heating_velocity_multiplier: asNumber(
        atmosphere.startHeatingVelocityMultiplier,
      ),
      parent,
      semi_major_axis: semiMajor,
      eccentricity: asNumber(orbit.eccentricity),
      argument_of_periapsis: asNumber(orbit.argumentOfPeriapsis),
      multiplier_soi: multiplier,
      sma_difficulty_scale: asNumber(orbit.smaDifficultyScale),
      soi_estimate: estimated,
      soi_estimate_basis: estimated === null ? null : "inference_laplace_0_4",
    };
  });
  return { bodies, table, failures };
};
