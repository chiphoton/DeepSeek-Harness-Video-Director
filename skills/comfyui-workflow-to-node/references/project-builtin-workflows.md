# Project built-in registered comfyui-workflows

Use this reference when a user wants a ComfyUI template maintained as a built-in registered comfyui-workflow in this repository rather than returned as a portable vd-node pack. Per the [shared terminology](../../../docs/TERMINOLOGY.md), this entry is selected by a vd-node inside a vd-workflow; the entry itself is a backend graph, not the full canvas orchestration.

## Repository representation

A built-in workflow has two coordinated parts:

- `custom_nodes/<name>.node.json` contains reviewed `nodeData` defaults, an API-format `workflow`, semantic `bindings`, and exposed `parameters`.
- `src/workflow-store.js` registers its stable internal id, display name, operation kind, and file in `BUILTIN_DOCUMENTS`.

The Host clones the API graph for every run, applies parameter values, then applies runtime bindings. Do not store editor `nodes`, `links`, positions, endpoint addresses, credentials, or provider transport choices in the built-in document.

## Compiling an editor template

Use the user's editor/UI JSON as the source of truth for topology and defaults. Read the matching ComfyUI `/object_info` before converting it.

- Build a link-id lookup from top-level `links`. A connected UI input becomes `["sourceNodeId", outputSlot]` under its exact UI input name.
- Map remaining `widgets_values` in `/object_info` input order. Distinguish primitive or selector widgets from graph-typed inputs. Connected widget inputs still consume their saved widget value even though the API input uses the link.
- Preserve exact comfyui-node class names and dynamic input names such as `values.a`.
- A seed node may save an extra `randomize`, `increment`, `decrement`, or `fixed` widget after the numeric seed. Store that as `nodeData.seedControlAfterGenerate`; submit only the numeric seed to the ComfyUI node.
- Preserve derived controls as graph topology. For example, bind a user-facing duration to the source `PrimitiveFloat` and keep the template's math-expression node linked to the generated frame count.
- Keep the actual output node (`SaveImage`, `SaveAudioAdvanced`, video saver, and so on) and its supported output connection. Do not replace it merely to match an older preset.

Fail closed if `/object_info` does not contain a referenced class/input or widget consumption is ambiguous. Request a ComfyUI **Save (API Format)** export at that point.

## Defaults and bindings

Put execution-policy values used outside the graph in `nodeData`: `prompt`, `modelFamily`, `seed`, dimensions, duration, fps, variant, steps, scheduler, and `seedControlAfterGenerate` as applicable.

Use semantic bindings for values Video Director owns at run time:

- Prompt text binds to the real prompt input.
- Seed binds to the actual `seed` or `noise_seed` input.
- Duration binds to the template's user-facing seconds input; do not bypass a supplied duration-to-frame conversion subgraph.
- Width and height may be literal bindings when the workflow requires fixed disposable dimensions.
- Sampling steps bind to the sampler or scheduler input when they are a standard Video Director control.
- Media bindings name stable ports and `portIndex`; never infer media from canvas position.

Each target should have one source of truth. Prefer a semantic binding for standard runtime values and a workflow parameter for deployment-specific selectors.

## Control placement

Follow the user's requested layout; these are the project defaults when unspecified:

- Prompt stays on the normal node surface.
- Duration and output format are primary controls directly below Prompt for audio workflows.
- Seed and Control after generate belong together in Advanced.
- Model loaders and sampling controls belong in Advanced.
- Keep related controls in one group: for example LoRA model beside LoRA strength, and all loader selections under Models unless the user requests finer groups.
- When a workflow kind has exactly one built-in option, select it automatically and omit a synthetic `Select workflow` item. Do not append `· built-in` when the requested display label must be exact.

`nodeData.parameters` use exact comfyui-node/input targets; their `nodeId` is distinct from a canvas vd-node ID. Use `control: "input"` without static `choices` for selectors whose inventory comes from ComfyUI; the client will render a select when live choices exist and preserve the workflow default when it is temporarily unavailable.

## Live ComfyUI choices

Dynamic choices flow through:

1. `ComfyWorkflowStore.modelParameters()` maps a parameter target to its ComfyUI node class and input.
2. `ProviderRuntime` reads `/object_info`.
3. RPC exposes only the exact intersection for that workflow parameter.
4. The client uses that per-parameter list; it must not mix values from unrelated loaders.

Support only reviewed `/object_info` selector shapes. Current important forms are:

- ordinary enum: `[["a.safetensors", "b.safetensors"]]`;
- dynamic combo: `["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "flac"}, {"key": "mp3"}]}]`.

If a new schema shape is required, add the narrow parser support and a provider regression test. Never copy the current machine's model or format inventory into static manifest choices.

## Compatibility and migration

Keeping the same built-in id updates the graph and catalog while preserving values already saved on existing nodes; newly created nodes receive the new defaults. This is normally the safest behavior.

Change the internal id only when the user explicitly wants a replacement migration that should reinitialize existing nodes. Test sole-workflow auto-selection and missing-id cleanup if doing so.

## Verification

Add focused tests before relying on visual inspection:

- `test/workflow-store.test.js`: display name, defaults, ordered parameters/groups, exact bindings, resolved graph values, and model-parameter targets;
- `test/providers.test.js`: any newly supported `/object_info` selector schema;
- controller/client tests when selection, defaulting, or placement logic changes.

Run `pnpm run check`.

Built-ins are loaded once when `ComfyWorkflowStore.init()` runs and the client is served from `lib/client.js`. After building, restart the local Harness Host. Verify in a hidden fresh browser tab against the configured ComfyUI: exact workflow options, primary fields, Advanced count/groups, and live choices. Do not refresh the user's active tab when it has unsaved canvas changes; tell the user to save before refreshing.

Do not submit the workflow or generate media as part of conversion validation unless the user explicitly asks for a run. Structural validation, `/object_info`, tests, and a fresh UI tab are sufficient for the conversion task.
