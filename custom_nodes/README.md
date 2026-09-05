# vd-node definitions and comfyui-workflows

This repository directory holds Video Director JSON documents: `*.node.json` files contain built-in/legacy comfyui-workflow documents under `nodeData`; [`comfyui-basic-image.manifest.json`](./comfyui-basic-image.manifest.json) is a declarative v1 **vd-node pack**. These are distinct from Python **ComfyUI custom-node packages** installed in the ComfyUI server's own `custom_nodes/` directory. See the [terminology guide](../docs/TERMINOLOGY.md).

For an agent-executable dependency matrix and installation procedure, use the [installation runbook](../docs/INSTALL.md) or its [Simplified Chinese version](../docs/INSTALL_zh.md).

Video Director submits **API-format comfyui-workflows**: an object keyed by comfyui-node ID, where each comfyui-node has `class_type` and `inputs`. It does not execute ComfyUI editor-format JSON (`nodes`, `links`, layout metadata). Export **Save (API Format)** from ComfyUI, then pair that graph with explicit semantic bindings.

- [`comfyui-basic-image.node.json`](./comfyui-basic-image.node.json) is a normal checkpoint → sampler → image workflow. Replace the checkpoint name with one installed on your server.
- [`z-image-turbo.node.json`](./z-image-turbo.node.json) is a reference-free Z-Image Turbo text-to-image graph with primary width/height controls, live loader and KSampler selectors, and `PreviewImage` output.
- [`minimax-h3-t2v-turbo.node.json`](./minimax-h3-t2v-turbo.node.json) is a self-hosted MiniMax H3 Turbo text-to-video vd-node with synchronized audio.
- [`minimax-h3-audio-turbo.node.json`](./minimax-h3-audio-turbo.node.json) keeps the disposable visual latent at `32×32`, converts a user-facing duration to H3's frame grid, decodes the native audio stream, and writes it with `SaveAudioAdvanced`; it does not decode or save video.
- [`minimax-h3-audio-standard.node.json`](./minimax-h3-audio-standard.node.json) provides the matching Standard audio-only graph with the base model connected directly to a `KSamplerSelect`; it has no Turbo LoRA comfyui-node.

The three H3 vd-node definitions use filenames observed on the reference ComfyUI deployment at `127.0.0.1:8188`: `minimax_h3_fl2va_int8_convrot.safetensors`, `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`, the FP16 video and FP32 audio VAEs, and, for the Turbo graphs only, `minimax_h3_turbo_v4_step600_ema.safetensors`. These names are not universal API ids. Before running against another deployment, inspect its `UNETLoader`, `CLIPLoader`, `VAELoader`, and, when applicable, `MiniMaxH3TurboLoRA` enums and edit the trusted Workflow JSON to use the installed compatible files.

Each `*.node.json` file contains a `nodeData` object shaped like a generation vd-node. `workflow` is cloned for every run. `bindings` are then applied to exact comfyui-node/input pairs; no prompt-text search or canvas-coordinate patching occurs. The v1 manifest example instead uses `manifest` and `implementation` as described in the [vd-node pack protocol](../docs/custom-node-protocol.md).

The `asset` binding source must name an `assetId`, or omit it when the first incoming asset edge should supply the value. Video Director uploads that project asset first and binds the filename returned by ComfyUI, never a local filesystem path.

Treat workflow JSON as executable configuration. Only import graphs you trust: ComfyUI custom-node packages are local Python code, and a graph can invoke any installed node class. Keep ComfyUI on a trusted network and review model/download licenses separately.

## MiniMax H3 license notice

These vd-node definitions contain no model weights and do not grant permission to use them. MiniMax H3 base weights are governed by the [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE), not this repository's MIT license. At the time these nodes were prepared, the agreement included territory, attribution, commercial-scale, hosted-service, acceptable-use, redistribution, and model-improvement restrictions. Review the current agreement and obtain any required authorization before enabling `minimaxH3LicenseAccepted`.

The Turbo ComfyUI custom-node package is published under Apache-2.0, and its LoRA has its own Apache-2.0 model card. Those terms do not replace the base H3 weight license.
