import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertKnownPlacementKey, collectionChildCount } from "../src/kitNames";
import type { KitNameManifest } from "../src/kitNames";

const manifest = JSON.parse(
  readFileSync(new URL("../public/assets/kit_manifest.json", import.meta.url), "utf8"),
) as KitNameManifest;
const generatorSrc = readFileSync(new URL("../src/generator.ts", import.meta.url), "utf8");

test("collectionChildCount throws on a typo'd mesh name (the old || 1 hole)", () => {
  assert.throws(
    () => collectionChildCount(manifest, "ground side wall"),
    /unknown or empty collection "ground side wall"/,
  );
});

test("collectionChildCount accepts live Blender collection names", () => {
  assert.equal(collectionChildCount(manifest, "groud side wall"), 1);
  assert.ok(collectionChildCount(manifest, "wall.001") > 1);
});

test("every COL() / OBJ() name in generator.ts exists in kit_manifest.json", () => {
  const cols = new Set(
    [...generatorSrc.matchAll(/COL\(\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  for (const m of generatorSrc.matchAll(/`COL\[([^\]]+)\]\[/g)) {
    if (!m[1].includes("${")) cols.add(m[1]);
  }
  const objs = new Set(
    [...generatorSrc.matchAll(/OBJ\(\s*"([^"]+)"/g)].map((m) => m[1]),
  );
  const missingCols = [...cols].filter((n) => {
    try {
      collectionChildCount(manifest, n);
      return false;
    } catch {
      return true;
    }
  });
  const missingObjs = [...objs].filter((n) => !(n in manifest.objects));
  assert.deepEqual(missingCols, []);
  assert.deepEqual(missingObjs, []);
});

test("assertKnownPlacementKey pin: in-range COL and known OBJ pass; OOB / unknown fail", () => {
  assertKnownPlacementKey("COL[wall.001][0]", manifest);
  assertKnownPlacementKey("OBJ[store_roof]", manifest);
  assert.throws(() => assertKnownPlacementKey("COL[wall.001][99999]", manifest), /out of range/);
  assert.throws(() => assertKnownPlacementKey("COL[not-a-mesh][0]", manifest), /unknown or empty/);
  assert.throws(() => assertKnownPlacementKey("OBJ[nope]", manifest), /unknown object/);
  assert.throws(() => assertKnownPlacementKey("lights.001", manifest), /malformed/);
});
