# DSH 0.2.1 RC compatibility investigation

Audit date: 2026-10-17 (Asia/Singapore).

**Historical baseline assessment:** this report describes the unmodified `dd33d90` plugin, now tagged `dsh-v0.1.2-alpha.3`. The subsequent migration is implemented on `codex/dsh-0.2.1-rc.2`; see the [implementation, validation, and upgrade guide](dsh-0.2.1-rc.2-migration.md). The findings and line numbers below refer to the baseline.

This concerns the package `dsh-video-director` in this repository, including its Media Editor, canvas, and project chat. Its package manifest says `0.1.2`; that is a separate version from the DSH host. The plugin checkout's latest commit is labelled `v0.5.0`, so this audit identifies the code by commit as well as by its manifest version.

## Decision

**The current plugin is not compatible with RC.2 as a drop-in upgrade.** Project opening, provider settings, asset serving, and chat need migration. Keep the existing host until these integrations are ported and tested. Passing the plugin's existing tests alone cannot certify a new host: its DSH interfaces are declared locally in `src/client/types.ts`, and the host integration tests provide test doubles for those interfaces.

The intended target is **`@deepseek-ai/dsh@0.2.1-rc.2`**, tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317`. RC.2 was published on 2026-10-17; it follows RC.1 (`1600d8a1e140dcde43a1a0941940a0480712c011`) released the same day. RC.1 aggregates changes since `0.2.0-rc.2`; RC.2 adds DeepSeek V4.1 Flash and Search/Fetch integration. Both are prereleases. The npm registry also serves an exact RC.2 package. [RC.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), [RC.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1), [published RC.2 manifest](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.1-rc.2).

Local comparison points supplied by the workspace audit:

| Component | Baseline |
|---|---|
| DSH checkout | `dsh-v0.1.2-alpha.3`, `dd6322d604e00eec1ba5e0c8541159906a21094a` |
| Video Director checkout | `dd33d90`, package `dsh-video-director@0.1.2` |
| Current MCP dependency | `@deepseek-ai/dsh-mcp-client@0.1.2-alpha.3` |
| Investigated successor | `dsh-v0.2.1-rc.2`, `687f282e8625c6b8d11ff58211a90524be2e4317` |

This audit ran the current plugin's checks and isolated probes compiled from the exact RC.2 source. Eight regressions were reproduced; three further probes established limited compatible behavior. A full RC.2 Web application and migration of the user's existing data were not exercised. No production runtime, source, dependency manifest, lockfile, or live data was upgraded.

## Reproduced incompatibilities

The probes test the unmodified plugin against RC.2 implementations, with local fixtures for remotes and providers. Later chat probes bypass the already-proven navigation failure so each subsequent issue can be observed independently.

| Priority | Plugin integration | Reproduced result | Required change |
|---|---|---|---|
| Block adoption | `chat-source.ts:672`, project creation/loading in `controller.ts` | `this.ctx.sessions.open is not a function`; `sessions.list.current` is also absent | Own a retained Session reference; separate that ownership from native UI navigation. |
| Block adoption | `src/index.js:84` | The settings callback calls nonexistent `settings.installSection()` | Move editable settings into the plugin's volatile Config fields and adapt the provider-settings reader/writer. |
| Block adoption | `src/index.js:64` and `:69` | Actual HTTP GET and HEAD return 500: `Request with GET/HEAD method cannot have body.` | Add `requestBody: 'buffered'` to both asset and media-properties registrations. In the isolated probe this restored GET/HEAD to 200. |
| Required chat migration | `chat-source.ts:555` | Even a text-only send creates an RC.2 pending submission with `attachments === undefined` | Replace `images` with the discriminated `attachments` array. Native pending-message rendering assumes that array exists. |
| Required chat migration | `chat-source.ts:373` | Live text produced by RC.2's real stream assembler renders no messages | Consume `assistant/live-chunk`, including attempt settlement and replacement behavior. |
| Required chat migration | `chat-source.ts:402` | An accepted message exists in the RC.2 inbox projection but is absent from the plugin chat | Subscribe to `session.projections.faceOf('inbox')`; fold the `next-turn` and `next-step` queues. |
| Required history migration | `chat-source.ts:185` | The chat displays both the superseded response and its replacement | Read `surfaceOp.startSeq` / `endSeq` instead of `start` / `end`. |
| Required result migration | `chat-source.ts:228` | A tool result created by RC.2 with `isError: true` displays as complete when envelope error metadata is absent | Read `message.isError`; accept the first-class tool-role message structure. Call correlation still works for RC.2's standard `source.callId`. |

The settings reproduction invokes the plugin's settings callback with the real RC.2 service. In a complete Cordis composition that callback belongs to an optional child injection; this evidence establishes that settings integration fails, not that every other host registration necessarily stops.

Primary evidence: [Session ownership API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/client/contract/sessions.ts), [Settings service](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/settings/settings/src/index.ts), [HTTP bridge](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/http-bridge.ts), [submission contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/client/contract/session.ts), [live events](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/client/contract/events.ts), [inbox observation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/client/sessions/session.ts), [surface operations](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/session/src/types.ts), [tool message factory](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/llm/llm/src/message.ts).

## Packaging and configuration findings

| Area | Assessment | Evidence and action |
|---|---|---|
| Bundle declaration | Compatible in shape | `dsh.bundle.patch: "./cordis.patch.yml"`, a top-level patch list, and `insert` rows are still the supported format. The current manifest and patch use this shape. [RC.2 profile loader](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/boot/app-boot/src/profile.ts) |
| Node version | No declared range change | The RC.2 root and this plugin both declare `^22.19.0 || >=24.0.0`. [RC.2 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/package.json), [local manifest](../package.json) |
| Plugin compatibility declaration | Missing safeguard, not a rejection by itself | RC.2 checks an own `engines.dsh` first; otherwise it checks all `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers, with prereleases included in range matching. This plugin has no `engines.dsh` and no DSH peer dependencies, so its root manifest is admitted without proving runtime compatibility. Add a tested host range after porting. [compatibility implementation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/boot/app-boot/src/plugin-compatibility.ts) |
| Install command | Current README syntax is already valid | `dsh plugin --profile web add ...` places `--profile` before forwarded package-manager arguments. Scripts using `dsh plugin add ... --profile web` must change. [official option-placement migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.1-alpha.1/plugin-option-placement/guide.md) |
| Subpath plugin metadata | No observed impact | The change affects plugins exporting a separate `<subpath>/package.json`. This plugin mounts its package root and exports only the root package manifest. Its `./client` export is a client entry, not a separately configured subpath plugin. [official metadata migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.0-rc.2/subpath-plugin-display-manifest/guide.md) |
| Reinstall/update with HMR | Operational migration | RC.2 refuses `pluginManager.installBundle()` over an installed package while HMR runs. Its documented flow is remove, then install; this specifically concerns the manager API/tool and should not be generalized to every CLI package-manager invocation. [official update migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.1-alpha.2/plugin-install-over-installed/guide.md) |

The official RC.1 note also announces input statistics extension changes from `stats` to `activity` / `usage`. Video Director registers `sidebar.footer.action` and `shell.overlay`, rather than replacing `stats`, so that announcement alone is not a blocker. The exact current slots and their rendered behavior still belong in the integration smoke test. [local client entry](../src/client/index.tsx), [RC.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1).

## MCP dependency and provider implications

The old MCP package's published peers require `^0.1.2-alpha.3` for DSH services, including the retired `dsh-invariants` package. RC.2 is outside that range. If the enabled MCP row resolves to this old copy, RC.2's compatibility preflight will disable/refuse that row; bypassing the check does not adapt the old code. The patch currently sets `video-director-comfyui-mcp` to `disabled: true`, and preflight skips such disabled ordinary rows. Therefore this is a conditional blocker for the MCP transport, not evidence that the disabled row prevents all default canvas operation. [old published MCP manifest](https://registry.npmjs.org/@deepseek-ai/dsh-mcp-client/0.1.2-alpha.3), [RC.2 preflight](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/boot/app-boot/src/compatibility-preflight.ts), [local bundle patch](../cordis.patch.yml).

For the port, remove the pinned old implementation from `dependencies` and resolve the MCP client supplied by the supported DSH host, or declare an explicitly matching peer if the package needs that dependency contract. The official MCP-bundle template inserts the already installed MCP client and carries no MCP runtime dependency; the published RC.2 CLI already depends on `dsh-mcp-client@0.2.1-rc.2`. Recreate the isolated dependency installation to ensure a stale local copy cannot shadow the intended package. [official MCP bundle guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/agent-preset/skills/cordis-plugin-development/references/mcp-bundle.md), [template manifest](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/preset/agent-preset/skills/cordis-plugin-development/templates/mcp/package.json), [RC.2 CLI manifest](https://registry.npmjs.org/@deepseek-ai/dsh/0.2.1-rc.2).

The configured fields `serverName`, `transport: stdio`, `command`, `args`, and `env` remain accepted in RC.2. Public names remain `mcp__<serverName>__<tool>`, so `mcp__comfyui__call_tool` is still a plausible configured identity if that server actually publishes `call_tool`. RC.2 uses `@modelcontextprotocol/client@2.2.0`, while the old package used `@modelcontextprotocol/sdk@^1.12.0`. Negotiation now uses a temporary stdio probe process, and validates protocol results/output schemas through the SDK. This warrants a harmless mock-server discovery/call/cancel test; no live ComfyUI job was needed for this research. [RC.2 MCP implementation and contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/mcp/mcp-client/README.md), [RC.2 published MCP manifest](https://registry.npmjs.org/@deepseek-ai/dsh-mcp-client/0.2.1-rc.2).

## Migration implementation guide

These are proposed changes, not applied patches or a certified migrated release.

### 1. Replace Session opening with explicit ownership

Use `sessions.retain(sessionId, { source: 'videoDirector' })` for the active project chat and release the reference when switching projects or disposing the chat. Declare `videoDirector` in the exported `SessionReferenceSourceMap` when using upstream TypeScript types. Await `reference.ready` before operations that require loaded history; handle a late completion after the user switches projects. `sessions.create()` now returns a catalogued ID without retaining its binding. A borrowed `sessions.binding()` is only available while some owner retains that generation.

Use `ctx.uiWorkspace.openSession(sessionId)` when the intended action also navigates the native conversation. Keep the plugin's selected project/session explicit instead of reading the removed `sessions.list.current`. Add the corresponding client package/service injection if using `uiWorkspace`. Acquire the reference before resolving the model directory, because that service requires a live Session scope. Update all creation, import, reopen, new-chat, and rename paths in [controller.ts](../src/client/controller.ts) as well as [chat-source.ts](../src/client/chat-source.ts). [navigation API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-workspace/src/client/navigation.ts), [model-directory scope requirement](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-model-selection/src/client/service.ts).

### 2. Port persisted provider settings

The new Settings service edits live fields from the plugin's exported Config, identified by its profile entry ID. Move `providerOverrides` into Config and declare it as a volatile dictionary; make the editable license preference volatile as well. Read the values with `.get()` and refresh consumers on `loader/volatile-update`. The current Config does not contain `providerOverrides` at all, so simply deleting the `installSection()` call would not restore editing.

Preserve `role('secret')` on API-key fields. Adapt [provider-settings.js](../src/provider-settings.js) to write through `settings.mutate(entryId, operations, expectedRevision?)` and to read the live Config references. The shipped entry ID is `video-director`; derive the actual owning entry ID if multiple/custom instances are supported. For the plugin-owned UI, optionally register `settings.configure({ auto: false }, ctx.fiber)` through an effect in the optional settings injection. Align Schemastery/Cordis with the target runtime's APIs: RC.2 ships `3.18.5` / `4.0.5`; the existing installed Schemastery is older.

Rehearse the legacy `settings.yaml` import only after the new fields exist. RC.2 renames that file to `settings.yaml.imported` before importing sections, and logs rejected sections rather than automatically retrying them on each startup. Keep a backup of the original provider overrides and verify secret preservation and restart behavior. [official live-settings cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/cookbook/adding-a-settings-card.md), [settings and legacy import](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/settings/settings/README.md).

### 3. Declare asset-route body handling

Add the explicit field to both registrations in [src/index.js](../src/index.js):

```js
ctx.connection.fetch.register({
  path: asset.url,
  methods: ['GET', 'HEAD'],
  requestBody: 'buffered',
  fetch: request => host.store.assetResponse(asset.id, request),
})
```

Apply the same field to the `/properties` GET route. RC.2's HTTP bridge selects streaming when the field is absent, then tries to construct a GET/HEAD Request with a body. Directly calling the route callback bypasses this failure, which is why the migration test must use the HTTP bridge. Range and property-response behavior still needs end-to-end verification. [route contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/src/rpc.ts).

### 4. Port chat submissions and event folding

For submission previews, replace the `images` property with:

```ts
attachments: previews.map(({ file, previewUrl }) => ({
  type: 'image' as const,
  value: { previewUrl, ...(file.name ? { name: file.name } : {}) },
}))
```

Pass `attachments: []` for text-only sends, and preserve request IDs, retirement callbacks, and preview-URL cleanup. The actual prompt's base64 image parts remain accepted; the preview/echo API is what changed. [submission attachment types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/client/contract/snapshot.ts), [prompt parts](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/types.ts).

Update the old `assistant/chunk` / `chunkrow/text-chunks` fold for `assistant/live-chunk`, using `attemptId` so retries and settled attempts are not merged incorrectly. Subscribe to the inbox projection for queued messages; deduplicate optimistic and admitted messages by their request identities. Update surface replacements to `startSeq` / `endSeq`. Read tool-result failure from `message.isError` as well as optional event error metadata, and use the new tool-role content structure. Standard `source.callId` is still populated, so call correlation is not independently broken in the reproduced case.

Also align model selection with `ModelDirectory.select(): Promise<RemoteResult<void>>` and check `result.ok`. This is an additional source-confirmed API change, not one of the eight reproduced regressions; the directory's error store may already display a failure even though the plugin currently assumes rejection-based error handling. [selection implementation](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-model-selection/src/client/directory.ts).

### 5. Update declarations and dependency checks

Replace unchecked local copies of DSH interfaces with target-version types or a deliberately versioned adapter. Include Host JavaScript in meaningful contract checks; current `tsconfig.json` limits checking to client/scripts and sets `checkJs: false`. Regenerate tests using RC.2 events and services, not exclusively the old mocks. After migration passes, declare a narrow tested `engines.dsh` range; start with exact `0.2.1-rc.2` if that is the only target tested. Handle the MCP dependency as described above. Do not claim support for both alpha.3 and RC.2 without a test matrix for both.

## Surfaces with positive evidence

- The real RC.2 Connection registry accepted the current `/video-director` custom RPC channel. Direct asset-handler invocation also worked, but the separate HTTP probe exposed the missing body-mode field above. Authentication/proxy behavior was not tested in a full application.
- The current `vd_canvas` definition registered and executed through RC.2's real `ToolRuntime`, using a local fixture host response. This verifies registration/execution plumbing, not model invocation, attachment persistence, paid generation, or every tool operation.
- The plugin's bundled ComfyUI skill registered in the real RC.2 `SkillRegistry`. Current sidebar/overlay contribution options were accepted by `SlotCore`; both slot names remain declared upstream. Visual rendering and browser module loading remain untested. [sidebar declaration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-sidebar/src/client/index.ts), [overlay declaration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/ui-layout/src/client/index.ts).

## State migration and rollback

RC.2 writes Session format **4**, while the installed alpha.3 belongs to format **0**. DSH provides a fixed historical migration chain. Read access prepares a migrated logical history in memory; write access verifies and publishes a current generation beside the original source. The highest canonical generation wins, and the retained predecessor files do not constitute automatic downgrade support. [RC.2 Session version](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/session/src/types.ts), [alpha.3 persistence record](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/persistence-changes/releases/dsh-v0.1.2-alpha.3.md), [JSONL persistence contract](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/session/session-persistence-jsonl/README.md).

Video Director stores its own project/workflow/assets data separately and binds a project to a DSH `sessionId`. Its default `dataDir` is relative to the process working directory. A saved `.video-director-storage.json` can redirect that directory elsewhere. Changing only `DSH_HOME` is therefore insufficient isolation: use a separate explicit plugin `dataDir`, and copy the actual data destination plus the pointer/configuration for a realistic rehearsal. Do not let two host versions write the same plugin store. [local storage implementation](../src/storage.js), [local host entry](../src/index.js), [local bundle defaults](../cordis.patch.yml).

Before adopting, preserve a stopped, consistent backup of both the DSH home/profile/session data and the actual Video Director storage. Rehearse on copies; open existing project conversations, verify history, resume with a harmless non-generation action, restart, and check the same `sessionId` bindings. For rollback, restore the entire matched pre-upgrade state and old runtime. Do not assume the old runtime can open a store after the new host has resumed its conversations. This is an operational recommendation derived from the documented generation selection rules, not a claim that migration has failed for this user's data.

Avoid using `--from-default-profile` as a repair command on an existing profile: the new behavior replaces the target directory, including its package dependencies and patch. [official profile-reset migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.1-alpha.2/from-default-profile-replaces-target/guide.md).

## Proposed migration sequence

1. Keep the current alpha.3 host in service. Port a separate plugin copy/branch against the exact RC.2 host and a fresh, explicit `DSH_HOME` and plugin `dataDir`.
2. Port Session ownership/navigation, live provider settings, and the asset-route body mode. Then port submissions, inbox display, result status, streaming, history replacement, and model selection using the implementation guide above.
3. Run integration checks with real RC.2 services and transport. Keep the existing provider HTTP behavior and local canvas formats unless independent tests demonstrate a need to change them.
4. Remove/replace the alpha.3 MCP dependency, refresh the isolated lock/install, and confirm the actual resolved MCP implementation is RC.2. Exercise the optional MCP row separately from the default direct ComfyUI path.
5. Once verified, declare a narrow tested host range. An initial declaration can be `"engines": { "node": "^22.19.0 || >=24.0.0", "dsh": "0.2.1-rc.2" }`. Expand only after testing additional versions; adding the declaration itself does not provide compatibility. [official engines migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.1-alpha.3/plugin-engines-dsh/guide.md).
6. Run the existing plugin checks, then an actual RC.2 Web smoke test: launcher/overlay, new project, text chat, image attachment, queueing/cancel, provider settings, asset GET/HEAD/range/properties, save/reopen, and tool error display. Use mock or local fixture providers before any paid generation.
7. Rehearse migration on copies of existing project and Session data, validate restart and rollback, then decide whether to adopt this prerelease.

## Official migration references

There is an official collection of focused upgrade guides, rather than a single complete Video Director migration guide. The relevant guides are linked beside the findings above. The full collection also includes JSONL plugin imports, working-directory changes, listener trust, tool presentation, subagents, and other integrations that may not apply to this plugin. [RC.2 upgrade-guide directory](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/docs/upgrade-guide).

For example, JSONL's default/class export changed to a namespace plugin; Video Director does not directly instantiate that persistence service, so this is background context rather than a demonstrated blocker here. [official JSONL plugin migration](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/docs/upgrade-guide/v0.2.1-alpha.1/jsonl-persistence-plugin/guide.md).

## Validation record

- Environment: Node `24.15.0`; pnpm `11.7.0`.
- `npm run check` passed: build, typecheck, **523 tests**, zero failures/skips. This validates the existing plugin tests, not RC.2 compatibility.
- `node --test compatibility.test.mjs` passed **11 diagnostic probes**: **eight intentionally assert the reproduced incompatible behavior**, and three check limited compatible plumbing. Passing these diagnostic assertions is not a passing upgrade certification.
- The probes bundle the exact RC.2 source, including vendored Cordis and Schemastery, with the plugin's unmodified integration code. RC services used include `ClientSessions`, `Session`, `ClientAssistantStream`, `SettingsForms`, `HostConnectionService`, the HTTP bridge, `ToolRuntime`, `SkillRegistry`, and `SlotCore`. Remote/model responses are fixtures; the HTTP test binds a temporary loopback port. The GET/HEAD repair was tested only in the probe.
- Primary-source release, registry, loader, MCP, and persistence inspection completed. Optional MCP negotiation, a complete Web/browser smoke test, and migration of copied real user data remain adoption gates.
- Scratch source, scripts and logs remain at `/tmp/dsh-compat-20261017.w9ENUH/`: `plugin-check.log`, `probe/build.mjs`, `probe/compatibility.test.mjs`, `probe/compatibility-test.log`, and `upstream/`. These are temporary audit artifacts, not a permanent CI suite. To repeat the completed probes while the directory exists, run `node build.mjs && node --test compatibility.test.mjs` from its `probe/` directory. The build uses the installed plugin's esbuild and the scratch dependencies; it also has a sibling copy of the RC.2 LLM manifest for the bundled attribution module's version lookup.
- The only repository addition from this investigation is this report. No active DSH installation, plugin manifest/lockfile, or live project/session data was changed. No paid model or video-generation request was made.
