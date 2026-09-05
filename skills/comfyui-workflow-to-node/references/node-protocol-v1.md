# vd-node pack protocol v1 — comfyui-workflow analysis reference

Use this reference when converting an API-format comfyui-workflow to a vd-node pack. Follow the [shared terminology](../../../docs/TERMINOLOGY.md). The full protocol is documented in [`../../../docs/custom-node-protocol.md`](../../../docs/custom-node-protocol.md), with its canonical JSON Schema at [`../../../schemas/video-director-node-v1.schema.json`](../../../schemas/video-director-node-v1.schema.json).

## Required pack shape

```json
{
  "protocol": "video-director.node/v1",
  "type": "local.example",
  "version": "0.1.0",
  "manifest": {
    "title": "Example",
    "category": "image",
    "inputs": [],
    "outputs": [{ "id": "image", "label": "Image", "types": ["image"] }],
    "fields": []
  },
  "implementation": {
    "kind": "comfyui.workflow",
    "operation": "image-generation",
    "workflow": {},
    "bindings": [],
    "output": "auto"
  }
}
```

`operation` is required. Choose exactly one:

- `image-generation`: produces images without requiring a source image.
- `image-edit`: produces images and requires a source image, sketch, or mask.
- `video-generation`: produces video, with or without reference media.
- `audio-generation`: produces audio without video as its primary output.

Do not infer operation from a marketing name. Use actual input/output topology and ask when it remains ambiguous.

## Inference rules

Treat only primitive ComfyUI inputs—strings, finite numbers, and booleans—as candidate fields. Arrays such as `["12", 0]` are graph links and must remain unchanged.

Common semantic field names:

| ComfyUI input or topology | Field id | Placement |
| --- | --- | --- |
| First positive text encoder / `prompt` | `prompt` | primary |
| Second text encoder / negative input | `negativePrompt` | advanced |
| `width`, `height` | same name | primary |
| `duration`, `seconds`, `length`, `frames` | normalized name | primary when users reason in that unit |
| `seed`, `noise_seed`, `random_seed` | `seed` | primary |
| `steps`, `cfg`, sampler, scheduler | normalized name | advanced |
| checkpoint, UNet, VAE, CLIP, LoRA filenames | generated stable id | advanced |
| filename prefix and codec controls | generated stable id | advanced |

For `LoadImage`-style inputs, prefer a typed input port over a string field. The first ordinary image is usually `image`; a mask loader is usually `mask`. This is heuristic: reference-only and multi-image workflows need human confirmation.

Infer output ports only from actual saving/preview topology such as `SaveImage`, `SaveVideo`, or `SaveAudio`. If a graph has several output media types, declare each one. `output: "auto"` tells the host to collect supported output descriptors; it does not make an absent save/output node appear.

## Binding checks

For every binding:

- the target comfyui-node ID exists inside `implementation.workflow` (it is not the canvas vd-node ID);
- the target input exists;
- the source field or port exists;
- no other binding uses the same target;
- source and target primitive/media types are compatible;
- graph links are never replaced by inferred scalar fields.

If one semantic field intentionally controls several ComfyUI inputs, use one field and several bindings. Conflicting original defaults are a warning that requires review.

For repeated values on a port that declares `multiple: true`, bind the zero-based position with `portIndex`. This index is local to that one port. New packs must not emit the deprecated `index` alias.

## Presentation checks

Every field declares `placement`. Primary is for the small common path, not a statement of importance. Advanced fields remain fully configurable and host-validated.

Do not add arbitrary React, HTML, CSS, scripts, expressions, provider ids, endpoint addresses, API keys, or an MCP/REST selector. Complex derived values such as an H3-specific frame grid require a reviewed host implementation or an explicit raw field in v1; do not invent an expression language.

## Safety and completion

The analyzer is deliberately offline and produces a draft. Before calling the result complete:

- confirm the workflow is API format and trusted;
- confirm model and ComfyUI custom-node package dependencies with the user;
- confirm operation, input roles, and output types;
- review all inferred primary fields;
- retain the workflow graph exactly except for deliberate user-approved corrections;
- validate against the schema;
- report unresolved warnings.

Generating a vd-node pack does not authorize installing ComfyUI custom-node packages, downloading models, submitting the comfyui-workflow, or mutating the user's Video Director registry.
