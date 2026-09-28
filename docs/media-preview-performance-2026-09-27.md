# Playback and Safari performance investigation — 2026-09-27

Changes are on `uncensored`. All reproduction media were generated locally with FFmpeg: eight seconds of color bars with a 440 Hz tone (H.264/AAC MP4), and an eight-second 660 Hz WAV. No personal projects, media, assets index, provider endpoints, or Safari profile were accessed. The separate test server creates its own temporary store.

## Findings and changes

1. **Workflow observation multiplied polling.** Every submitted workflow promise ran its own 250 ms refresh loop, alongside the controller's 1,400 ms timer and the Jobs drawer's 1,400 ms interval. In-flight deduplication helped only when requests overlapped. Fast replies allowed the loops to run independently; each refresh made three RPC calls and could republish the entire studio. `DirectorController.watchVdRuns()` now shares one 1,400 ms observer across submitted runs and drawers. Waiting promises consume its results instead of starting polling loops. Errors still retry, disposal settles waiters, and closing the drawer does not stop observation of active Host runs.

2. **Unchanged responses still caused UI work.** Poll results created new arrays and notified subscribers even when nothing changed. Refresh now reuses unchanged run/job/project rows and skips publishing identical snapshots. Intermediate progress updates preserve cached sink nodes; status and timing transitions still propagate to them. Project summaries no longer acquire full graphs/jobs during updates, and jobs-only updates no longer rewrite browser draft storage. The per-second elapsed clock now updates small timing components instead of rerendering the entire Jobs drawer.

3. **Offscreen video thumbnails loaded eagerly.** Canvas outputs, job history, gallery cards, and reference thumbnails used `preload="metadata"` regardless of visibility. Metadata preload still requests media and initializes its playback pipeline; it is not a free placeholder. The shared `VideoThumbnail` observer now attaches a source only near the viewport, then removes the source and resets the media pipeline when hidden or unmounted. Full previews remain independent. [Apple's media preload documentation](https://developer.apple.com/documentation/webkitjs/htmlmediaelement/1633059-preload) describes the metadata behavior.

4. **Valid media ranges were rejected.** `bytes=2-9999999` on a ten-byte asset returned `416`. The server now clamps a satisfiable range to EOF and returns `206` with accurate length/range headers; genuinely invalid or unsatisfiable ranges remain `416`. Open-ended, suffix, and Safari-style two-byte probe requests are covered. File streams now receive the request's abort signal so abandoned media requests stop reading. This follows [RFC 9110 §14.1.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.1.2).

5. **Metadata effects followed object identity.** Passing an equivalent asset in successive snapshots restarted the metadata request, potentially repeating or interrupting `ffprobe`. The effect now follows immutable asset identity, URL, hash, MIME type, and media kind. Five equivalent rerenders previously made six metadata requests; they now make one and retain the same player element.

The range and metadata failures are confirmed defects. Excess polling and eager thumbnail loading are confirmed sources of avoidable work. The exact native Safari “application not responding” event and the supplied clip's black-player state were **not** reproduced with the small synthetic clip; it also played on the baseline. These findings explain plausible contributing paths, not a proven single cause for that specific session. Codec compatibility, generator load on the same machine, and unusually large histories still require a separate profile if the symptoms persist.

## Measurements

WebKit 26.6 via Playwright, local HTTP, development React with Profiler enabled. The fixture mounted 80 cached preview nodes (40 video, 40 audio), a simulated running generator, and 80 completed job records. Cached nodes were frozen for repeatability. Measurements below used the same viewport with one video inspector open and the Jobs drawer closed. Host fixtures and client snapshots are separately cloned across the simulated RPC boundary, and node progress advanced in both samples. No real generation service was invoked.

| Metric | Before | After |
| --- | ---: | ---: |
| RPC calls during five seconds | 63 | 9 |
| Controller notifications during five seconds | 63 | 9 |
| React commits during five seconds | 42 | 6 |
| React Profiler render duration during five seconds | 293 ms | 47 ms |
| Video elements with an attached source | 41 | 3 |
| Media/metadata requests through initial inspection | 83 | 7 |
| Sum of advertised media response body lengths | 14,750,406 bytes | 1,079,298 bytes |

These are one controlled sample, not overall Safari CPU or a production benchmark. Response lengths are server counters, not a packet capture. Native Safari and Playwright WebKit are different builds. The post-change audio and video checks both advanced through multiple live updates, retained their player element, and successfully sought to five seconds without media errors; the audio waveform also rendered.

## UI behavior

- **Elapsed Time** appears directly below **Submitted**. It starts at execution, excluding queue wait; queued or cancelled-before-start runs show zero. Running values update once per second, and terminal values stop at the recorded end time. Legacy records use available start/end timestamps.
- Completed job cards append the fixed execution duration to the datetime line, for example `completed at 20260928-00:18:42 (1 min 2 s)`.
- **Cancel Job** is first in the job card menu and routes to the existing workflow or individual-job cancellation method, including jobs in another workflow. Finished jobs and cancellation already in progress disable the action. Existing provider cancellation safeguards and the inspector's cancel action remain in effect. English and Chinese labels are included.

## Reproduce and validate

```sh
pnpm run check
node --test test/run-observation.test.js test/artifact-preview.test.js test/job-drawer.test.js test/project-store.test.js
node scripts/debug/media-preview.mjs
# Compare the original committed client against the same synthetic fixture:
VD_SMOKE_BASELINE=4964977426229c2760cf519197b40a0ec6181825 node scripts/debug/media-preview.mjs
```

The debug server prints its temporary URL and directory. Open that URL in an isolated browser; `?count=80` controls the cached preview count. It uses the real studio components, controller observation path, asset responses, and metadata probe, with synthetic RPC responses for progress/cancellation. `window.metrics` exposes RPC, notification, commit, and render counters; `/metrics` lists media request ranges/statuses/lengths. Use a fresh page/server for each comparison and wait for initial layout before sampling. Stop with Ctrl-C to remove the temporary store.

The regression command initially failed on all four targeted checks: oversized range returned `416`, duplicate observers polled nine times in about one second, an unchanged poll emitted a notification, and equivalent previews repeated metadata reads. Those checks now pass. `pnpm run check` passed build, typecheck, and 466 tests. After preserving sink status/timing propagation and adding observer retry/lifecycle coverage, the 105 focused controller/workflow/observation tests also passed. A final regression additionally confirmed that unsaved canvas node counts do not trigger unchanged-poll notifications; all five observation tests and the final build/typecheck passed.

The bundle is rebuilt locally. Restart the DSH host after current jobs finish, then reload Safari to load both the server and client changes; this investigation did not restart the live host.

## Job history pagination follow-up (2026-09-28)

The drawer now starts with the newest **10 grouped records**, fetched through `jobs/history`, and requests the next 10 on reaching the scroll bottom. A keyboard-accessible **Load 10 more** button also works when the viewport is too tall to scroll. The count shows loaded records, with `+` while older pages remain.

`JobHistoryCache` belongs to the tab's `DirectorController`. It retains loaded pages per workflow filter across drawer close/reopen and filter changes. It never serializes those pages to localStorage, IndexedDB, or browser HTTP cache. A new controller in a fresh tab or after reload begins with 10 records. Closing the drawer releases its polling subscription; it does not evict its history data. Deletions remove matching cached cards.

The Host groups runs and standalone jobs **before** applying the limit, omitting hidden records and batch parents represented by case cards. A `(submitted, id)` cursor gives a deterministic order and avoids offset shifts when newer jobs arrive or earlier jobs are deleted. Active observation remains separate from history pagination: it requests active/known runs, current-canvas job state and known jobs, instead of returning every workflow's historical records. Existing unscoped list RPCs remain compatible. Modern run cards use their preview summaries; full receipts remain available through Inspect/Download.

While the drawer is open, a bounded head check picks up new records and follows further pages only when needed to connect new arrivals to the cached head. This also catches submissions sharing a timestamp. Existing pages remain in memory and unchanged records preserve object identity. Overlapping scroll requests coalesce, errors keep loaded rows and the cursor for retry, and a page failure cannot block workflow completion monitoring.

The final `pnpm run check` passed build, typecheck and **477 tests**. Validation covers initial/page limits, concurrent loads, retained pages, fresh controllers, filters, exhaustion, retries, late replies after disposal, new submissions, deletions, tied timestamps, completed durations and actions on paged offscreen runs. An isolated WebKit browser with synthetic media showed **10 → 20** cards after scrolling, **20** after closing/reopening, and **10** in a separate new tab. No user assets or live Safari profile were accessed.

## Further optimization opportunities

The Host still scans on-disk run summaries to select a page, and observation revalidates known records and project summaries. An indexed history catalog with a revision cursor or push subscription would reduce disk reads and server JSON work for very large histories. For many simultaneously visible videos (for example, a zoomed-out canvas), cached still posters with bounded extraction would further reduce native media pipelines. Those changes should be guided by Host request timings and a browser performance recording using a synthetic workload. They are not implemented in this patch.
