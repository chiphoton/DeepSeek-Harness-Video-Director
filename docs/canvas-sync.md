# Canvas sync — 2026-09-09

Source: `MiniMax-H3-Codex-Drama/plugins/canvas/`, commit `e861d4416cff31e9c03ddf4b11a556d54b88902b` (`v0.8.0: added canvas support`). The source's `upstream-lock.json` identifies this repository's current baseline, `3571ee801161e1870bc2ab49466f8d032fa869c2`.

| Source update | Harness integration |
|---|---|
| English/Chinese interface and remembered language | Ported across canvas, nodes, settings, previews, sketch/mask editors and chat controls. Uses `dsh-video-director.language`; the native Harness document language is unchanged. |
| Keyboard-accessible project/examples picker | Ported with `examples/list` and `examples/get` on the existing `/video-director` RPC channel. Existing `all-in-one` and new `canvas-demo` archives open as independent editable copies after saving current edits. |
| Open, change and reset the data folder | Ported with native host folder controls, staged copies, persistent location, backups, active-work guards, and write draining. `src/director-host.js` switches stores and keeps registered asset routes current. |
| Codex CLI model discovery and offline cache | Ported pagination, hidden-model filtering, catalog defaults, refresh, a five-minute generation cache, and explicit errors for unavailable selections. |
| Image-aware model selection | Image nodes and runs requiring image references exclude catalog entries reporting text-only input. Saved explicit models are retained until the user changes them. |
| Fast/priority mode | Added to the Codex connection card and both Harness provider schemas. Defaults off and overrides a personal Codex Fast default. Applies to Codex workflow nodes. |
| Installed Codex executable and runtime errors | Prefers the user's installed CLI over npm's SDK CLI. `DSH_VIDEO_DIRECTOR_CODEX_PATH` selects an explicit executable. Runtime/sign-in errors describe how to repair the Harness launch. |
| Native Codex image output | Imports the newest nonempty image from the current SDK thread's output folder, with streamed/workspace fallbacks. Other thread IDs and traversal paths are excluded; originals remain in place. |

Harness continues to own its Cordis plugin lifecycle, authenticated connection, settings and credentials, model directory, chat submission/steering, session bindings, launcher and close controls. Existing text/image provider defaults remain Ollama/OpenAI; projects explicitly selecting Codex keep that selection. A newly configured Codex provider follows the CLI's reported default model instead of a built-in model allowlist.

The Codex-only standalone server, session store, local credential file, marketplace manifest, adviser skill, CLI/setup/doctor scripts and branding were not copied. Their applicable runtime behavior was adapted to the existing Harness host. Generation graphs, custom-node definitions, schemas, execution/cancellation logic, and archive format were already shared; source differences that only renamed the host were retained as Harness terminology.

Storage moves copy canvas projects, assets, registry, run history and the Codex model cache. Conversation history and connection secrets stay under Harness management. The original configured data directory retains `.video-director-storage.json` to locate the active folder after restart. Folder dialogs and file-manager actions run on the Harness host, which may differ from the browser machine.

Validation includes the full `npm run check` suite, imported Codex regression tests, example import isolation, storage migration/reset/rollback and concurrency tests, and the Harness entry point with native settings and live asset-route checks. Provider execution tests use fixtures and do not start paid generation.

The source checkout is read-only during this sync. Its tracked canvas file hashes and repository status are checked against the pre-sync snapshot.
