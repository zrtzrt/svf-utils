# Fork branch layout

Personal fork of [sensat/svf-utils](https://github.com/sensat/svf-utils), which is itself a fork of
[wallabyway/forge-extract](https://github.com/wallabyway/forge-extract).

Upstream `svf-utils` **8.0.0 removed SVF2 support** (*"Removed support for SVF2 as requested by APS
leadership"*), and the original repository (`petrbroz/svf-utils`) no longer exists.

## Branches

| Branch | Base | Contents |
| --- | --- | --- |
| **`main`** *(default)* | `73f4218` (7.0.0) | The full feature set, **minus SVF2**: `MergingGLTFWriter` (consolidated single-file GLB), polyline bounds parsing, the Draco compression tool, an end-to-end APS sample and a web viewer. This is the branch to use. |
| `feat/svf2` | `main` | `main` plus the SVF2 module (SVF2 download + parse) and the property-database resilience fix. Use only if you need SVF2. |
| `develop` | `sensat/develop` | Upstream mirror (5.0.3 + polyline support). Kept for diffing and future upstream syncs. |
| `contrib/merging-writer` | `61aedc3` (sensat) | The compliant subset rebased directly onto `sensat/develop` - the head of upstream PR [#3](https://github.com/sensat/svf-utils/pull/3). |
| `feat/merging-gltf-writer` | `73f4218` (7.0.0) | Superseded by `main` (historical: the same content before SVF2 was stripped and before the branch was promoted). |

`main` and `feat/merging-gltf-writer` both start at commit `73f4218`, which is 63 commits ahead of
`develop` and shares the 5.0.3 merge commit `9d9a042` with it as the common ancestor.

`feat/svf2` is built directly on top of `main`, so its diff against `main` is exactly the SVF2 module
plus that one fix.

## Why SVF2 is not on `main`

Under the Autodesk Platform Services terms, SVF2 assets may only be streamed from Autodesk servers.
Downloading, converting or redistributing them is not permitted - which is why upstream removed the
module. `main` therefore ships without it (and without the `svf2-to-gltf` binary, the SVF2 samples,
and the `ws`/`zod` dependencies that only SVF2 used).

The compliant path is SVF (v1), and that is what `main` is built on.

## Upstream pull request

[`sensat/svf-utils#3`](https://github.com/sensat/svf-utils/pull/3) proposes `MergingGLTFWriter`,
`samples/viewer.html` and docs (`contrib/merging-writer` → `develop`).

Deliberately kept out of that PR:

- the SVF2 module (non-compliant, see above);
- `tools/draco-compress.js` and the four packages it needs - the upstream README states the project
  intentionally has no post-processing dependencies and leaves that to external tools;
- polyline bounds handling - `sensat/develop` already carries polyline support (`02d9d60`).
