# Fork branch layout

Personal fork of [sensat/svf-utils](https://github.com/sensat/svf-utils), which is itself a fork of
[wallabyway/forge-extract](https://github.com/wallabyway/forge-extract).

Upstream `svf-utils` **8.0.0 removed SVF2 support** (*"Removed support for SVF2 as requested by APS
leadership"*), and the original repository (`petrbroz/svf-utils`) no longer exists. This fork keeps
the SVF2 line and the consolidated-writer work available.

## Branches

| Branch | Base | Contents |
| --- | --- | --- |
| `develop` | `sensat/develop` | Unmodified baseline (5.0.3 + polyline support). **No SVF2.** |
| `feat/svf2` | `73f4218` (7.0.0) | The 7.0.0 line, which still contains the SVF2 module, plus a fix so that models translated without a property database download correctly. |
| `feat/merging-gltf-writer` | `73f4218` (7.0.0) | `MergingGLTFWriter` (merged single-file GLB), polyline bounds parsing, a Draco compression tool, an end-to-end APS sample and a web viewer. |
| `contrib/merging-writer` | `61aedc3` (sensat) | The compliant subset, rebased directly onto `sensat/develop` for upstream consideration: `MergingGLTFWriter` + `samples/viewer.html` + README only. No new dependencies, no SVF2, no Draco tool. |

Both `feat/*` branches start at commit `73f4218`, which is 63 commits ahead of `develop` and shares
the 5.0.3 merge commit `9d9a042` with it as the common ancestor.

## Upstream pull request

[`sensat/svf-utils#3`](https://github.com/sensat/svf-utils/pull/3) proposes `MergingGLTFWriter`,
`samples/viewer.html` and docs (`contrib/merging-writer` → `develop`).

Deliberately kept out of that PR:

- the SVF2 module (non-compliant, see below);
- `tools/draco-compress.js` and the four packages it needs - the upstream README states the project
  intentionally has no post-processing dependencies and leaves that to external tools;
- polyline bounds handling - `sensat/develop` already carries polyline support (`02d9d60`).


## Why SVF2 lives on its own branch

Under the Autodesk Platform Services terms, SVF2 assets may only be streamed from Autodesk servers.
Downloading, converting or redistributing them is not permitted - that is why upstream removed the
module and why `develop` does not contain it. Keep this in mind before using `feat/svf2`.

The compliant path is SVF (v1); the pipeline in `feat/merging-gltf-writer` is built on it.
