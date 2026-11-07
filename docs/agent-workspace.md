# Sidebar agent workspace

Implemented on `uncensored` for DSH `0.2.1-rc.2`. This guide describes the implemented interface; the [original design](design/2026-10-18-sidebar-agent-workspace/README.md) contains broader proposals and concept images.

## Try the first milestone

Use a disposable workflow with synthetic inputs.

1. Open the chatbox gear → **Manage skills**, select **New skill**, enter a lowercase name, description, and instructions, then **Save version**. Add examples under **Supporting files** if needed.
2. Select a version and **Load in chat**. This pins that version. The linked agent obtains its instructions with `vd_library load` when needed; selection alone does not send the instruction body.
3. Type **$** in the chat input (or use **Skills** below it), then select a suggestion with a click or Enter. Arrow keys move the selection, Tab reaches **Manage skills**, and Escape closes the picker. Ask the agent to create a text node containing invented text and connect a preview. It uses `vd_canvas summary/query` and a revision-checked `edit` batch.
4. Expand **Canvas changes**, select **Inspect**, and use **Undo**. Both browser edits and agent edits have durable receipts. Undo rejects newer conflicting edits instead of overwriting them.
5. Save another skill version. An existing selection keeps its original version until explicitly changed. **Unload** stops future activation; it cannot remove text already in chat history.

Explicit `$skill-name` mentions appear as boxes within the message draft. They are resolved before submission and keep an already selected version pinned. To unload a skill, open **Manage skills**. Unknown or ambiguous names stop submission with an actionable message. Escaped dollars and code examples are literal text. **Auto skills** in Chat settings is on by default and lets the agent invoke a matching built-in from a plain-language request. Automatic invocation loads instructions on demand and leaves the selected skills list intact.

The chatbox gear also opens **Model settings**, using dsh’s native Models dialog and shared session model directory. Closing it returns to the canvas with the message draft intact and refreshes the model choices. Speech settings and workflow access/context details are collapsed in the same menu.

## Build a canvas from chat

Choose **$canvas-builder** in chat. It is a built-in skill with short patterns from [canvas-demo and all-in-one](../examples/README.md). You can duplicate it in **Manage skills** to customize the instructions.

1. On a blank test workflow, attach a synthetic image and try “Add an Image Input using this attachment and a Text Input containing a short scene brief. Leave them unconnected.”
2. Follow up with “Use the brief as the Prompt and the image as the Reference for a MiniMax-H3 Reference to Video node. Connect its video output to Preview. Build the draft and check the connections.”
3. Open **Canvas changes** to inspect either batch or undo it. Requests for a plan alone stay in chat. Requests to build apply to the draft, so you can inspect it before saving or running.

The skill uses `vd_canvas plan-edit` to simulate changes at the current draft revision and inspect prospective ports. `ports` inspects existing nodes. Both return port handles and types without reading node text or media. Use a chat attachment alias or a same-workflow asset ID from `assets` to place media. Full generation still depends on configured providers and the selected models.

`$canvas-builder` finishes new workflows with `$layout-optimizer`. You can also invoke `$layout-optimizer` by itself to arrange an existing canvas and optionally add `Stage N:` titles. `vd_canvas layout` previews by default and applies a separate undoable draft change with `apply: true`. It uses the open canvas's card and port geometry when available, or estimates card sizes when no matching view is connected. It preserves connections and provider settings.

For visual review, open a current-workflow image or video from the canvas or Gallery. **Add to chat** attaches the image; **Add frames to chat** makes a six-frame contact sheet on the Host and attaches only that image. Neither action sends a message. Agents can use `vd_canvas media` with `operation: "video-contact-sheet"` and then `vd_canvas image` on a vision-capable model. The tool returns the sample times in reading order. A contact sheet is visual evidence and contains no audio.

On an empty canvas with a sketch attached, try **“$sketch-to-h3 Build a five-second video workflow of this paper boat drifting.”** DeepSeek applies the `sketch-to-h3` recipe in one validated edit using the sketch reference and a brief. The recipe sets both the H3 prompt and node duration, wires the typed ports, and lays out the graph. Say “use VRAM handoffs” if the providers share a memory-constrained accelerator. Ask to run separately when you are ready to generate.

## Implemented scope

| Area | Available behavior |
|---|---|
| Contract and context | Four scoped tools; `vd/1`; operation discovery and input schemas; projected neighborhood queries; bounded response references; revision-bound cursors; automatic metadata context with a 2 KiB ceiling. |
| Managed library | Create, edit, import, export, duplicate, archive/restore, publish/unpublish, version, select, load, and unload skills. Supporting files stay with immutable versions. |
| Canvas and history | Shared typed graph edits, browser draft receipts, retry keys, Inspect/Undo, and acknowledged select/frame/zoom/inspect/preview commands. |
| Quality iterations | Criteria, pinned skill versions and provider model choices, job/iteration/time limits, deterministic checks, evidence-backed perceptual reports, affected-branch reruns, retained best run, and explicit stopping reasons. |
| Recovery and scale | Atomic publication of versions/receipts, orphan records excluded from history, restart reconciliation without blind resubmission, managed-data relocation, portable skill bundles, and tests at 2,000 nodes / 5,000 edges. |

Persistent canvas/library operations work without an open browser. View operations require a connected canvas; their receipts distinguish `queued`, `applied`, `failed`, and `unavailable`.

The operation manifest covers the new sidebar, canvas, asset import/edit, custom node/template registries, non-secret provider model settings, and storage controls. DSH's native conversation creation/model picker/credentials, OS choosers, and the existing cross-workflow create/duplicate/import/export/organization UI retain their existing owners. They are not advertised as headless workspace operations. Workflow exports retain their existing format; skills are exported separately.

## Local storage and skill versions

Everything uses the existing configurable Video Director data folder. No separate skills root or personal data in the plugin checkout is required.

```text
<dataDir>/
  library/skills/<skill-id>/
    index.json
    versions/<revision>/
      bundle.json
      SKILL.md
      references/...
      assets/...
      scripts/...
  projects/<project-id>/
    project.json
    library-bindings.json
    agent-access.json
    operations/<operation-id>.json
    quality/<plan-id>.json
  assets/...                         existing media storage
  workflows.json                     existing custom definitions/templates
```

The index publishes the current version only after its complete bundle has been written. Old versions remain immutable. Skill edits require `expectedRevision`. Existing workflows need no eager content rewrite; sidecars are added when these features are used. The existing storage-move operation carries the complete library and journals, and refuses to move while quality plans or generation work remain active.

Import accepts a `SKILL.md` with YAML frontmatter, or a JSON bundle with `name`, `description`, `content`, `resources`, and optional `frontmatter`. **Export version** downloads the portable JSON bundle without local workflow IDs, chat IDs, or absolute paths. Each stored version also contains an ordinary `SKILL.md` and its relative resource files.

Skills are private to their workflow until **Share across workflows** is used. Other workflows may select a shared version and import a copy to edit it; they cannot modify its owner's record. Archive hides a skill from discovery while retaining pinned versions. Changing the linked chat clears activation for the new chat.

Limits: eight selected skills per chat; 12 KiB UTF-8 instruction bodies, with an additional encoded-load limit; 20 supporting text files; 512 KiB resource JSON per bundle. Resource paths must be relative to `references/`, `assets/`, or `scripts/`. Scripts are stored as text and are not executed by the library.

`disable-model-invocation: true` requires a human selection before agent loading. `user-invocable: false` prevents sidebar activation. Imported frontmatter is preserved when saving a version.

Managed skills use `vd_library` rather than a global DSH filesystem skill provider. In this DSH version, filesystem discovery is based on cwd rather than the linked VD project/session pair. The scoped loader derives the actual executing session, preventing two projects sharing a cwd from exposing each other's private library. The existing bundled ComfyUI skill continues to use DSH's native registry.

## Tool interface

Tool arguments use `{projectId, command, args}`. The tool adapter supplies `protocol: "vd/1"` and the actual executing DSH session identity; a caller-supplied project ID does not grant access.

| Tool | Commands |
|---|---|
| `vd_library` | `list`, `create`, `save`, `get`, `bind`, `load`, `active`, `unload`, `resource`, `archive`, `publish`, `read-result` |
| `vd_canvas` | Existing `help`, summary/catalog/reference/media/run commands, plus `query`, `history`, `inspect`, `undo`, `read-result`; `edit` accepts a retry key. |
| `vd_workspace` | `manifest`, `describe`, `call`, `view`, `view-status`, `storage`, `read-result` |
| `vd_quality` | `create`, `list`, `get`, `step`, `revise`, `evaluate`, `stop`, `read-result` |

Discover workspace operations with `manifest`, then request `describe {name}` for an operation's `inputSchema`. `call {name,input}` accepts only that operation's documented fields. The underlying host handler remains responsible for semantic validation, resource ownership, and revision checks.

Examples below are synthetic. Replace `PROJECT_ID` with the active project's ID; the host validates IDs.

```json
{
  "projectId": "PROJECT_ID",
  "command": "query",
  "args": {
    "selector": {"ids": ["script"], "hops": 1, "direction": "downstream"},
    "fields": ["id", "kind", "title", "status"],
    "limit": 20,
    "maxBytes": 4096
  }
}
```

```json
{
  "projectId": "PROJECT_ID",
  "command": "edit",
  "args": {
    "expectedDraftRevision": 0,
    "idempotencyKey": "53492cf6-926d-480b-9f4d-1495cc8cb0db",
    "edits": [
      {"op": "add", "id": "script", "kind": "load-text", "data": {"text": "Synthetic scene."}},
      {"op": "add", "id": "preview", "type": "core.preview"},
      {"op": "connect", "source": "script", "target": "preview"}
    ]
  }
}
```

Read `history`, then `inspect {operationId}` for changed node/edge IDs and workflow fields. Receipts omit inverse content. To undo, supply `operationId`, the current `expectedDraftRevision`, and optionally a new `idempotencyKey`. Repeating the identical edit with the same key returns its receipt; reusing a key for different edits fails. Undo itself is journaled. It does not undo provider costs or delete generated outputs.

The browser's existing coalesced draft writer also creates receipts. Browser and agent writes share the project lock, validation, revisions, and history, while the browser retains its immediate local edit/undo experience.

## Context and response bounds

Automatic context includes project identity/revisions, counts, selected skill references, and tool guidance. It omits prompts, scripts, media, and complete graphs. **Context** in Chat shows the actual metadata string and UTF-8 byte count.

- Ordinary tool results default to 8 KiB; `maxBytes` is clamped to 1–16 KiB. A skill load can use 16 KiB.
- Query pages contain at most 50 nodes and 20 projected fields; neighborhood depth is 0–3.
- Oversized values become `vd-result-reference` objects. `read-result` reads the requested JSON pointer, selected fields, or next text/array page. It returns valid JSON rather than cutting serialized output.
- References expire after five minutes, a canvas revision change, or a runtime restart. They are scoped to the workflow and linked chat. Revoking content sharing also revokes sensitive result reads.
- Signed query cursors bind the selection, fields, chat, and draft revision. Restart a query after `stale-cursor`.
- Image inspection is an explicit, separately bounded multimodal attachment; it is not covered by the ordinary JSON text budget.

Skill resource offsets and result text offsets count UTF-16 code units. A result reference is an in-memory read handle, not a file path or an asset download URL. Large binary exports should use the existing local export UI instead of streaming base64 through model context.

## Content sharing

The VD agent tools default to metadata-only access for each workflow. Node text/media, output details, custom definitions, and provider execution require enabling **Allow the chat agent to read this workflow's text/media and run configured providers** in the Context inspector. Built-in node definitions, node and edge metadata, and authorized reversible edits remain available without enabling content reads. Provider endpoint URLs and secret values are omitted from agent catalog responses.

Loading a selected skill sends those instructions to the configured chat model. Explicit chat attachments have their own existing DSH behavior. This VD setting does **not** restrict other DSH filesystem/shell tools or change the selected model's network behavior. Use DSH's tool permissions and a local model when those are requirements; this is not a machine-wide sandbox.

## Quality iterations

Create a plan from **Runs**, or use `vd_quality create` with a brief, criteria, and budgets. Criteria support `graph-valid`, `run-completed`, `node-count`, `artifact-count`, `text-includes`, and `perceptual`. An execution-success check is always added.

The owning agent drives:

```text
create → step → inspect results
                  ├─ accepted
                  ├─ needs-revision → revise → step
                  ├─ inspecting → evaluate with evidence
                  └─ stopped with a recorded reason
```

`step` reserves jobs before submission. Agent calls wait for up to ten seconds by default (`waitMs` can request up to 30 seconds), then return the durable plan state. Subsequent calls continue inspection. The host deadline remains active independently of the browser or chat request.

Default limits are three iterations, twenty execution jobs, and ten minutes; maxima are ten, one hundred, and sixty respectively. Execution jobs conservatively include executable control nodes. Standalone run/job submissions are blocked while a plan is active. These are execution limits, not a monetary-cost estimator.

`revise` applies a typed canvas batch at the plan's recorded revision. It reruns changed nodes and their descendants. Unchanged completed outputs are reused only in the execution snapshot, with source run/job provenance retained across iterations. Topology or workflow-setting changes invalidate that reuse. The editable canvas is not silently frozen.

Quality outputs stay in run history until explicitly attached to the canvas. Ordinary browser job polling does not copy them into node fields or add preview nodes: that would change the plan's input revision and could overwrite a newer human edit. The existing Job List can inspect each retained output.

Perceptual evaluation records a criterion ID, `pass|fail|unknown|needs-human`, confidence, reason, and output evidence `{jobId,assetId?,atSeconds?}`. Evidence must identify an output of the current execution or a recorded reused output. Missing evidence cannot establish a pass. Below-threshold confidence becomes `needs-human` (default threshold 0.7). Use the existing image/frame/transcription tools to gather suitable evidence; a successful generation job alone is not a visual-quality verdict.

The best measured run remains accessible by its retained run ID and score; a later equal/worse score stops further automatic revision. Human edits, changed skill selections, changed provider model choices, failed cancellation, and exhausted budgets produce explicit states/reasons. A new skill revision does not change an existing selection. Changing the selection stops the old plan before further work.

Current quality plans handle a single workflow execution per iteration. Active Batch Input workflows return an explicit validation message and remain available through the existing batch controls. Quality plans do not start new DSH model turns or provide a background reasoning daemon. Unresolved perceptual checks require the current agent or a person to continue evaluation. Best-run retention does not automatically restore that run's graph over the current canvas.

## Verification

All new end-to-end fixtures use temporary synthetic workflows and skills. Provider output tests use in-process stubs with invented text; they make no model-provider calls. DOM tests exercise sidebar skill creation/selection and change inspection/undo through the real host handlers.

Run `npm run check` for build, type checking, and the complete suite. The separate `check:dsh` script checks the installed rc.2 host contracts using source/package files and disposable profiles. It does not inspect the running user's data directory.

The October 19 chatbox revision adds synthetic coverage for `$skill` selection, literal dollars, duplicate names, pinned versions, the skills dialog, and native dsh model-settings synchronization. Restart/reload the plugin host and refresh the client after building to use the updated interface and protocol together.

Validation: **551/551 tests** and **15/15 DSH rc.2 contract checks** passed. Build and type checking passed; the synthetic browser fixture verified keyboard skill selection, the manager dialog, and model changes appearing without losing the message draft.

Regression coverage includes scope isolation, stale writes/cursors, Unicode response limits, skill version pinning, restart persistence, interrupted submission, storage relocation, missing evidence, deadline/budget stops, three-iteration output reuse, view acknowledgements, and large-canvas undo. Real model quality and live private workflows are outside these tests.
