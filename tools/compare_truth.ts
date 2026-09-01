/**
 * Compare the TS generator's placements against Blender's evaluated instances
 * (tools/dump_truth.py output). Positions are aggregated per collection because the
 * JS hash differs from Blender's — variant picks and probability gates won't match,
 * but deterministic categories must match exactly in count and position set.
 *
 *   npx tsx tools/compare_truth.ts <truth.json>
 */
import { readFileSync } from "node:fs";
import { generateBuilding } from "../src/generator";
import type { BuildingParams } from "../src/params";

const truthPath = process.argv[2];
const truth = JSON.parse(readFileSync(truthPath, "utf8")) as {
  params: Record<string, number>;
  instances: { name: string; collections: string[]; matrix: number[][] }[];
};
const manifest = JSON.parse(
  readFileSync(new URL("../public/assets/kit_manifest.json", import.meta.url), "utf8"),
) as { collections: Record<string, { children?: { index: number; name: string }[] }> };

const p: BuildingParams = {
  floor: truth.params["floor"],
  length: truth.params["length"],
  width: truth.params["width"],
  acUnit: truth.params["AC UNIT"],
  roofProbability: truth.params["Roof Probability"],
  clothlineProbability: truth.params["Clothline Probability"],
  lights: truth.params["Lights"] ?? 0.546,
  windowType: truth.params["window type"],
  windowOpenAmount: truth.params["window open amount"],
  curtainClose: truth.params["curtain close"],
  closedOpenStore: truth.params["closed/open store"],
  roofOnStore: truth.params["roof on store"],
  objectOnGround: truth.params["object on ground"],
  storeSign: truth.params["store sign"],
  objectOnRoof: truth.params["object on roof"],
  randomise: truth.params["randomise"],
};

const counts = { count: (c: string) => manifest.collections[c]?.children?.length || 1 };
const mine = generateBuilding(p, counts);

// aggregate positions per collection
const round = (v: number) => Math.round(v * 100) / 100;
const posKey = (x: number, y: number, z: number) => `${round(x)},${round(y)},${round(z)}`;

// Cube.001 carries an object transform; recover the offset from the roofcorner
// centroid (4 corners → building center) so both sets share one origin
const rc = truth.instances.filter(i => i.collections.includes("roofcorner"));
const off = rc.length
  ? {
      x: rc.reduce((a, i) => a + i.matrix[0][3], 0) / rc.length,
      y: rc.reduce((a, i) => a + i.matrix[1][3], 0) / rc.length,
    }
  : { x: 0, y: 0 };
console.log(`(truth offset: ${off.x.toFixed(2)}, ${off.y.toFixed(2)})`);

const truthByCol = new Map<string, Map<string, number>>();
for (const inst of truth.instances) {
  // truth matrix rows: matrix[r][c], translation at [0][3],[1][3],[2][3]
  const key = posKey(inst.matrix[0][3] - off.x, inst.matrix[1][3] - off.y, inst.matrix[2][3]);
  for (const col of inst.collections.length ? inst.collections : ["<none:" + inst.name + ">"]) {
    let m = truthByCol.get(col);
    if (!m) truthByCol.set(col, (m = new Map()));
    m.set(key, (m.get(key) ?? 0) + 1);
  }
}

const mineByCol = new Map<string, Map<string, number>>();
for (const pl of mine) {
  const m = pl.key.match(/^COL\[(.+)\]\[\d+\]$/);
  const col = m ? m[1] : pl.key; // OBJ[...] kept as-is
  const e = pl.matrix.elements; // column-major: translation at 12,13,14
  const key = posKey(e[12], e[13], e[14]);
  let map = mineByCol.get(col);
  if (!map) mineByCol.set(col, (map = new Map()));
  map.set(key, (map.get(key) ?? 0) + 1);
}

const allCols = [...new Set([...truthByCol.keys(), ...mineByCol.keys()])].sort();
for (const col of allCols) {
  const t = truthByCol.get(col) ?? new Map<string, number>();
  const g = mineByCol.get(col) ?? new Map<string, number>();
  const tTotal = [...t.values()].reduce((a, b) => a + b, 0);
  const gTotal = [...g.values()].reduce((a, b) => a + b, 0);
  const onlyT = [...t.keys()].filter(k => !g.has(k));
  const onlyG = [...g.keys()].filter(k => !t.has(k));
  const status = onlyT.length === 0 && onlyG.length === 0 && tTotal === gTotal ? "OK " : "DIFF";
  console.log(`${status} ${col.padEnd(36)} truth=${tTotal} mine=${gTotal} posOnlyTruth=${onlyT.length} posOnlyMine=${onlyG.length}`);
  if (status === "DIFF") {
    if (onlyT.length) console.log(`   truth-only: ${onlyT.slice(0, 6).join("  ")}`);
    if (onlyG.length) console.log(`   mine-only:  ${onlyG.slice(0, 6).join("  ")}`);
  }
}
