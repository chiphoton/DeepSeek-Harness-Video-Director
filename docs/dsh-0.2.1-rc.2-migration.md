# Video Director migration to DSH 0.2.1-rc.2

Validated on 2026-10-17 with Node 24.15.0. The package is `dsh-video-director`, including the Media Editor and project chat.

| Item | Version / revision |
|---|---|
| Preserved plugin baseline | Tag `dsh-v0.1.2-alpha.3`, commit `dd33d909d21d4c525d2682af0254fb928ad4441c` |
| Baseline DSH | `dsh-v0.1.2-alpha.3`, commit `dd6322d604e00eec1ba5e0c8541159906a21094a` |
| Migrated plugin | `dsh-video-director@0.2.1-rc.2`, branch `codex/dsh-0.2.1-rc.2` |
| Target DSH | `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317` |

The code migration is complete for this exact release candidate. The manifest's `engines.dsh` and Connection peer dependency deliberately require `0.2.1-rc.2`. Later prereleases need another compatibility check. The local DSH source checkout and existing profile/project data were not upgraded during this work.

## What changed

- **Session ownership:** the chat retains its active Session with source `videoDirector`, waits for readiness, and releases it on project switch or disposal. An in-flight submission owns a separate reference. Renaming uses `sessions.using()`. Native navigation uses `uiWorkspace.openSession()`.
- **Session recovery:** catalog membership is independent of retention. Loading a project refreshes a missing catalog entry and opens the existing identity. It never calls `create({ sessionId })` to recover history: rc.2 interprets that as a blank-session reuse request. If history is missing, the canvas remains usable and the user can restore history or explicitly start a new conversation.
- **Live settings:** `providerOverrides` and `minimaxH3LicenseAccepted` are volatile Config fields. Their `.get()` snapshots refresh providers on `loader/volatile-update`. Settings mutations target the actual Loader entry ID, including custom instance IDs. Secret roles and inherited expressions are preserved.
- **Chat:** pending submissions use `attachments`; accepted queued messages come from the `inbox` projection. Streaming uses `assistant/live-chunk` and attempt identities, including final-message deduplication. Surface replacements use `startSeq`/`endSeq`; first-class tool messages carry `toolCallId` and `isError`. Failed model selections propagate `RemoteResult` errors.
- **HTTP:** asset and properties routes declare buffered request bodies. Plugin RPC now uses an exact, owner-only `POST /api/video-director` route behind DSH's browser authentication. Route disposal is owned explicitly by the plugin.
- **Dependencies:** old DSH MCP client binaries were removed. The optional ComfyUI MCP entry uses the matching client shipped with the host. Cordis/Schemastery versions match rc.2; session and model interfaces now come from the published host type declarations.

The RPC change also avoids a reproduced rc.2 issue: `connection.rpc.handle()` captures a provider Context that cannot access `webServer` in an ordinary scoped composition, even when the consumer declares that dependency. The exact Fetch route uses a supported public API. External scripts calling the former `/video-director/<endpoint>` URL must update to the envelope below; internal canvas tools still call the unchanged host RPC directly.

```js
// Browser Connection client handles correlation and response validation.
ctx.connection.rpc.call('/api', 'video-director', {
  endpoint: 'projects/list',
  payload: {},
})
```

## Validation

- `npm run check`: build, TypeScript against rc.2 declarations, and **524/524** plugin tests passed.
- `npm run check:dsh -- --source <rc.2-checkout> --runtime <isolated-npm-prefix>`: **14/14** integration checks passed against the exact upstream source and published runtime. These cover real Session retention/release, stale readiness, submission ownership, native pending attachments, inbox deduplication, streaming settlement, compaction, tool failures, model-selection failures, scoped RPC admission/unload, persistent settings/restart, legacy settings import, and HTTP GET/HEAD/Range/properties.
- Full rc.2 web profile in a disposable home: plugin discovery and launcher, project creation, save, new conversation, project chat/model directory, native model selection, and recovery after browser/bundle reload.

The tests use synthetic provider responses and disposable data. They do not certify paid generation, a live ComfyUI MCP server, or migration of an existing production Session log. The optional MCP entry stays disabled by default. Existing provider/workflow tests remain part of the full suite.

Reproduce the integration checks without updating the active DSH installation:

```sh
pnpm install --frozen-lockfile
npm run check
vd_rc_check=$(mktemp -d)
git clone --depth 1 --branch dsh-v0.2.1-rc.2 \
  https://github.com/deepseek-ai/deepseek-harness.git "$vd_rc_check/source"
npm install --prefix "$vd_rc_check/runtime" --save-exact --ignore-scripts \
  @deepseek-ai/dsh@0.2.1-rc.2 zustand@4.5.7 immer@10.2.0
npm run check:dsh -- --source "$vd_rc_check/source" --runtime "$vd_rc_check/runtime"
```

Zustand and Immer are needed to bundle the upstream client source for the contract tests; the published browser bundle already contains its runtime dependencies.

## Trial deployment

1. Keep the active alpha.3 runtime/profile and the baseline tag available. Build this branch and install the candidate into a **separate** runtime directory and `DSH_HOME`. For the npm CLI trial, place the temporary home under its installation prefix, e.g. `<candidate>/home` alongside `<candidate>/node_modules`.
2. Use a disposable working directory and an explicit absolute `video-director.config.dataDir`. Changing only `DSH_HOME` does not isolate the plugin's relative default `./.dsh-video-director` folder. Do not copy an existing `.video-director-storage.json` locator pointing to production data.
3. Install the built plugin into that candidate's web profile using its CLI: `dsh plugin --profile web add "file:/absolute/path/to/DeepSeek-Harness-Video-Director"`. Launch that same CLI and home. Confirm the loaded host and plugin both report rc.2 before opening data.
4. Exercise creating/saving/reopening a project, switching projects, starting a new conversation, model selection, a provider edit followed by restart, and media preview/seeking. Then test the providers and workflows you actually use with disposable inputs.

The isolated npm CLI also reproduced an upstream resolution failure for `@deepseek-ai/dsh-llm` when `DSH_HOME` was a sibling of the install prefix, including **without this plugin installed**. Placing the trial home under the prefix resolved it. This is separate from the plugin migration and may depend on installation layout. Source-checkout launches have a different resolution environment.

## Existing profiles and data

Before the first rc.2 launch against existing data, stop both runtimes and back up the entire DSH home, relevant profiles/patch layers, the actual Video Director storage folder, and its storage locator. Keep the backup outside the folders being tested. Never run old and new hosts against the same writable data at the same time.

DSH changed its Session log format from 0 to 4. Its built-in migrations create newer generations when writing migrated history; the highest generation takes precedence. Restoring only the plugin tag is therefore insufficient for a reliable downgrade. Test representative copied sessions first, then adopt the candidate deliberately.

DSH's settings service imports legacy `$DSH_HOME/settings.yaml` into live profile Config after the Loader settles, and renames the original to `settings.yaml.imported`. The migrated plugin must already be present for this import. The normal section ID `video-director` maps directly to the default plugin entry.

For a custom entry ID, transfer that section's `providerOverrides` and `minimaxH3LicenseAccepted` to the matching profile patch entry before the first import. If rc.2 was previously launched without the migrated plugin, inspect its warnings and `settings.yaml.imported`: rejected sections are not retried automatically. Merge only the missing plugin fields into the intended entry. Do not reset unrelated settings or duplicate raw secrets when a `!!js` environment expression already supplies them.

The plugin's project/asset schemas are unchanged by this migration. Preserve each project's `sessionId`; never regenerate IDs to make an unavailable history appear valid. Missing history is reported explicitly, and **New conversation** creates a new binding only at the user's request.

### Linked session titles

Workflow names now propagate to their linked dsh sessions after the name is persisted, including background renames, Save, undo/redo, and Discard. On startup, the client also reconciles existing session titles with effective workflow names (including persisted drafts), matching by `sessionId`. Missing sessions are skipped rather than recreated. Renames are ordered per session, and a failed title write reports a warning without retrying an already committed workflow write; retry the rename or reopen the plugin after connectivity returns.

Reconciliation uses project name/link summaries and the session title catalog, followed by dsh's explicit rename API. It does not generate titles with a model or submit workflow content. Synthetic regression coverage is in `test/project-drafts.test.js`.

## Rollback

Stop the candidate, restore the **matching pre-upgrade DSH home and plugin data backup**, and run DSH `0.1.2-alpha.3` with the plugin at `dsh-v0.1.2-alpha.3`. Reinstall that plugin revision's dependencies and rebuild it. For a disposable trial, discard the candidate home and data; the active installation needs no restoration.

The tag and migration branch are local until explicitly pushed. No global CLI update or production data migration is part of the code change.

Sources: [rc.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), [session ownership](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/contract/sessions.ts), [settings import and mutation](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/settings/settings/src/index.ts), [Connection routes](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts).
