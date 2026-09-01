# BuildingGeneratorThreeJS

A procedural Hong Kong building generator for Three.js, ported from a Blender
geometry-nodes setup (`procedural-hong-kong-building/source/procedural_building.blend`).
Original model URL : https://sketchfab.com/3d-models/procedural-hong-kong-building-528a732e84c44fd49c4726f341014a23

The original 592-node "build system" node group was reverse-engineered into a
TypeScript placement algorithm ([docs/BUILD_SYSTEM.md](docs/BUILD_SYSTEM.md)); the
~190 building parts (walls, windows, AC units, clotheslines, storefronts, roof props…)
are exported from the .blend into a single instanced asset kit
(`public/assets/kit.glb` + `kit_manifest.json`).

## Run

```sh
npm install
npm run dev
```

Live sliders cover the ported generator inputs (floors, footprint, AC / clothline /
lights probabilities, window type & open amount, curtains, store state, seed). The
Blender modifier also has deform and low-poly toggles; those are not in this port yet.

## Re-exporting the asset kit

If you edit assets in the .blend, re-run the export (Blender 4.2+):

```sh
blender --background procedural-hong-kong-building/source/procedural_building.blend \
        --python tools/export_kit.py -- public/assets/kit.glb public/assets/kit_manifest.json
```

## Structure

- `src/generator.ts` — the ported node graph: grids, seeded RNG, placements
- `src/kit.ts` — GLB kit loader + InstancedMesh builder
- `src/rng.ts` — Blender-style hash(id, seed) random values
- `src/main.ts` — scene, lighting, lil-gui controls
- `tools/` — Blender headless scripts (kit export, node-graph dump)
