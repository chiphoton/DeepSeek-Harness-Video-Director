# DeepSeek-Harness Video-Director — 开发者文档

[English](./DEVELOP.md) · [项目首页](../README_zh.md)

`dsh-video-director` 是外置的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 视频导演插件。它提供无限节点画布、与当前 Video Project 绑定的 DeepSeek 对话、多模态素材输入，以及由不同 Provider 驱动的文字、图像、音频和视频 Workflow 节点。

这是可运行的早期实现，不是托管式生成服务。Ollama、OpenAI 兼容接口与 ComfyUI 需要由部署者提供和运维。MiniMax H3 权重采用独立许可证；本插件默认接受许可门，部署者仍可显式关闭。

## 已实现能力

- 精简的顶部 Project 切换器，带新建、重命名/删除、Undo/Redo，以及独立的**运行**、**任务**、**设置**与**保存**按钮。运行菜单支持整个 Graph、所选 Node，或所选 Node 及其全部下游，并可设置 1–20 个批次；任务抽屉按 Graph Run 分组，同时保留单 Node Job。始终位于 Node 前景的横向画布工具栏固定在右下角，集中提供移动、框选、缩放、适配视图与 Mini Map 显隐。
- 左侧 DeepSeek 对话；切换 Project 时同步打开该工程的 `sessionId`，上下文不会串工程，并复用该 Session 的模型目录。聊天框支持直接粘贴或拖放图片/音频；底部 **＋** 菜单也可选择 PNG、JPEG、WebP、GIF 图片或音频文件。图片作为原生多模态附件发送，音频由选定的 OpenAI-compatible Provider 转写后写入输入框。设置按钮可切换“Enter 换行、Alt+Enter 发送”，并配置语音 Provider、不会回显的 API Key 和语音模型；麦克风按钮支持录音转写。
- 基于 `@xyflow/react` 的无限画布，包含文字、图像、音频、视频和 Sketch Load 节点；点击已有 Sketch 会重新打开绘图编辑器。滚轮缩放，双击空白处可搜索并在原位添加节点。默认左键拖拽框选，按住空格临时平移画布。从输出端拖到空白画布并释放时，会打开按兼容输入类型过滤的节点菜单；选中后在释放位置创建节点并自动连线，右键菜单、点击其他位置或按 Esc 则取消待连接操作。节点背景右键菜单集中提供运行/取消、复制、Mask 副本、重命名、属性查看和删除；表单、播放器与下载控件仍保留原生交互。
- Prompt Enhancer、图像生成、MiniMax H3 视频和 H3 音频 Workflow 节点。
- 私有、不可变的素材 URL，并支持音视频播放所需的 HTTP Byte Range。
- 乐观 revision：旧浏览器窗口不能静默覆盖新版本工程。
- 基于不可变画布快照的依赖感知 Graph 调度：执行计划会折叠本地输入与 Sink Node，让互不依赖的远程 Node 同阶段运行，让下游等待上游结果，并在提交前拒绝循环依赖。
- 持久化的分组 Job 记录、Graph/Node 取消与重试、精确 ComfyUI `prompt_id` 跟踪，以及保守的重启恢复。
- Ollama、OpenAI 兼容接口，以及一个统一的 ComfyUI Provider：用户只填一个 `IP:port`，Host 在每次运行时自动选择 REST 或 MCP。
- 命名的 ComfyUI Workflow Registry：可导入图像生成、图像编辑、视频或音频 API Workflow，并在节点中选择 Workflow，而不是把 ComfyUI 模型文件误当成 Model ID。
- 内置文字、图像、音频与视频通用的 **Preview** 和 **Save** 输出节点。
- 不可变、声明式的 [Custom Node 协议](./custom-node-protocol.md)，包含 Typed Ports，以及简洁的 `primary` 与默认折叠的 `Advanced` 字段。
- 内置 [`comfyui-workflow-to-node` Skill](../skills/comfyui-workflow-to-node/SKILL.md)，可把可信的 ComfyUI API Graph，或能用匹配 `/object_info` 精确解析的编辑器模板，转换为内置 Workflow 或 Custom Node 草稿。

画布可以表达 Mask、截取、裁剪、缩放和 Sketch 数据。当前版本只有在兼容的预处理或 ComfyUI Workflow 消费派生素材/元数据时，这些编辑才会真正作用于生成；插件尚未内置完整的非破坏性媒体编辑器。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm `11.7.0`
- 已构建的 DeepSeek Harness 源码仓库，或已安装的 `dsh` CLI
- 本地生成时，需要单独配置 Ollama 和/或 ComfyUI
- 使用可选的 Codex Plan 文字/图像 Provider 时，需要本机已经登录 Codex；图像 Workflow 还需要账户可使用图像生成
- MiniMax H3 Turbo 还需要 H3 节点/模型，以及 [`ComfyUI-MiniMax-H3-Turbo`](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo)

## 构建与安装

```sh
pnpm install --frozen-lockfile
pnpm run check
```

构建会输出 `lib/client.js`，格式是 DSH 原生 Client Module System 所需的 lazy-CJS factory。React、Cordis 和 DSH 客户端 Service 保持为共享模块；`@xyflow/react` 会打进插件 Bundle。CSS 按文字打包，由 App 自己管理 `<style>` 生命周期。

假设本仓库与 `deepseek-harness` 源码目录同级，可安装到独立 Profile：

```sh
cd ../deepseek-harness
pnpm dsh plugin --profile video-director add ../DeepSeek-Harness-Video-Director
pnpm dsh --profile video-director --dump-config
```

配置输出中应包含 `dsh-video-director` Layer 与 `video-director` Row。加载 Web UI：

```sh
cd ../deepseek-harness
pnpm dsh plugin --profile web add ../DeepSeek-Harness-Video-Director
pnpm dsh web
```

[`cordis.patch.yml`](../cordis.patch.yml) 是可安装的 Bundle Patch。主 Row 负责启用插件，并暴露 Ollama、OpenAI-compatible、Codex Plan 与一个逻辑 `comfyui` Provider。可选且默认关闭的 `video-director-comfyui-mcp` Row 是供 Host 自动路由使用的 Transport，不是让用户配置或选择的第二个 Provider；启用前应审查它的包执行方式与网络安全边界。

## 配置与架构

| Host 字段 | 作用 |
|---|---|
| `dataDir` | 保存 Project JSON、不可变素材字节和素材索引。 |
| `maxAssetBytes` | 单个上传素材解码后的最大字节数；默认且不可超过 200 MiB。 |
| `jobConcurrency` | 本插件进程可以并行执行的 Job 数量。 |
| `minimaxH3LicenseAccepted` | MiniMax H3 部署许可门；默认 `true`，显式设为 `false` 时保持锁定。 |
| `providers` | 命名的 Ollama、OpenAI 兼容、Codex Plan 连接，以及逻辑 ComfyUI Backend。 |

200 MiB 硬上限为 Harness 的 300 MiB Custom Channel 请求上限预留了空间：二进制素材编码为 Base64 后约膨胀至原大小的 4/3，外层 JSON 也会产生额外开销。

凭据应放在 Harness 托管配置或环境变量中。示例 Patch 从 `OPENAI_API_KEY` 读取密钥，当前选择 `gpt-5.6-terra` 与 `gpt-image-2`；请按兼容接口实际提供的能力调整模型 id。也可以在右侧**设置 → 连接**中覆盖 Provider 配置；密钥通过 DSH 原生 Settings 保存且不会回显到浏览器。ComfyUI 只需输入 `127.0.0.1:8188`，Host 会自动补成 HTTP URL，REST/MCP 细节不会写进工程或画布节点。Video Project 只保存 Provider id、Workflow/Node 引用与参数，不保存 Token。

Codex Plan Provider 使用官方 [`@openai/codex-sdk`](https://developers.openai.com/codex/sdk/) 和本机现有的 Codex 登录。TEXT WORKFLOW 会在隔离的只读临时目录中运行 Codex Agent 来增强 Prompt；IMAGE WORKFLOW 则调用原生图像生成 Skill，再把单张结果导入 Video Project。它不会把 ChatGPT 订阅转换成 API Key，也不会代理任意 Responses API 请求。两个 Workflow 都提供 medium 推理的 `gpt-5.6-sol`、`gpt-5.6-terra` 与 `gpt-5.6-luna`。

Host 会从 Ollama `/api/tags` 自动刷新模型，并且在设置和文字 Workflow 节点中只列出清单里真实可用的模型。Ollama 文字节点会在 **Advanced** 中提供 System Prompt、Context Length 与 Thinking；所选模型未声明 Thinking 能力时该选项会禁用，发现到的模型上下文长度会限制可选覆盖值。ComfyUI 模型枚举来自 `/object_info`，但只有注册 Workflow 或 Custom Node 明确开放的精确 Graph 输入才会成为下拉参数；ComfyUI 节点仍然先选择命名 Workflow，Checkpoint、UNET、CLIP、VAE、LoRA 等文件只在该 Workflow 的参数中选择。原始 `object_info` 与凭据都不会发送到浏览器。

Host Cordis 插件负责 `ProjectStore`、`WorkflowStore`、`NodeRegistry`、`ProviderRuntime`、`JobManager`、`/video-director` RPC 与素材响应。浏览器侧负责 Project/Session 切换、带 Revision 的显式保存、通用 Node 渲染、画布、Graph 规划、Provider 检查与 Job 轮询。画布修改只保留在本地，用户点击**保存**后才写入工程；切换或新建工程前必须保存，或确认放弃修改。运行不要求先保存：客户端在点击 Run 时冻结一次 Graph，按拓扑顺序调度远程 Node，并在每个依赖阶段就绪时向 Host 发送该 Node 的不可变执行快照。Job 只持久化状态、Graph Run 分组、批次坐标与安全元数据，不把执行快照写回工程 Graph；运行期间继续编辑不会被旧快照回滚，晚到的旧 Job 也不能覆盖更新的 Run。每个 Project 保存独立 Harness `sessionId`，因此切换工程时对话上下文也随之切换。

| Provider Kind | 当前操作 | 说明 |
|---|---|---|
| `ollama` | 文字/Prompt 扩写，可带图像上下文 | 使用 `/api/chat`；视觉输入需要多模态模型。 |
| `openai-compatible` | Chat Completions、图像生成、带源图/Mask 的编辑与语音转写 | 使用 `/chat/completions`、`/images/generations`、Multipart `/images/edits` 和 `/audio/transcriptions`；不同服务实现会有差异。 |
| `codex-plan` | 文字/Prompt 扩写与图像生成，均可带图像 References | 使用本机 Codex SDK/登录，在隔离临时工作区运行并把生成图像导回工程；无需 Base URL 或 API Key 字段。 |
| `comfyui` | API Workflow、上传、队列/历史与产物回收 | REST 是健康检查与媒体传输的必要条件；隐藏 MCP Transport 通过只读队列探测后，Host 才可能用它提交，否则自动使用 REST。 |

当 Provider 提供原生清单 API 时，模型选项由服务端发现，而不是让用户手填。Ollama 通过 `GET /api/tags` 获取模型并显示为下拉选项。ComfyUI 通过 `GET /object_info` 获取可用值，但不会把它们暴露成一个全局模型列表；Host 只会将它们映射到已注册 Workflow 或已安装 Video Director Custom Node 明确暴露的参数。

Provider 地址属于部署配置，不能由 Project 任意输入。远端 ComfyUI 应放在 TLS 与鉴权反向代理之后，并明确意识到连接的工程素材会离开本机。

聊天语音输入会把录音或所选音频交给 Host，再由 Host 以 Multipart 调用所选 OpenAI-compatible Provider 的 `/audio/transcriptions`。API Key 只保存在 DSH Settings；浏览器和 Video Project 都不会得到密钥。单个转写音频限制为 25 MiB，转写结果只会先加入输入框，不会自动发送。

## 统一 ComfyUI Transport

用户只配置一个 ComfyUI 地址，例如 `127.0.0.1:8188`。REST `/system_stats` 检查必须成功，因为素材上传、精确 History 监控、`/view` 与工程 Asset 写入都需要 HTTP 端点。Transport 选择属于 Host 内部行为，只在连接与 Job 诊断中报告。

当 DSH Tools 和隐藏 MCP Tool 可用时，Host 会先执行只读 `get_queue_status` 探测。探测成功才通过 MCP 调用 `enqueue_workflow`；探测不可用则走 REST `/prompt`。MCP enqueue 一旦开始，错误或不明确响应都不会再转投 REST，因为那可能把同一个 Render 重复提交。

可选参考 Transport 固定使用 [`artokun/comfyui-mcp@0.49.3`](https://github.com/artokun/comfyui-mcp/tree/v0.49.3)，通过 `COMFYUI_MCP_AUTOUPDATE=0` 禁止自更新，并用原生 [`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/mcp/mcp-client) 的 stdio Transport 连接，稳定 Server Name 为 `comfyui`。

Patch 中固定版本的 `npx -y` 便于评估，但每次进程启动仍会进入包执行器。受控部署应把这个精确版本安装到管理员维护的位置，锁定依赖树，再让 `command`/`args` 指向该可执行文件，同时保持自动更新关闭。

0.49.3 通常以 Compact Mode 暴露 `list_tools`、`describe_tool` 与 `call_tool`。Video Director 只通过 `call_tool` 调用允许的队列操作，并在自己生成 Seed 后设置 `disable_random_seed: true`。DSH 只桥接 MCP Tools，不桥接 Resources、Prompts、Codex/Claude Completion Hook，也不会消费 `comfyui-mcp` 写入 `/tmp` 的完成文件，因此插件仍通过 ComfyUI REST History 跟踪精确 Job。

DSH 普通 MCP Tool Timeout 不是 Render Job 生命周期。Workflow 只提交一次，保存 `prompt_id` 后异步收集结果。当前没有面向用户的 MCP-only Provider；统一 ComfyUI Backend 始终需要 REST 地址。

## Workflow Registry、JSON 与绑定

在**设置 → Nodes & Workflows**中导入命名的 ComfyUI **API Format** JSON：`{ "nodeId": { "class_type": "...", "inputs": {} } }`。不要传入含 `nodes`、`links` 和布局信息的 Editor/UI JSON。Registry 在服务端保存可执行 Graph，画布节点只接收描述与可配置参数。图像生成与图像编辑是两个独立用途；Provider 选择 ComfyUI 后，节点第二项会从 **Model** 切换为 **Workflow**。

生成节点的顶层选择器始终是 **Workflow**。ComfyUI `/object_info` 返回的 Loader 选项，例如 Checkpoint、UNet、VAE、CLIP 或 LoRA 文件名，只会在注册 Workflow/Custom Node 明确暴露对应输入时成为该参数的下拉菜单。Video Director 不会把这些选项扁平化成全局 Checkpoint/Model 选择器，也不会暴露注册定义中固定或隐藏的参数。

导入器会识别常见的 Prompt、Negative Prompt、Seed、宽高、时长、帧数、FPS 与 `LoadImage` 输入。常用创作字段会直接显示；Sampler、Scheduler、Model、CFG、Steps、输出前缀等详细字段仍然可配置，但默认放进 Node 的折叠 **Advanced** 区域。执行时 Workflow 仍会解析为 API Graph 与显式语义绑定：

```json
{
  "workflow": {
    "4": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024 } },
    "5": { "class_type": "KSampler", "inputs": { "seed": 1001 } }
  },
  "bindings": [
    { "nodeId": "4", "input": "width", "from": "width" },
    { "nodeId": "4", "input": "height", "from": "height" },
    { "nodeId": "5", "input": "seed", "from": "seed" }
  ]
}
```

绑定来源包括 `prompt`、`negativePrompt`、`seed`、`width`、`height`、`duration`、`frames`、`fps`、`steps`、`scheduler`、`variant`、`asset`、`maskAsset`、`trimStart`、`trimEnd`、`inputWidth`、`inputHeight`、`aspectRatio`、`includeAudio`、`referenceRole` 与 `literal`。绑定只修改指定 Node/Input，`mediaIndex` 用来选择第几个已连线输入（默认 `0`）。Asset 绑定使用 ComfyUI 上传返回的 Filename，绝不会把本地工作区路径写进 Loader Node。

图像 Custom Node 见 [`custom_nodes/comfyui-basic-image.node.json`](../custom_nodes/comfyui-basic-image.node.json) 和 [`custom_nodes/z-image-turbo.node.json`](../custom_nodes/z-image-turbo.node.json)；H3 Custom Node 包括 [`custom_nodes/minimax-h3-t2v-turbo.node.json`](../custom_nodes/minimax-h3-t2v-turbo.node.json)、[`custom_nodes/minimax-h3-audio-turbo.node.json`](../custom_nodes/minimax-h3-audio-turbo.node.json) 和 [`custom_nodes/minimax-h3-audio-standard.node.json`](../custom_nodes/minimax-h3-audio-standard.node.json)。导入前请先读 [`custom_nodes/README.md`](../custom_nodes/README.md)。ComfyUI Workflow 是可执行配置，能调用已安装的 Custom Node；不要导入不可信 JSON。

## Preview 与 Save 节点

底栏把 `core.preview@1.0.0` 和 `core.save@1.0.0` 作为普通、可连线的 Sink Node 提供：

```text
生成视频 -> Preview -> Save Output
```

Preview 接受文字、图像、音频或视频，并自动选择对应的安全内联预览器。如果生成完成时没有已连接的 Preview，Video Director 会自动创建一个，避免产物藏在 Job 结果中。Save 接收同一份不可变 Project Asset，让用户指定输出名并明确下载到本地；它不会重复复制大体积服务端字节，也不允许节点指定任意服务端文件路径。

## Custom Node 与字段展示

Video Director Custom Node v1 是类似 ComfyUI Custom Node 安装范式的声明式协议。单个 Node Pack 会声明不可变的 `type@version`、Typed Input/Output Ports、Host 校验字段、精确 ComfyUI Workflow Bindings，以及 `primary`/`advanced` 展示位置。在**设置 → Nodes & Workflows**中安装可信 `.director-node.json` 后，即可从底栏的 **Custom Node** 选择器添加。

通用 Renderer 只把 `primary` 字段放在 Node 主界面；全部 `advanced` 字段仍可在默认折叠的 **Advanced** 区域编辑。这样大型图像/视频 Workflow Node 保持简洁，但不会丢失细节控制。浏览器导入的 Pack 只能声明经过审查的 `comfyui.workflow` 实现，不能携带 JavaScript、Shell、凭据、任意 MCP Tool、React、HTML 或 CSS。

- 人类可读接口文档：[`docs/custom-node-protocol.md`](./custom-node-protocol.md)
- 规范 JSON Schema：[`schemas/video-director-node-v1.schema.json`](../schemas/video-director-node-v1.schema.json)
- 完整图像节点示例：[`custom_nodes/comfyui-basic-image.manifest.json`](../custom_nodes/comfyui-basic-image.manifest.json)

每个已安装 Definition 都按 Type、精确 SemVer 与内容 Digest 固定。重复安装相同内容是幂等操作；同版本不同内容会被拒绝。Project 保存的是精确 Node 引用与字段值，不会嵌入 Transport 选择或凭据。

文字参数也可以按节点实例变成输入端口。右键点击节点，打开**参数输入**，即可启用列表中实际支持的 Prompt、Negative prompt 或声明为字符串的字段。没有连线时保留节点中的本地值作为回退；连入文字后，只在本次运行快照中覆盖它。关闭该输入时，对应连线会作为一次可 Undo 的图编辑一起移除。协议 v1 中，Number 与 Boolean 字段仍保留为节点内控件。

多模态参考使用普通的 Typed Custom Node 端口。例如 R2V Node 可以分别声明图像、视频、音频输入，并将每个端口精确绑定到 ComfyUI Workflow；它们可以接收上游 Load 或生成节点的输出。若 Workflow 根本没有消费某类媒体，Video Director 不会虚构一个无效的 Reference 端口。

## ComfyUI Workflow-to-Node Skill

当 DSH Skills Service 可用时，插件会注册内置 [`comfyui-workflow-to-node`](../skills/comfyui-workflow-to-node/SKILL.md) Skill。对于可移植 Node Pack，它用离线 Analyzer 读取可信的 **API-format** Workflow；对于本仓库内置 Workflow，它也能在取得匹配 ComfyUI `/object_info` 后精确编译可信的编辑器模板。两条路径都会保留精确 Bindings，把常用路径放进 `primary`、详细控制放进 `advanced`。

该 Skill 可以读取 ComfyUI 元数据以精确转换 UI 模板，但除非用户另行要求，否则不会提交 Workflow、生成媒体、安装 Custom Node 或下载模型。Agent 必须复核映射、Prompt 正负极性、媒体角色、输出识别、Operation、默认值与字段位置。参考文档见 [Node Protocol v1](../skills/comfyui-workflow-to-node/references/node-protocol-v1.md) 与 [项目内置 Workflow 流程](../skills/comfyui-workflow-to-node/references/project-builtin-workflows.md)。

## MiniMax H3

现在新增 H3 视频或音频节点时，默认选择对应的内置自部署 Turbo Workflow 与语义 Bindings，无需先手工粘贴模板即可运行。Audio Workflow 下拉菜单还提供 `MiniMax-H3 Audio (Standard)`。视频 Preset 通过 `CreateVideo`/`SaveVideo` 解码并保存同步视频与音频；两个音频 Preset 都把一次性视觉 Latent 固定为 `32×32`，只保存 H3 原生音频。Turbo Graph 使用 `MiniMaxH3TurboLoRA` 和自定义 Turbo Sampler；Standard 音频 Graph 不含 LoRA，使用 `KSamplerSelect` 的 `res_multistep`，默认 20 Steps。

内置 Preset 使用在参考 `127.0.0.1:8188` 部署上实机确认的文件名：`minimax_h3_fl2va_int8_convrot.safetensors`、`qwen3vl_32b_minimax_h3_int8_convrot.safetensors`、`minimax_h3_video_vae_fp16.safetensors`、`minimax_h3_audio_vae_fp32.safetensors` 与 `minimax_h3_turbo_v4_step600_ema.safetensors`。模型文件名属于部署本地配置，并不是通用 API ID。如果你的兼容 H3 模型使用其他文件名，请先查看 `/object_info` 的 Loader 枚举，导出兼容的 API-format Workflow，再从**设置 → Nodes & Workflows**导入。不能因为 REF2VA 已安装，就把它错误代替 FL2VA 路线。

视频与 Turbo 音频 Preset 的拓扑固定为 Turbo，而不是拓扑切换器。只修改 Variant 字段不能移除 LoRA 与自定义 Turbo Sampler；Standard 音频选项会整体选择另一份经过审查的无 LoRA Workflow JSON。

所有约束都会在上传或入队前验证：

- 宽高都必须是正的 32 倍数；UI 默认 `1280×704`。
- 请求时长必须大于 0 且不超过 15 秒。
- 24 fps 下，先对请求帧数四舍五入，再向上对齐到 H3 的 `17k+5` 网格；结果同时报告实际 Frames 与 Duration。
- 少于 5 秒会标为实验性时长。
- Audio-only H3 的一次性视觉 Latent 固定 `32×32`。
- Turbo 只接受 4–8 Steps 与 `simple` Scheduler；其他 Sampler/Scheduler 应选择 Standard Graph。

内置 Preset 覆盖带同步音频的 T2V，以及 Prompt-only Audio；它们并不是完整的 H3 模板编译器。I2V 与 R2V 仍需导入审查过的 API Graph，并显式绑定媒体输入。需要固定模板的多路线准备方式，可参考 [`MiniMax-H3-Codex-Drama`](https://github.com/chiphoton/MiniMax-H3-Codex-Drama)。

### H3 使用独立许可证

插件代码采用 MIT；MiniMax H3 基础权重受 [MiniMax H3 Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) 约束，并不是 MIT 或普通开源模型许可证。本实现编写时，该协议的适用地域排除美国、欧盟、英国与韩国；超过其中所列 2,000 万美元年收入门槛需要事先书面授权；同时包含产品署名、托管服务保护、可接受使用、再分发与模型改进限制。请以当前协议原文为准，不要只依赖本摘要。

`minimaxH3LicenseAccepted` 默认值为 `true`，作为运行时确认标记；设为 `false` 可保持 H3 锁定。此设置不构成法律意见，也不会授予许可证；使用前仍应审阅协议并取得任何必要授权。Turbo Node/LoRA 的许可证也不能替代基础权重协议。

参考 Workflow Template 与 `comfyui-mcp` 使用 MIT，Turbo Node/LoRA 使用 Apache-2.0；ComfyUI 本身为 GPL-3.0。通过 HTTP 调用独立部署的服务，与再分发修改/捆绑后的 ComfyUI 并非同一情形，请按实际分发方式审查义务。

## 持久化、恢复与安全

素材写入 `dataDir/assets` 后不再覆盖，在索引中保存 SHA-256，并以 `Cache-Control: private, ... immutable` 响应；音视频支持单 Byte Range。编辑媒体应创建 Derived Asset，不覆盖原始文件。每个 Project 保留最近 100 条 Job。

恢复策略刻意保守：Harness 在本地 Job 处于 `queued`/`running` 时停止，重启后会标为 `orphaned`，不会再次提交。超时不等于 ComfyUI 失败；新建 Attempt 前应先检查保留的 `prompt_id` 与 History。

当 Video Project 绑定的 Harness Session 无法恢复时，工程本身仍保持可用：画布会连同 Session 错误一起载入，而不会整项不可访问。通过**聊天输入设置 → 新会话**可在保留当前工程与画布的同时绑定新的对话；失败的原 Session 不会被修改或删除。

- 默认只在 Loopback 或带鉴权的私有网络运行 ComfyUI/Ollama。
- API Key 不得写入 Project JSON、Canvas Node、Prompt 或 Workflow Literal。
- 下载模型、安装 Custom Node、重启服务属于管理员操作；Custom Node 会执行本地 Python。
- 只提交可信 Workflow；结构验证无法证明已安装 Node 的行为安全。
- 浏览器导入的 Video Director Node Pack 是声明式并经过 Schema 校验的，不能携带任意 Executor；但其中嵌入的 ComfyUI Workflow 仍能调用已安装的 Python Custom Node，因此依然需要信任审查。
- MCP Tool 与 Operation 由 Host 持有并限制；删除模型、安装节点、重启进程、清空整个队列和任意服务端路径读取都不在插件路径内。

## 当前限制

- 暂无协同 Graph Merge；Revision 冲突需要在 UI 层 Reload/Merge。
- 重启后把未完成 Job 记为 Orphaned，尚未恢复持久化的 ComfyUI Watcher。
- 进度使用轮询，尚无精确到 Prompt 的 WebSocket Observer。
- H3 I2V/R2V Graph 与带角色的 Reference Wiring 尚未内置；当前内置 T2V-with-audio 与 Prompt-only Audio。
- Mask、Trim/Crop、Resize 尚未接入内置 FFmpeg/图像预处理流水线。
- 不同 OpenAI 兼容服务的能力不一致。
- 不编译 ComfyUI Editor Format JSON。Workflow-to-Node Skill 需要 API Format，并输出供审查的草稿；它不会静默安装或执行结果。

## 开发与测试

```sh
pnpm run build
pnpm run typecheck
pnpm test
pnpm run check
```

测试覆盖插件/Patch 发现、Project 身份与 Revision 冲突、不可变 Asset 和 HTTP Range、不可变 Custom Node Definition 与字段校验、Preview/Save Catalog、不会重复提交的 REST/MCP 路由、H3 许可门与约束、保守 Job Recovery 与 RPC 输入验证。

主要参考：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[DirectorX](https://github.com/LaplaceYoung/dsh-directorx)、[Tongflow](https://github.com/tong-io/tongflow)、[MiniMax-H3-Codex-Drama](https://github.com/chiphoton/MiniMax-H3-Codex-Drama)、[comfyui-mcp 0.49.3](https://github.com/artokun/comfyui-mcp/tree/v0.49.3) 与 [ComfyUI](https://github.com/Comfy-Org/ComfyUI)。
