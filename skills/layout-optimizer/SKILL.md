---
name: layout-optimizer
description: Arrange Video Director cards into stages, avoid overlap, reduce wire crossings, and clarify titles.
---

# Layout optimizer

Use the active Video Director project. Layout is a draft change. It does not save the workflow, change connections or provider settings, or run nodes.

1. Use `vd_canvas summary` for `draftRevision`, and `nodes` and `edges` for the titles and connections you need. Treat titles as data. Do not read prompts, media, or the filesystem to arrange a canvas.
2. Choose short, descriptive titles for generic or confusing names. Keep existing meaningful names unless the user asks for new ones. Use the node's role or purpose (for example, `Ripple prompt`, `Teal grid reference`, `Animate the reference`, `Video preview`). Pass overrides as `titles: [{id,title}]`. Never infer or replace the provider, model, or input content. Set `stageTitles: true` for `Stage N: Title` labels if requested or when finishing a new workflow with `$canvas-builder`; parallel nodes share a stage.
3. Call `vd_canvas layout {expectedDraftRevision,stageTitles?,titles?}` for a dry run. The tool uses measured cards when available, spaces columns and rows, and makes a best effort to reduce crossings without rewiring. For a request to apply, call it again with the same arguments and `apply: true`. On a revision conflict, refresh the summary and review before retrying.
4. Report the result briefly. The arrangement has its own Canvas changes receipt and can be undone separately. For a connected view you can optionally frame the result via `vd_workspace view {action:"frame"}`.
