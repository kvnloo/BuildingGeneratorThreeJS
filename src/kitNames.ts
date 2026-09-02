/**
 * Placement keys are `COL[collection][index]` / `OBJ[name]`. Kit.count used to
 * return 1 for a missing collection (`|| 1`), so a typo'd mesh name compiled to
 * `COL[typo][0]` and vanished at instance time with only a console warning.
 */

export interface KitNameCollection {
  children?: { index: number; kind: string; name: string }[];
  missing?: boolean;
}

export interface KitNameManifest {
  collections: Record<string, KitNameCollection>;
  objects: Record<string, unknown>;
}

const COL_KEY = /^COL\[(.+)\]\[(\d+)\]$/;
const OBJ_KEY = /^OBJ\[(.+)\]$/;

export function collectionChildCount(manifest: KitNameManifest, name: string): number {
  const c = manifest.collections[name];
  const n = c?.children?.length ?? 0;
  if (!c || c.missing || n === 0) {
    throw new Error(`kit: unknown or empty collection ${JSON.stringify(name)}`);
  }
  return n;
}

export function assertKnownPlacementKey(key: string, manifest: KitNameManifest): void {
  const col = key.match(COL_KEY);
  if (col) {
    const n = collectionChildCount(manifest, col[1]);
    const idx = Number(col[2]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
      throw new Error(
        `kit: index ${idx} out of range for collection ${JSON.stringify(col[1])} (n=${n})`,
      );
    }
    return;
  }
  const obj = key.match(OBJ_KEY);
  if (obj) {
    if (!(obj[1] in manifest.objects)) {
      throw new Error(`kit: unknown object ${JSON.stringify(obj[1])}`);
    }
    return;
  }
  throw new Error(`kit: malformed placement key ${JSON.stringify(key)}`);
}
