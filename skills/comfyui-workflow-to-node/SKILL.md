---
name: comfyui-workflow-to-node
description: Convert a trusted comfyui-workflow JSON into a reusable registered comfyui-workflow or declarative vd-node pack (Video Director Custom Node v1), with exact bindings, live ComfyUI choices, and primary versus Advanced controls. Use for API graphs and for UI templates when matching ComfyUI object metadata is available; conversion does not authorize execution or installation.
---

# comfyui-workflow to vd-node

Create a reviewable registered comfyui-workflow or vd-node pack without submitting it to ComfyUI.

Use the [project terminology](../../docs/TERMINOLOGY.md): a **vd-node** belongs to the Video Director **vd-workflow**; a **comfyui-node** belongs to the backend **comfyui-workflow**. Conversion wraps the backend graph for use by a vd-node; it does not turn every comfyui-node into a canvas vd-node. A **vd-node pack** is declarative JSON, while a **ComfyUI custom-node package** is a server-side Python extension. Use the qualified source names from the terminology guide. Keep protocol strings, external class names, file paths, serialized keys, and IDs unchanged.

## Choose the output

- For a browser-importable vd-node pack (Custom Node v1), read [references/node-protocol-v1.md](references/node-protocol-v1.md) completely. The embedded comfyui-workflow must be API format.
- For a registered comfyui-workflow bundled by this repository, read [references/project-builtin-workflows.md](references/project-builtin-workflows.md) completely. Follow its catalog, parameter, discovery, migration, test, and live-verification conventions.

Accept only a comfyui-workflow the user trusts. A ComfyUI graph becomes executable configuration when submitted because installed ComfyUI custom-node packages are local code. Conversion alone does not authorize installing packages or models, submitting the graph, or generating media.

## Classify and compile the source

An API graph is keyed by comfyui-node ID and each entry contains `class_type` and `inputs`. Use it directly after review.

An editor/UI template has top-level `nodes` and `links`. It is a useful source template but cannot be sent directly to `/prompt`. Compile it to an API graph only when exact metadata from the matching ComfyUI deployment is available through `/object_info`:

1. Use the template's link table for every connected input and output slot.
2. Use each UI input's exact name plus `/object_info` `input_order` and schemas to map `widgets_values` to API input names.
3. Preserve primitive defaults, selected models, comfyui-node classes, derived-value comfyui-nodes, save/output comfyui-nodes, and graph topology. Drop only editor layout metadata.
4. Treat seed `control_after_generate` as Video Director instance state; it is not normally an API-node input.
5. Stop on missing node classes, unconsumed widget values, dependent dynamic widgets, or any ambiguous mapping. Ask for **Save (API Format)** rather than guessing.

When the user supplies an editor template specifically to replace parameters and submit through Video Director, explain that the compiled API graph is the transport form of that same template; do not reject it merely because its filename says `api.json`.

## vd-node pack draft

For an API-format portable pack, run the offline analyzer with an absolute source path and stable namespaced type:

```bash
node scripts/analyze-workflow.mjs /absolute/workflow.json \
  --type local.descriptive-name \
  --title "Descriptive Name" \
  --operation image-generation
```

Omit `--operation` only when topology makes it unambiguous. The analyzer writes the pack to stdout and warnings to stderr; it never executes, submits, installs, fetches, or rewrites the source.

Review every inferred port, binding, default, operation, and output. Resolve warnings instead of hiding them. Keep common creative controls in `primary`; put model files, sampler details, CFG, steps, schedulers, prefixes, and uncommon switches in `advanced`. Never expose credentials, endpoint addresses, transport selection, or local filesystem paths as fields.

Validate portable packs against [`../../schemas/video-director-node-v1.schema.json`](../../schemas/video-director-node-v1.schema.json). Return unresolved assumptions. Install or execute only when the user separately requests it.
