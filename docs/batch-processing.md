# Batch processing

Add **Batch Input** from Inputs and **Batch Output** from Outputs in the node menu:

```text
Batch Input → Prompt / Reference input on a workflow node → Batch Output
```

Batch Input's **Run Batch** button runs the whole vd-workflow once per case, sequentially. The main **Run All** action uses the Batch Input range too. Only one unfrozen Batch Input is allowed in that workflow; other frozen batch inputs may supply an existing static payload. A direct Batch Input → Batch Output connection can collect text or imported assets without a remote job.

## Inputs and indices

- Text mode takes one nonempty line per case and preserves the line's whitespace.
- Files mode accepts multiple UTF-8 text, image, audio, or video files. **Choose folder** selects a folder on the computer running the browser, not a path on the Harness host.
- Set the filename regex and Include subfolders before importing a folder to avoid uploading excluded files. Regexes use JavaScript Unicode syntax without slash delimiters, match relative paths, and are case-sensitive. For example, `\.(png|jpe?g)$`. Browser matching runs in a worker with a timeout. Unsupported non-media files in folders are ignored; invalid text files report an error.
- Media files are copied into immutable project assets; text is captured in the manifest. Changing or deleting the originals cannot change a queued batch.
- File lists preserve input order; folders default to natural filename order (`2.png` before `10.png`). Matching and sorting happen before index assignment. The preview shows the resulting order; excluded range rows are dimmed.
- Indices start at **1**. Start and end are both inclusive. An empty end means the last match. A batch accepts up to **1,000 matched cases**. Changing filters after import only filters the imported files; choose the folder again to include files excluded during import.

Each submission captures its graph, inputs, range, frozen results, and seed allocation. Canvas edits affect future submissions. The case index advances only after its result record has been saved. Independent stages may execute concurrently within a case; different cases never overlap.

## FROZEN and seeds

Frozen nodes reuse their captured outputs and submit no jobs. Missing required frozen outputs fail preflight. Batch Input shows a warning when a frozen downstream node blocks propagation of changing inputs. Frozen Batch Input cannot start or advance. Freezing Batch Output captures the displayed case; later case results remain in batch history.

Seeds follow each executable media node's policy:

| Policy | Per-case seed |
| --- | --- |
| Fixed | Captured base seed |
| Increment | Base + offset from the original start index |
| Decrement | Base − offset from the original start index |
| Randomize | One allocated seed per case and node, persisted before submission |

An unspecified base is allocated once for the batch. Negative or unsafe-integer seeds fail preflight; batches do not silently wrap them. A retry reuses its original seed and input. Failed cases retain their allocated slot even when Continue is selected. The actual provider seed is retained with results when the provider supports it. The next editable seed is updated from completed executions only, and only if the user has not changed the captured settings. Frozen nodes never update their seeds.

Legacy **Repeat Count** remains available for workflows without Batch Input and retains its existing seed-offset behavior.

## Preview, save, and retry

Batch Output has a run selector, an index selector, previous/next buttons, and an optional Follow current case mode. Expand Preview input to compare the captured input with the output. Failed, pending, and empty cases keep their index. Multiple output artifacts keep their port and ordinal; identical outputs from separate cases are not deduplicated.

**Save selected case** and **Save all cases** download an uncompressed TAR archive containing indexed artifact files and `manifest.json`. The manifest includes case status, input identity, seeds, public job receipts, and output mappings. A failed export can be retried without rerunning generation. Browser exports are limited to 512 MiB of artifact bytes per archive; save individual cases for larger batches. Output bytes remain in project storage regardless of download success.

The default error policy stops at the failed case. Continue records the failed row and moves on. **Resume / retry failed** skips completed cases and retries failed/cancelled cases plus pending cases from the original submission snapshot. A retried case runs its whole workflow again; earlier failed attempt receipts are retained on disk. Completed cases are immutable.

Cancellation targets the batch's child jobs and waits for remote cancellation cleanup before releasing the workflow queue. If cancellation cannot be confirmed, the batch fails and automatic retry is blocked.

## Persistence and scheduling

The DSH Host persists and schedules entire batches globally across workflows and browser tabs. **The browser can be closed after submission**; dependency stages, triggers, case progression and provider cleanup continue on the backend. Keep DSH and the computer running. Browser reload simply reconnects to stored progress. Host restart resumes batches that were still queued; an interrupted active batch is marked failed to avoid duplicate provider submissions. Cancel an unfinished historical batch before attempting Resume. A case left running has uncertain submission state and is blocked from automatic retry; inspect its retained jobs and backend prompt IDs before deciding to start a new batch.

Each batch has a parent vd-run (`kind: "batch"`); each case attempt has its own child vd-run with `batchRunId`, `caseId`, and one-based `caseIndex`. This metadata is separate from legacy `batchIndex`/`batchSize` repeat metadata. The Host verifies job metadata against its child vd-run.

Records live under the existing project runs directory:

```text
projects/<project-id>/runs/<batch-id>.json
projects/<project-id>/runs/<batch-id>.snapshot.json
projects/<project-id>/runs/<batch-id>/manifest.json
projects/<project-id>/runs/<batch-id>/<case-index>.json
projects/<project-id>/runs/<batch-id>/<case-index>.attempt-<attempt>.json
```

The immutable manifest and per-case records are separate from the latest-100-jobs project history and the deduplicated gallery. The authenticated `batch-cases/init`, `batch-cases/list`, and `batch-cases/save` RPCs validate indices, identity, assets, and attempt ownership. Case writes complete before the next case starts. A storage failure stops scheduling and leaves the last durable case record available for inspection.
