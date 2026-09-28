# Sidebar chat and Host canvas commands

Implemented on `uncensored`, after commit `a7cd2ea` (`v0.4.1: optimized performance`). The sidebar work is a separate, uncommitted change.

## What “Project context linked” sends

The previous `DirectorController.currentContext()` serialized every node's ID, title, prompt, text, status, selected workflow, asset name/ID, and every connection on every chat message. It did **not** automatically send every asset's bytes. Repeating long scripts and prompts still made the payload grow with the whole canvas, including information irrelevant to the current question.

The new default is a small JSON envelope: project ID/name, saved revision, draft revision, node/edge counts, and directions for using `vd_canvas`. A regression test puts a long synthetic script on the canvas and verifies that the envelope stays under 1,000 characters and excludes node contents. The WebKit synthetic fixture measured 425 characters for this default envelope. Used or newly added attachment aliases add only their kind, original name, and reference identity. Explicitly used/new image attachments can also go through DSH's native image submission path. Audio, video and folder bytes are stored on the Host; they are not automatically inserted into the language model's text context.

The recommended interface is a structured command tool with discoverable help, bounded queries and atomic edit batches. A shell is unnecessary for ordinary canvas operations, and arbitrary shell access would make graph validation and conflict detection harder to enforce. The built-in tool is now implemented in `src/canvas-agent.js` and registered with DSH's Host tool service.

```json
{"projectId":"…","command":"nodes","args":{"limit":10,"offset":0}}
```

```json
{
  "projectId":"…",
  "command":"edit",
  "args":{
    "expectedDraftRevision":7,
    "edits":[
      {"op":"add","id":"reference","alias":"<Image 1>","position":{"x":0,"y":0}},
      {"op":"add","id":"preview","type":"core.preview","position":{"x":400,"y":0}},
      {"op":"connect","source":"reference","target":"preview"}
    ]
  }
}
```

`help` describes the commands and arguments. Reads cover node summaries, selected node fields, edges, definitions, provider choices, session references, paged folder entries, text excerpts, project assets, media properties, and jobs. Edits cover creating, configuring, moving, cloning, freezing, removing, connecting and disconnecting nodes, edge configuration, workflow name/settings and viewport. The shared node factory, port resolver and sink recomputation are used by the editor and Host. Derived execution fields cannot be overwritten by an edit.

`validate`, `run`, `jobs`, `job`, `cancel`, and `save` use the existing Host execution/storage paths. The agent can plan a script in Text nodes, build a graph, validate it, submit a run, inspect results, and revise it within the user's iteration and spending limits. `media` performs trim/crop/frame extraction. `image` explicitly admits an image into DSH's durable attachment service and checks that the active model supports image input. `transcribe` uses an explicitly chosen configured speech provider/model. Transcription is limited to 25 MiB inputs and 16,000 returned characters; trim longer clips first. Transcription alone does not assess acoustic quality.

The tool derives session identity from the actual executing agent. A caller-supplied session ID cannot grant access to another project's conversation. File/asset access is scoped to the linked project. Folder names, node text and other content are described as data, not executable instructions.

## Browser-independent execution and concurrent edits

Canvas commands execute on the Host. There is no browser command queue or dependency on a mounted React component. Accepted runs remain owned by `WorkflowScheduler`; closing all tabs does not stop them or prevent the native DSH agent from issuing further tool calls during its turn. This does not introduce a separate daemon that starts new LLM turns after a session has finished.

`draftRevision` is independent of the saved workflow revision and job progress. Browser draft writes and agent edit batches compare the expected draft revision under the same project write lock. A batch either commits completely or leaves the graph unchanged. The editor uses the existing shared observer to fetch the graph only when a newer draft version appears. Unacknowledged local edits are retained on conflict. The conflict banner offers **Export local draft** and **Use Host version**; choosing the latter replaces the local draft. The recovery export contains graph/configuration and asset references, not a portable media archive.

Older clients that omit draft revisions remain compatible, so they cannot offer the same concurrency protection. Reload open editors after updating the Host/client bundle.

## Composer references

The compact References panel supports Image, Audio, Video, Folder and Node, with a reference count and 68-pixel-wide cards. Preview/remove controls appear on hover or keyboard focus (always available on touch devices); the main tile inserts a session alias. Aliases are atomic inline components stored as plain text in the prompt, so clipboard operations preserve `<Image 1>` rather than HTML. Removing a tile removes its aliases from the current draft prompt. References already sent remain available to earlier messages after their cards are removed.

Aliases are allocated atomically on the Host per project conversation. Removing an unsent reference releases its number and compacts the remaining draft aliases by kind. The prompt remaps aliases by reference ID in one pass, preserving local files and previews. Published aliases keep their original meaning and reserve their numbers for conversation history. A new conversation has a new namespace. Original file names remain separate from aliases and are preserved in `AssetRef.name` and the canvas asset importer. The Host's existing safe filename allocator may resolve filesystem collisions; an alias is never used as the uploaded filename.

Files upload when the message is sent. Uploads are sequential, large base64 conversions yield periodically, and each upload returns a compact receipt rather than repeating an entire folder manifest. An upload acknowledgement is separate from chat delivery, allowing a failed chat submission to retry its already uploaded references. Uploading must finish before those references can be used with the browser closed. An interrupted, unsent local attachment needs to be reattached after a reload.

Folder previews render a searchable/filterable, collapsible tree in 100-row increments. Folder queries to the model are paged separately. Folder manifests accept up to 5,000 files; Batch Input retains its existing 1,000-case limit. Supported media and small text files can become batch inputs; other files remain stored references with metadata. Directory enumeration reads all browser batches, rather than stopping at the first 100 entries.

Nodes can be added by double-clicking anywhere on their title bar, dragging an editable title to the composer, choosing **+ → Node**, or using **Add to Chat References** in the node context menu. Hover/focus in the submenu highlights the corresponding canvas node in yellow. Internal source vocabulary remains Vd-Node/Vd-Workflow; ordinary UI labels are Node/Workflow.

The sidebar owns file drag-enter, drag-over and drop events across its entire panel. Previously, drag-over bubbled to the native DSH composer's document listener, which could set `dropEffect` to `none` and prevent the drop. Accepted sidebar drags now use `copy` and stop propagation. File/entry handles are captured before asynchronous work; file-list and directory-entry fallbacks accommodate browser differences.

## Verification and practical limits

Only generated color images, sine-wave audio, color-bar video and temporary synthetic projects were used. No user assets, live project directory or Safari profile were accessed.

- `pnpm run check` passed: build, TypeScript and all **489 tests**. `git diff --check` also passed.
- Host tests cover session isolation, scoped assets, pagination, atomic rollback, competing edits, browser draft conflict/recovery, durable aliases, original filenames, explicit image admission and speech transcription dispatch.
- A workflow was constructed, validated and completed entirely through Host commands, with no browser/controller. It used a local skip trigger, so it did not call a paid generation provider.
- WebKit browser checks covered image aliases, clipboard cut/paste, atomic Backspace, token dragging, node title double-click/drag, hover highlighting, folder search, media preview playback, attachment submission and the narrow sidebar layout.
- Follow-up WebKit checks covered remove/re-add numbering, simultaneous prompt remapping, both title-bar labels and the bar background, the context-menu action, compact card geometry and hover controls, and image/audio/video drops onto the prompt, reference rail and message area with a competing document-level DSH drop handler.
- The browser fixture simulates the native DSH chat transport. A live model-driven planning/QC loop and paid generation were not exercised. Visual QC depends on the selected model; provider rate limits, pricing and generation quality are unchanged.

Run `node scripts/debug/sidebar-chat.mjs` for the isolated browser fixture. It prints its temporary URL/root and removes its synthetic data when stopped. Restart/reload the plugin Host and refresh the client to register the new tool and load the rebuilt bundle.

Further useful profiling targets are large-folder manifest writes on the Host and large historical job directories. The existing persistence layer still rewrites a reference manifest on an upload acknowledgement; changing that to an indexed/journaled store would reduce disk work for very large folders without changing the tool interface. The command surface is a foundation for agent canvas operation, not a claim of complete parity with every provider/registry administration dialog or browser download gesture.
