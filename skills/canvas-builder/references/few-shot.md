# Workflow patterns

These are reduced patterns from the bundled Video Director examples. Choose installed node types and models from the current workflow's catalogs and inspect its actual handles.

## canvas-demo

Sketch Input → Image Processing → image Preview.
Image Processing → Prompt Enhancer reference input.
Prompt Enhancer → H3 Prompt field and text Preview.
Image Processing → H3 media reference input.
H3 → video Preview.

The Prompt and Reference links go to different ports on the same video node. Use a media-capable video mode for the Reference port. Branch the image directly to both consumers when they need the same image.

## all-in-one

Image generation → Image Edit → Prompt Enhancer → Video Generation.
Branch image, edited image, enhanced text, and video to distinct Preview nodes. Route the edited image into the enhancer's media input and the enhanced text into the video's Prompt field.

When a shared accelerator needs model release between stages, a VRAM Trigger can order those stages through Flow ports. Keep the data links for the prompt and media. Add resource handoffs only when the brief and deployment call for them.
