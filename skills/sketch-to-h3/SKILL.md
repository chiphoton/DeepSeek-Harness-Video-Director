---
name: sketch-to-h3
description: Build a canvas that turns a sketch and short brief into a ComfyUI reference, an Ollama prompt, and a MiniMax H3 video.
---

# Sketch to H3

On an empty canvas, call `vd_canvas summary`, then `recipe` with `recipe:"sketch-to-h3"`, `expectedDraftRevision`, a sketch attachment `alias` or project `assetId`, and a short `brief`. If there is no attachment alias, use `assets` once to find the existing sketch. Optionally set `direction`, `duration` (default 5 seconds), and a requested vision Ollama `modelId`. Set `vramHandoffs:true` only for an authorized shared accelerator with tight memory.

For a build request, call the recipe once with `apply:true`. It creates the switchable MiniMax H3 Video card with Reference to Video selected, validates all wiring, and returns the counts and stages. For a plan-only request, omit `apply`. Stop after a successful result; no extra graph reads or validation are needed. Keep changes in the draft unless the user explicitly asks to save. If the canvas already has nodes, adapt only the requested branch with `$canvas-builder`.

Run only when requested and content access permits it. After the exact run completes, prepare a six-frame `vd_canvas media` contact sheet (`operation:"video-contact-sheet"`) and use a local vision model to review it beside the generated reference. Keep the original sketch, reference, and video distinct.
