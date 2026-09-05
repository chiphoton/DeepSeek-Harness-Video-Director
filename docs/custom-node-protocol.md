# vd-node pack protocol v1

vd-node packs use the declarative, versioned `video-director.node/v1` protocol, formerly called Video Director Custom Node Protocol v1. A pack declares typed ports, configurable fields, presentation placement, and a host-side implementation. The browser renders the declaration; it does not load node-provided React, HTML, CSS, credentials, or executable code.

Follow the [shared terminology](TERMINOLOGY.md): a **vd-node** is a canvas instance, a **vd-node definition** is its reusable declaration, and a **comfyui-node** belongs to the embedded **comfyui-workflow**. A **ComfyUI custom-node package** is a separately installed Python extension. Existing protocol identifiers remain unchanged.

The canonical machine-readable schema is [`schemas/video-director-node-v1.schema.json`](../schemas/video-director-node-v1.schema.json). See [`custom_nodes/comfyui-basic-image.manifest.json`](../custom_nodes/comfyui-basic-image.manifest.json) for a complete workflow-backed node.

## Host interface

The vd-node host inside the DSH Host is a deep module with three entry points:

```ts
interface DirectorNodeHost {
  install(pack: NodePack): Promise<{ type: string; version: string; digest: string }>
  describe(query?: { type?: string; version?: string }): readonly NodeDescriptor[]
  execute(
    request: NodeRunRequest,
    hooks?: { signal?: AbortSignal; onProgress?(event: RunProgress): void },
  ): Promise<NodeRunResult>
}
```

`install` validates and stores an immutable node version. `describe` returns a redacted, JSON-safe descriptor for the canvas and agents. `execute` validates typed inputs and field values, selects the appropriate host runtime, runs the node, and imports supported outputs into the current project.

Workflow graphs, host executors, provider credentials, and REST/MCP routing decisions are never returned by `describe`.

## vd-node pack

```ts
type NodePack = {
  protocol: 'video-director.node/v1'
  type: string
  version: string
  manifest: {
    title: string
    description?: string
    category: 'input' | 'text' | 'image' | 'audio' | 'video' | 'utility' | 'output'
    inputs: PortSpec[]
    outputs: PortSpec[]
    fields: FieldSpec[]
  }
  implementation: NodeImplementation
}
```

`type` is a stable, lowercase, namespaced identifier. Dotted notation such as `com.example.video-upscale` and package-style notation such as `com.example/video-upscale` are both valid. The first segment begins with a letter; later segments are alphanumeric with optional internal hyphens. A type contains at least one `.` or `/`, at most one `/`, and does not contain underscores, empty segments, or a trailing hyphen.

`version` is an exact SemVer 2 version without a range. Pre-release and build metadata are supported, for example `1.2.0-rc.1+cuda.12`. The full string—including build metadata—participates in the immutable `type + version` identity pinned by a project.

### Ports

```ts
type MediaType = 'text' | 'image' | 'audio' | 'video' | 'sketch' | 'mask'

type PortSpec = {
  id: string
  label: string
  types: MediaType[]
  required?: boolean
  multiple?: boolean
}
```

An edge is valid only when its source and target media type sets intersect. The host repeats this check during execution; client validation is advisory.

### Fields and Advanced placement

```ts
type FieldSpec = {
  id: string
  label: string
  schema:
    | { type: 'string'; enum?: string[]; minLength?: number; maxLength?: number }
    | { type: 'number'; min?: number; max?: number; step?: number; integer?: boolean }
    | { type: 'boolean' }
  default: string | number | boolean
  placement: 'primary' | 'advanced'
  control?: 'input' | 'textarea' | 'select' | 'slider' | 'checkbox'
  description?: string
}
```

`placement` is required. The generic canvas renderer shows `primary` fields on the node and places `advanced` fields inside a collapsed Advanced section. Keep the common creative controls primary—usually prompt, dimensions, duration, and seed—and put model filenames, sampler details, scheduler, CFG, steps, output prefixes, and uncommon switches in Advanced.

Presentation does not weaken validation: every field value is checked against its schema on the host.

### Instance parameter inputs

A project may expose an eligible text field as an input on one node instance without changing the immutable Custom Node definition. The project node stores a sparse mode map:

```ts
type FieldInputModes = Record<string, { mode: 'input' }>
```

The canonical dynamic port id is `field:<fieldId>`. In protocol v1, only string fields can be converted; number and boolean fields remain local controls until the media/type system has explicit scalar types. The built-in Prompt control—and Negative prompt when the selected execution path actually supports it—are treated as string fields for generic nodes.

Right-click a node and choose **Parameter inputs** to enable or disable eligible fields. Enabling a field retains its local value as a fallback. A connected upstream text value overrides that fallback only in the immutable run snapshot; it does not rewrite the saved field. Disabling the mode removes edges targeting that dynamic port in the same undoable graph edit.

The Host derives the eligible fields from the pinned node definition or selected workflow and does not trust the browser's mode map. It rejects unknown fields, non-string fields, multiple connections to a single-value field, and connected values that are not text. For image, audio, video, sketch, and mask inputs, declare ordinary typed `PortSpec` entries and bind each one to a real workflow input. A generic Reference port is never inferred when the workflow has no corresponding asset or mask binding.

## comfyui-workflow implementation

```ts
type ComfyWorkflowImplementation = {
  kind: 'comfyui.workflow'
  operation:
    | 'image-generation'
    | 'image-edit'
    | 'video-generation'
    | 'audio-generation'
  workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  bindings: WorkflowBinding[]
  output: 'auto'
}
```

`operation` is mandatory and security-relevant. The host uses it to enforce compatible inputs, licensing rules, output policy, and runtime routing. It must describe the actual workflow rather than the node's visual category.

The comfyui-workflow must be ComfyUI API format: an object keyed by comfyui-node ID. Editor/UI JSON containing `nodes`, `links`, and layout metadata is not executable by this protocol. Export **Save (API Format)** from ComfyUI first.

```ts
type WorkflowBinding = {
  target: { nodeId: string; input: string }
  source:
    | { kind: 'field'; fieldId: string }
    | { kind: 'port'; portId: string; portIndex?: number }
    | { kind: 'runtime'; value: 'seed' | 'projectId' }
    | { kind: 'literal'; value: unknown }
}
```

`target.nodeId` identifies a comfyui-node inside `implementation.workflow`. A job request's `nodeId` instead identifies the canvas vd-node. A binding's `fieldId` or `portId` refers to the vd-node definition; it connects these two layers without making a canvas vd-edge part of the comfyui-workflow.

The host deep-clones the registered comfyui-workflow for every execution, applies each binding once, uploads incoming assets as required, and then submits the compiled graph. A target may occur in only one binding.

`portIndex` is the zero-based position within one logical port, not an index in the node's combined media input list. It defaults to `0`; values above `0` require that port to declare `multiple: true`. Hosts accept the legacy `index` spelling when importing an older v1 pack, but always persist and expose `portIndex`.

ComfyUI REST and ComfyUI MCP are internal adapters at the same runtime seam. A node must not expose either choice. Users provide one ComfyUI address; the host or agent selects a viable route, records it in job diagnostics, and avoids fallback when submission state is unknown.

## Immutable execution snapshot

Running a node is independent from saving the Video Project. At click time, the browser captures only the executable node fields and resolved connected inputs—not the whole graph—and sends them in one `jobs/start` request with a unique `clientRunId`, source project revision, and pinned node type/version/digest. The Host bounds and JSON-deep-clones the snapshot before any asynchronous work, then revalidates the definition, field schema, typed ports, workflow, provider policy, and project-owned assets.

The full execution request remains in the in-memory Job and is never written into the saved project graph. Persisted Job records contain only status, output, hashes, and safe provenance. This allows a newly created or edited node to run without an implicit project save while preserving three invariants: later canvas edits cannot mutate the queued request, the result merges only runtime/output fields into the current node, and a superseded or deleted node cannot be restored by a late completion.

## Preview and Save

`core.preview@1` is a built-in pass-through node accepting text, image, audio, or video. Its client implementation selects the matching safe renderer and returns the same value from its output port, allowing:

```text
Generate Video -> Preview -> Save
```

`core.save@1` is a trusted host node. Generated media is already imported into the project asset store so it can be previewed. Save therefore names and pins the immutable asset and exposes an explicit download action; it does not download or duplicate the same large media again. Saving the same source with the same name is idempotent.

Declarative JSON packs may use `client` only for the reserved `preview` behavior. Arbitrary host executors are accepted only from trusted, installed DSH plugins and are intentionally outside the JSON schema.

## Invariants

- `type + version` is immutable. Reinstalling the same digest is idempotent; different content at the same version is a version conflict.
- Port ids and field ids are unique within their lists and remain stable across compatible revisions.
- A field default and every runtime value match the declared schema.
- Every binding references an existing field or input port and an existing ComfyUI node/input.
- A workflow target is bound at most once.
- The registered workflow is never mutated during a run.
- A project stores only node type, exact version, values, edges, and immutable asset references—not workflow graphs, transport choices, or secrets.
- Outputs are text or immutable assets belonging to the current project and using a supported MIME type.
- Browser imports are declarative only. A ComfyUI workflow is still executable configuration because installed ComfyUI Custom Nodes are local code; import only trusted graphs.
- License and model-specific constraints are enforced by the host implementation, never by UI hints alone.
- If an MCP submission may have reached ComfyUI but returned no reliable prompt id, execution stops with `SUBMISSION_STATE_UNKNOWN`; the host does not submit a duplicate through REST.

## Error codes

Host errors use stable codes and may include a safe `path`, `nodeType`, `retryable`, and redacted details:

- `NODE_PROTOCOL_UNSUPPORTED`
- `NODE_DEFINITION_INVALID`
- `NODE_VERSION_CONFLICT`
- `NODE_VERSION_NOT_FOUND`
- `PORT_TYPE_MISMATCH`
- `FIELD_VALUE_INVALID`
- `WORKFLOW_BINDING_INVALID`
- `WORKFLOW_NOT_TRUSTED`
- `TRANSPORT_UNAVAILABLE`
- `SUBMISSION_STATE_UNKNOWN`
- `OUTPUT_TYPE_UNSUPPORTED`
- `ASSET_SAVE_FAILED`
- `NODE_EXECUTION_FAILED`

## Agent-generated packs

The repository skill at [`skills/comfyui-workflow-to-node`](../skills/comfyui-workflow-to-node/SKILL.md) performs offline analysis of a trusted API-format workflow for portable packs. It can also compile a trusted editor template into an API graph for a project built-in when exact metadata from the matching ComfyUI `/object_info` is available. Conversion never authorizes submission, execution, installation, or model downloads. An agent must review ambiguous mappings, prompt polarity, media roles, output detection, operation, defaults, and primary/advanced placement before presenting the result as ready.
