# DeepSeek-Harness Video-Director — Developer Guide

[简体中文](./DEVELOP_zh.md) · [Project README](../README.md) · [Terminology](TERMINOLOGY.md)

`dsh-video-director` is an external [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin for project-scoped video direction. It adds an infinite vd-node canvas, a DeepSeek conversation bound to the selected Video Project, multimodal asset ingestion, and provider-backed text, image, audio, and video generation vd-nodes.

Use the [shared terminology](TERMINOLOGY.md): the canvas orchestration is a **vd-workflow**; the backend graph selected by a ComfyUI-backed **vd-node** is a **comfyui-workflow** containing **comfyui-nodes**. The guide also maps existing code identifiers and UI labels to these terms.

This is an early functional implementation, not a hosted generation service. You supply and operate Ollama, OpenAI-compatible endpoints, and/or ComfyUI. MiniMax H3 weights are separately licensed; this plugin accepts the license gate by default, and deployments can explicitly disable it.

## What it provides

- A compact project switcher with create, rename/delete, Undo/Redo, plus explicit **Run**, **Jobs**, **Settings**, and **Save** actions. Run supports the whole graph, selected nodes, or selected nodes plus their descendants, with batches from 1–20. The Jobs drawer groups graph runs while retaining individual node jobs. The always-front horizontal canvas toolbar lives at bottom-right and includes selection, panning, zoom, fit, and Mini Map visibility controls.
- A left-side conversation whose `sessionId` changes with the selected Video Project and shares that Session's model directory. Images and audio can be pasted or dropped directly into the composer or selected from the **+** multimodal menu. PNG, JPEG, WebP, and GIF images are sent as native image prompt blocks; audio is transcribed through a selected OpenAI-compatible provider and inserted into the composer. Input settings cover Enter-vs-Alt+Enter behavior plus the speech provider, non-echoed API key, and transcription model, while a microphone button records speech for transcription.
- An infinite `@xyflow/react` canvas with load nodes for text, image, audio, video, and sketches. Existing sketches reopen in the drawing editor when clicked. The wheel zooms; double-clicking blank canvas opens a searchable node menu at that point; Select (V) pans empty space and selects/moves nodes; Hand (H) pans over both nodes and controls. Space temporarily activates Hand. Ctrl-drag selects a group in either mode, Ctrl-click toggles membership, and Ctrl+B toggles the selected nodes’ Freeze state as one undoable edit. A canvas-owned pointer gesture keeps Ctrl selection working even after an input had keyboard focus. Scrollable fields/panels own their wheel events; all other node regions zoom. Dragging an output onto blank canvas opens a menu filtered to nodes with a compatible input; choosing one creates it at the release point and connects it. Right-clicking the menu, clicking elsewhere, or pressing Esc cancels the pending connection. Right-clicking empty space opens the node catalog, Reset VRAM, and Paste menu. Right-clicking a node background opens Run/Cancel, Copy, Duplicate, masked-copy, Rename, Details, and Delete actions while input regions keep native context menus. The per-project canvas clipboard snapshots copied nodes and internal edges, remaps IDs on paste, and clears executable runtime results. Paste places the group at the cursor and remains one undoable edit.
- Workflow nodes for prompt enhancement, image generation, MiniMax H3 video, and H3 audio.
- Project assets served by private immutable URLs, including byte ranges for audio/video seeking.
- Optimistic project revisions so a stale browser cannot silently overwrite a newer edit.
- Dependency-aware graph scheduling from an immutable canvas snapshot. Local input/sink nodes are folded out of the execution plan, independent remote nodes share a stage, downstream nodes wait for upstream results, and cycles fail before submission.
- One configurable **VRAM Trigger** utility with Skip, Ollama eject, and ComfyUI unload/cache-clear actions. Its first incoming connection selects the matching local provider once, its eject button runs a manual test, and its ComfyUI release-model wait defaults to 10 seconds. Text, image, audio, and video workflows have no automatic generation deadline; they continue until completion, a provider error, or explicit cancellation.
- Persisted grouped job records, graph/node cancellation, retry, exact ComfyUI `prompt_id` tracking, and conservative restart recovery.
- Ollama, OpenAI-compatible, and one logical ComfyUI provider: enter one `IP:port`, while the Host chooses REST or MCP internally for each run.
- A named ComfyUI Workflow Registry: import API-format image generation, image edit, video, or audio workflows and select them from nodes instead of treating model ids as ComfyUI workflows.
- Built-in **Preview** and **Save** sink nodes for text, image, audio, and video outputs.
- An immutable, declarative [vd-node pack protocol](./custom-node-protocol.md) with typed ports plus compact `primary` and collapsed `Advanced` fields.
- A bundled [`comfyui-workflow-to-node` skill](../skills/comfyui-workflow-to-node/SKILL.md) that converts trusted ComfyUI API graphs—or editor templates with matching `/object_info`—into reusable registered comfyui-workflows or vd-node pack drafts.

Mask, trim, crop, resize, and sketch data can be represented on the canvas. In this version they become effective generation inputs only when a compatible preprocessing or ComfyUI workflow consumes the derived asset or metadata; Video Director does not yet ship a complete non-destructive media editor.

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- pnpm `11.7.0`
- A built DeepSeek Harness checkout or installed `dsh` CLI
- For local generation, a separately configured Ollama and/or ComfyUI installation
- For the optional Codex Plan text/image provider, a local Codex sign-in; image workflows additionally require image generation on the account
- For H3 Turbo, the required H3 nodes/models plus [`ComfyUI-MiniMax-H3-Turbo`](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo)

## Build and install

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The build creates `lib/client.js` as the lazy-CJS factory expected by the native DSH client module system. React, Cordis, and DSH client services remain shared module-table imports; `@xyflow/react` is bundled into the plugin. CSS is bundled as text because the App owns its `<style>` lifecycle.

With this repository beside a source checkout named `deepseek-harness`, install it into a dedicated profile:

```sh
cd ../deepseek-harness
pnpm dsh plugin --profile video-director add ../DeepSeek-Harness-Video-Director
pnpm dsh --profile video-director --dump-config
```

The dump should include the `dsh-video-director` layer and `video-director` row. For the Web UI:

```sh
cd ../deepseek-harness
pnpm dsh plugin --profile web add ../DeepSeek-Harness-Video-Director
pnpm dsh web
```

[`cordis.patch.yml`](../cordis.patch.yml) is the installable bundle patch. Its main row activates the plugin and exposes Ollama, OpenAI-compatible, Codex Plan, and one logical `comfyui` provider. The optional, disabled `video-director-comfyui-mcp` row installs a Host-side transport for automatic routing; it is not a second provider for users to configure or select. Review its package execution and network security before enabling it.

## Configuration and architecture

| Host field | Purpose |
|---|---|
| `dataDir` | Project JSON, immutable asset bytes, and the asset index. |
| `maxAssetBytes` | Maximum decoded size of one uploaded asset; defaults to and cannot exceed 200 MiB. |
| `jobConcurrency` | Maximum jobs executed by this plugin process. |
| `minimaxH3LicenseAccepted` | MiniMax H3 deployment gate; defaults to `true`, while an explicit `false` keeps H3 locked. |
| `providers` | Named Ollama, OpenAI-compatible, Codex Plan, and logical ComfyUI backends. |

The 200 MiB hard limit leaves room below Harness's 300 MiB custom-channel request cap: binary uploads expand to roughly 4/3 of their original size when encoded as base64, with additional JSON envelope overhead.

Keep credentials in Harness-managed configuration or environment variables. The sample patch reads `OPENAI_API_KEY` and currently selects `gpt-5.6-terra` plus `gpt-image-2`; change those ids to capabilities actually offered by your compatible endpoint. Provider overrides can also be edited in the right-side **Settings → Connections** drawer; secrets are stored through native DSH settings and are never echoed back to the browser. For ComfyUI, entering `127.0.0.1:8188` is enough—the Host normalizes it to an HTTP URL, and REST/MCP details stay out of projects and canvas nodes. A Video Project stores only provider ids and workflow/node references with their values.

The Codex Plan provider uses the official [`@openai/codex-sdk`](https://developers.openai.com/codex/sdk/) and the machine's existing Codex sign-in. TEXT WORKFLOW runs an isolated, read-only Codex agent for prompt enhancement. IMAGE WORKFLOW runs an isolated agent that invokes its native image-generation skill, then imports one returned image into the Video Project. This does not turn a ChatGPT subscription into an API key or proxy arbitrary Responses API calls. Both workflows discover visible models and default reasoning efforts through the installed Codex CLI’s `app-server` `model/list` RPC. Text-only models are excluded when image input is required; unavailable saved models require an explicit new selection. The successful catalog is cached in `codex-models.json` for offline use. **Fast (priority)** defaults off and is stored in native Harness provider settings. The installed CLI is preferred over the SDK’s bundled executable; `DSH_VIDEO_DIRECTOR_CODEX_PATH` overrides discovery. Native generated images are copied from the current SDK thread’s `generated_images/<thread-id>/` folder when no image payload is streamed, preserving the original image.

The Host refreshes Ollama models from `/api/tags` and renders only the available inventory entries in Settings and text-workflow nodes. Ollama text nodes expose System Prompt, Context Length, and Thinking under **Advanced**; Thinking is disabled when the selected model does not report that capability, and the discovered model context length bounds the optional override. The Host refreshes ComfyUI model enums from `/object_info`, but exposes a choice only when a registered comfyui-workflow or vd-node definition explicitly declares that exact graph input as configurable. ComfyUI-backed vd-nodes therefore continue to select a named comfyui-workflow first; checkpoint, UNET, CLIP, VAE, or LoRA files appear only in that comfyui-workflow's parameter selectors. Raw `object_info` and credentials never reach the browser.

The Host Cordis plugin owns `ProjectStore`, `ComfyWorkflowStore`, `VdNodeRegistry`, `ProviderRuntime`, `JobManager`, the `/video-director` RPC namespace, and authenticated asset responses. The browser half owns project/session switching, explicit save with optimistic revision checks, generic node rendering, canvas state, graph planning, provider checks, and job polling. Canvas edits remain local until **Save** is pressed; switching or creating a project requires saving or confirming discard. Running does not require a save: clicking Run freezes the graph once, topologically schedules its remote nodes, and sends an immutable per-node execution snapshot to the Host as each dependency stage becomes ready. Jobs persist status, graph-run grouping, batch coordinates, and safe provenance only, never the execution snapshot into the saved graph. Later canvas edits are not replayed or reverted, and a late older job cannot replace a newer run. Each project persists its own Harness `sessionId`, so opening a different project opens its conversation context as well.

| Provider kind | Current operations | Notes |
|---|---|---|
| `ollama` | Text/prompt enhancement with optional image context | Uses `/api/chat`; configure a multimodal model for vision. |
| `openai-compatible` | Chat completions, image generation, source-image/mask editing, and speech transcription | Uses `/chat/completions`, `/images/generations`, multipart `/images/edits`, and `/audio/transcriptions`; compatibility varies by server. |
| `codex-plan` | Text/prompt enhancement and image generation, both with optional image references | Uses the local Codex SDK/auth session in an isolated temporary workspace and imports generated images; no Base URL or API key field. |
| `comfyui` | API workflows, uploads, queue/history, and output retrieval | REST is required for health and media transfer. If the hidden MCP transport passes a read-only queue probe, the Host may use it for enqueue; otherwise it uses REST. |

Provider model choices are discovered rather than typed freehand where the provider has a native inventory API. Ollama models come from `GET /api/tags` and appear as a dropdown. ComfyUI choices come from `GET /object_info`, but are not exposed as one global model list: the Host maps them only to parameters explicitly exposed by a registered comfyui-workflow or installed vd-node definition.

Provider endpoints are deployment-owned configuration, not project input. For remote endpoints, put ComfyUI behind TLS and authentication and understand that connected project media will leave the machine.

Chat speech input sends a recording or selected audio file to the Host, which calls the selected OpenAI-compatible provider's `/audio/transcriptions` endpoint with multipart input. API keys remain in native DSH settings and are never returned to the browser or stored in a Video Project. One transcription input is limited to 25 MiB, and its result is inserted into the composer without being sent automatically.

## Unified ComfyUI transport

Users configure one ComfyUI address, such as `127.0.0.1:8188`. A successful REST `/system_stats` check is mandatory because uploads, exact history monitoring, `/view`, and project asset ingestion need the HTTP endpoint. Transport selection is a Host concern and is reported only as connection/job diagnostics.

When DSH Tools and the hidden MCP tool are available, the Host first performs the read-only `get_queue_status` probe. A successful probe selects MCP for `enqueue_workflow`; an unavailable probe selects REST `/prompt`. Once MCP enqueue begins, an error or ambiguous response is never retried through REST because doing so could submit the same render twice.

The optional reference transport pins [`artokun/comfyui-mcp@0.49.3`](https://github.com/artokun/comfyui-mcp/tree/v0.49.3), sets `COMFYUI_MCP_AUTOUPDATE=0`, and connects it through native [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/mcp/mcp-client) stdio with stable server name `comfyui`.

The patch's exact-version `npx -y` command is convenient for evaluation but still invokes a package runner at startup. For controlled deployments, install that exact release in an administrator-owned location, lock its dependency tree, point `command`/`args` at the installed executable, and keep auto-update disabled.

Version 0.49.3 normally exposes compact `list_tools`, `describe_tool`, and `call_tool` meta-tools. Video Director invokes only its allowlisted queue operations through `call_tool` and sends `disable_random_seed: true` after choosing its own seed. DSH bridges MCP tools only—not resources, prompts, Codex/Claude hooks, or `comfyui-mcp` completion files—so the plugin still watches the exact job through ComfyUI REST history.

The generic DSH MCP timeout is not a render lifetime. A render is submitted once, its `prompt_id` is retained, and completion is collected asynchronously. There is no supported MCP-only user provider: the logical ComfyUI backend always needs its REST address.

## ComfyUI workflow registry, JSON, and bindings

Use **Settings → Nodes & Workflows** to import a named ComfyUI **API-format** JSON file (`{ "nodeId": { "class_type": "...", "inputs": {} } }`), not editor/UI JSON with `nodes`, `links`, and layout state. The registry keeps the executable graph server-side and exposes only its safe descriptor and configurable parameters to canvas nodes. Image generation and image edit are separate workflow purposes; selecting a ComfyUI provider changes the node's second selector from **Model** to **Workflow**.

That top-level selector remains **Workflow**. Loader choices reported by ComfyUI `/object_info`—for example checkpoint, UNet, VAE, CLIP, or LoRA names—become dropdowns only for the exact registered comfyui-workflow/vd-node parameters that explicitly expose those inputs. Video Director does not flatten those choices into a global checkpoint/model selector and does not reveal parameters that the registered definition keeps fixed or hidden.

The importer recognizes common prompt, negative prompt, seed, width, height, duration, frame, FPS, and `LoadImage` inputs. Common creative controls are presented directly; sampler, scheduler, model, CFG, steps, output-prefix, and other detailed fields stay available inside the node's collapsed **Advanced** section. A workflow still resolves to a graph and explicit semantic bindings at execution time:

```json
{
  "workflow": {
    "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024 } },
    "5": { "class_type": "KSampler", "inputs": { "seed": 1001 } }
  },
  "bindings": [
    { "nodeId": "4", "input": "width", "from": "width" },
    { "nodeId": "4", "input": "height", "from": "height" },
    { "nodeId": "5", "input": "seed", "from": "seed" }
  ]
}
```

Binding sources are `prompt`, `negativePrompt`, `seed`, `width`, `height`, `duration`, `frames`, `fps`, `steps`, `scheduler`, `variant`, `asset`, `maskAsset`, `trimStart`, `trimEnd`, `inputWidth`, `inputHeight`, `aspectRatio`, `includeAudio`, `referenceRole`, and `literal`. A binding patches only the named input. `mediaIndex` selects a connected input (default `0`). Asset bindings receive the filename returned by ComfyUI upload; local workspace paths are never inserted into loader nodes.

Here `workflow` is a comfyui-workflow and binding `nodeId` is a **comfyui-node ID**. In contrast, `project.graph.nodes[].id` and a job's `nodeId` identify a **vd-node**. `workflowId` selects a registry entry; `workflowRunId` groups a vd-run; `jobId` identifies a vd-job; ComfyUI `prompt_id` identifies a backend submission.

See [`custom_nodes/comfyui-basic-image.node.json`](../custom_nodes/comfyui-basic-image.node.json), [`custom_nodes/z-image-turbo.node.json`](../custom_nodes/z-image-turbo.node.json), [`custom_nodes/minimax-h3-t2v-turbo.node.json`](../custom_nodes/minimax-h3-t2v-turbo.node.json), [`custom_nodes/minimax-h3-audio-turbo.node.json`](../custom_nodes/minimax-h3-audio-turbo.node.json), and [`custom_nodes/minimax-h3-audio-standard.node.json`](../custom_nodes/minimax-h3-audio-standard.node.json). Read [`custom_nodes/README.md`](../custom_nodes/README.md) first. A ComfyUI workflow is executable configuration and can call installed comfyui-node classes; do not import untrusted JSON.

## Preview and Save nodes

The bottom dock exposes `core.preview@1.0.0` and `core.save@1.0.0` as ordinary, connectable sink nodes:

```text
Generate Video -> Preview -> Save Output
```

Preview accepts text, image, audio, or video and selects the corresponding safe inline renderer. When a generation completes without a connected Preview, Video Director creates one automatically so the result is never hidden. Save receives the same immutable project assets, lets the user choose an output name, and provides an explicit local download. It does not copy large server bytes or allow an arbitrary server filesystem path.

## vd-node packs and field presentation

A vd-node pack uses the existing `video-director.node/v1` protocol, historically called Video Director Custom Node v1. It declares an immutable `type@version`, typed input/output ports, host-validated fields, exact comfyui-workflow bindings, and `primary` versus `advanced` placement. It is a declarative document; a ComfyUI custom-node package supplies Python classes on the ComfyUI server. Install a trusted `.director-node.json` from **Settings → Nodes & Workflows**, then add it from the bottom dock's **Custom Node** selector.

The generic renderer shows only `primary` fields on the normal node surface. Every `advanced` field remains editable under a collapsed **Advanced** disclosure, keeping large image/video workflow nodes compact without discarding control. Browser-imported packs may declare only the reviewed `comfyui.workflow` implementation; they cannot include JavaScript, shell commands, credentials, arbitrary MCP tools, React, HTML, or CSS.

- Human-readable interface: [`docs/custom-node-protocol.md`](./custom-node-protocol.md)
- Canonical JSON Schema: [`schemas/video-director-node-v1.schema.json`](../schemas/video-director-node-v1.schema.json)
- Complete image-node example: [`custom_nodes/comfyui-basic-image.manifest.json`](../custom_nodes/comfyui-basic-image.manifest.json)

Each installed definition is pinned by type, exact SemVer, and content digest. Reinstalling identical content is idempotent; different content at the same version is rejected. Projects keep exact node references and values rather than embedding transport choices or credentials.

Text parameters can also become per-instance input ports. Right-click a node, open **Parameter inputs**, and enable one of the listed Prompt, Negative prompt, or declared string fields. The field's local value remains the fallback when no edge is connected; connected text overrides it only for that run snapshot. Disabling the input removes its edges as one undoable edit. Number and boolean fields remain local controls in protocol v1.

Multimodal references use normal typed vd-node ports. An R2V vd-node can therefore declare separate image, video, and audio inputs—each with an exact ComfyUI workflow binding—and receive outputs from upstream load or generation nodes. Video Director does not invent a Reference port for a workflow that never consumes it.

## ComfyUI workflow-to-node skill

The plugin registers the bundled [`comfyui-workflow-to-node`](../skills/comfyui-workflow-to-node/SKILL.md) skill with DSH when the Skills service is present. It can use the included offline analyzer for a trusted **API-format** portable pack, or compile a trusted editor template into a repository built-in when exact metadata from the matching ComfyUI `/object_info` is available. Both paths preserve exact bindings, place the common path in `primary`, and move detailed controls into `advanced`.

The skill may read ComfyUI metadata for exact UI-template conversion, but it does not submit the workflow, generate media, install ComfyUI custom-node packages, or download models without a separate user request. An agent must review ambiguous mappings, prompt polarity, media roles, output detection, operation, defaults, and field placement. See its [protocol reference](../skills/comfyui-workflow-to-node/references/node-protocol-v1.md) and [project built-in workflow reference](../skills/comfyui-workflow-to-node/references/project-builtin-workflows.md).

## MiniMax H3

Adding an H3 video or audio node defaults to the corresponding built-in self-hosted Turbo workflow and its semantic bindings, so a new node is runnable without pasting a template first. The Audio Workflow selector also offers `MiniMax-H3 Audio (Standard)`. The video preset decodes synchronized video and audio through `CreateVideo`/`SaveVideo`; both audio presets keep a disposable `32×32` visual latent and save only the decoded native audio. The Turbo graphs use `MiniMaxH3TurboLoRA` and the custom Turbo sampler. The Standard audio graph has no LoRA, uses `KSamplerSelect` with `res_multistep`, and defaults to 20 steps.

The built-in presets match the model inventory verified at the reference `127.0.0.1:8188` deployment: `minimax_h3_fl2va_int8_convrot.safetensors`, `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`, `minimax_h3_video_vae_fp16.safetensors`, `minimax_h3_audio_vae_fp32.safetensors`, and `minimax_h3_turbo_v4_step600_ema.safetensors`. Model filenames are deployment-local, not universal ids. If your compatible H3 files have different names, inspect the loader enums in `/object_info`, export a compatible API-format workflow, and import it under **Settings → Nodes & Workflows**. Do not substitute REF2VA for the FL2VA route merely because it is installed.

The video and Turbo audio built-ins have a fixed Turbo topology, not a topology switch. Changing only a variant field cannot remove their LoRA and custom Turbo sampler graph; the Standard audio option selects its separate reviewed non-LoRA Workflow JSON as a unit.

Provider validation runs before upload or enqueue:

- Width and height must be positive multiples of 32; the UI default is `1280×704`.
- Duration must be greater than zero and no more than 15 seconds.
- At 24 fps, the rounded request is aligned upward to H3's `17k+5` grid; results report effective frames and duration.
- Durations below 5 seconds are marked experimental.
- Audio-only H3 keeps its disposable visual latent at `32×32`.
- Turbo accepts 4–8 steps and only `simple`; use a standard graph for other samplers/schedulers.

The built-in presets cover T2V-with-audio and prompt-only audio. They are not a full H3 template compiler; I2V and R2V still require reviewed API graphs with explicit media bindings. For pinned multi-route preparation, see [`MiniMax-H3-Codex-Drama`](https://github.com/chiphoton/MiniMax-H3-Codex-Drama).

### H3 is separately licensed

This plugin code is MIT-licensed. MiniMax H3 base weights use the [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), not MIT or a conventional open-source model license. At the time of this implementation, the agreement excluded the United States, European Union, United Kingdom, and South Korea from its applicable territory; required prior written authorization above its stated USD 20 million annual-revenue threshold; and imposed product attribution, hosted-service safeguards, acceptable-use, redistribution, and model-improvement restrictions. Read the current text rather than relying on this summary.

`minimaxH3LicenseAccepted` defaults to `true` as the runtime acknowledgement flag; set it to `false` to keep H3 locked. This setting is not legal advice or a license grant. Review the agreement and obtain any required authorization before use. Turbo node/LoRA terms do not replace the base-weight agreement.

The referenced workflow templates and `comfyui-mcp` are MIT-licensed, while the Turbo node/LoRA are Apache-2.0. ComfyUI itself is GPL-3.0; calling a separately deployed HTTP service and redistributing a modified/bundled ComfyUI are different scenarios, so review the obligations of your actual distribution.

## Persistence, recovery, and security

Vd-run submissions enter a FIFO queue in the current browser controller. Each submission captures its canvas and settings before waiting; dependency stages and batches complete before the next submission starts. Summaries and write-once snapshots are stored separately under `projects/<project-id>/runs/` through `vd-runs/save`, `vd-runs/list`, and `vd-runs/get`. Listing transfers summaries only. The Jobs drawer can restore a submitted graph as an undoable canvas edit or export its graph and referenced assets as a project archive. Queued runs remain cancellable, and cancelling or failing one run releases the next queue entry.

Service disconnect recovery happens in `ProviderRuntime`. ComfyUI history, queue reads, uploads, and output response bodies retry connection errors and HTTP 408/425/429/502/503/504 with 1–30 second exponential backoff until recovery or cancellation; there is no overall render deadline. Read/download attempts have the configured request timeout. History is checked for the original `prompt_id` before queue status, so a render completed during an outage is collected directly. Error history fails the job instead of polling forever. Ollama chat retries the same text request because its chat API has no asynchronous result handle. VRAM unload triggers also retry transient connection errors.

A REST enqueue whose connection was refused can be retried before acceptance. If the response is lost after the connection was established, recovery searches queue/history for that submission's unique `client_id` without another enqueue. If acceptance cannot be established, it remains `reconciling-submission` until the record appears. Cancel switches reconciliation to cancellation cleanup, which must still locate the accepted prompt before confirming it stopped. This uses the metadata preserved by [ComfyUI's queue/history routes](https://github.com/comfyanonymous/ComfyUI/blob/master/server.py). MCP enqueue ambiguity still follows the conservative policy above; once either transport supplies a prompt ID, REST monitoring is recoverable.

Cancellation is part of provider execution cleanup. REST and MCP enqueue retain their bounded request receipt after user cancellation so the returned prompt ID is not lost. `ProviderRuntime` then calls `POST /api/jobs/{prompt_id}/cancel` using a fresh request signal and waits until that exact prompt disappears from `/queue`. Transient cleanup failures retry with the usual backoff while the job remains `running` with phase `cancelling` or `cancelling-reconnecting`, keeping its execution slot occupied. Older servers only receive `POST /queue` with `delete: [prompt_id]`; the global `/interrupt` and queue clear operations are never used. An unsupported running-prompt cancellation, rejected cancellation, or unidentifiable MCP submission fails with `video-director/remote-cancel-failed`, including in the grouped vd-run summary. A completed remote prompt needs no interrupt when cancelling output retrieval.

Ollama inference uses the user's abort signal for both fetch and response-body consumption. Cancellation closes that HTTP request and disables reconnect retries, without unloading shared models. This matches [Ollama's request-scoped inference context](https://github.com/ollama/ollama/blob/v0.32.15/server/routes.go). Socket-level regression tests cover cancellation before headers and during a partial response. A late provider result cannot mark an aborted local job completed.

Assets are written once under `dataDir/assets`, indexed with SHA-256, and served with `Cache-Control: private, ... immutable`; audio/video supports a single byte range. Editing media creates a derived asset rather than overwriting the original. Projects retain their latest 100 jobs.

Recovery is conservative: a local job left `queued` or `running` when Harness stops becomes `orphaned` after restart and is not submitted again. A timeout does not prove ComfyUI failed; inspect the retained `prompt_id` and ComfyUI history before another attempt.

A Video Project remains available when its bound Harness Session cannot be resumed: the canvas loads with the Session error instead of becoming inaccessible. Use **Chat input settings → New session** to bind a fresh conversation while preserving the current project and canvas. The failed Session is not modified or deleted.

- Run ComfyUI/Ollama on loopback or an authenticated private network by default.
- Never put API keys in project JSON, nodes, prompts, or workflow literals.
- Treat model downloads and ComfyUI custom-node package installation as administrator actions; these packages execute local Python.
- Submit trusted workflow JSON only. Structure validation cannot prove installed node behavior.
- Browser-imported vd-node packs are declarative and schema-validated; they cannot carry arbitrary executors. Their embedded ComfyUI workflows can still invoke already-installed ComfyUI custom-node packages, so trust review remains necessary.
- MCP tools and operations are Host-owned and allowlisted; model removal, node installation, process restart, broad queue clearing, and arbitrary server-path reads are outside this plugin path.

## Known limitations

- No collaborative graph merge; revision conflicts require UI reload/merge.
- Restart recovery records in-flight jobs as orphaned; it does not resume a persisted ComfyUI watcher.
- Workflow orchestration requires the current browser project to stay open. Submitted snapshots survive a reload for opening/exporting, but queued dependency scheduling is not resumed after closing the controller or restarting Harness.
- Progress uses polling rather than a per-prompt WebSocket observer.
- H3 I2V/R2V graphs and role-aware reference wiring are not bundled; the built-ins cover T2V-with-audio and prompt-only audio.
- Mask, trim/crop, and resize controls do not yet run a built-in FFmpeg/image preprocessing pipeline.
- OpenAI-compatible behavior varies by vendor.
- ComfyUI editor-format JSON is not compiled. The workflow-to-node skill requires API format and produces a draft for review; it never silently installs or executes the result.

## Synced canvas features

The [canvas sync record](canvas-sync.md) describes the source revision and Harness adaptations. **Settings → Language** changes only the Video Director interface. **Settings → Storage** copies and switches canvas data while retaining Harness-managed settings and session bindings. The initial `dataDir` keeps a `.video-director-storage.json` locator; preserve it for future launches. Native folder selection/opening runs on the Harness host.

`src/director-host.js` owns the active stores and coordinates storage changes. It drains accepted RPC writes, blocks new writes during migration, rejects active jobs/workflows, and activates a copy only after the persistent locator is committed. Asset routes resolve the current store. `examples/list`, `examples/get`, and `storage/{info,open,choose,change,reset}` use the existing authenticated `/video-director` channel. No additional HTTP server is required.

## Development and tests

```sh
pnpm run build
pnpm run typecheck
pnpm test
pnpm run check
```

Tests cover plugin/patch discovery, project identity and revision conflicts, immutable asset bytes and HTTP ranges, immutable vd-node definitions and field validation, Preview/Save catalog entries, REST/MCP routing without duplicate submission, H3 licensing/constraints, conservative job recovery, and RPC input validation.

Primary references: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DirectorX](https://github.com/LaplaceYoung/dsh-directorx), [Tongflow](https://github.com/tong-io/tongflow), [MiniMax-H3-Codex-Drama](https://github.com/chiphoton/MiniMax-H3-Codex-Drama), [comfyui-mcp 0.49.3](https://github.com/artokun/comfyui-mcp/tree/v0.49.3), and [ComfyUI](https://github.com/Comfy-Org/ComfyUI).
