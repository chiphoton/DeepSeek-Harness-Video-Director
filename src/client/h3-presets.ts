import type { DirectorNodeData, ComfyWorkflowBinding } from './types'

// These defaults match the model inventory verified on the reference
// ComfyUI deployment at 127.0.0.1:8188. They are workflow configuration,
// not portable model identifiers: another deployment may need to replace them.
export const H3_REFERENCE_MODELS = {
  fl2va: 'minimax_h3_fl2va_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  turboLora: 'minimax_h3_turbo_v4_step600_ema.safetensors',
} as const

const H3_T2V_TURBO_WORKFLOW: Record<string, unknown> = {
  '6': {
    class_type: 'UNETLoader',
    inputs: { unet_name: H3_REFERENCE_MODELS.fl2va, weight_dtype: 'default' },
  },
  '9': {
    class_type: 'BasicScheduler',
    inputs: { model: ['134', 0], scheduler: 'simple', steps: 6, denoise: 1 },
  },
  '10': {
    class_type: 'VAEDecode',
    inputs: { samples: ['14', 0], vae: ['11', 0] },
  },
  '11': {
    class_type: 'VAELoader',
    inputs: { vae_name: H3_REFERENCE_MODELS.videoVae },
  },
  '13': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: H3_REFERENCE_MODELS.textEncoder, type: 'minimax', device: 'default' },
  },
  '14': {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['15', 0],
      guider: ['16', 0],
      sampler: ['17', 0],
      sigmas: ['9', 0],
      latent_image: ['104', 1],
    },
  },
  '15': {
    class_type: 'RandomNoise',
    inputs: { noise_seed: 0 },
  },
  '16': {
    class_type: 'BasicGuider',
    inputs: { model: ['134', 0], conditioning: ['104', 0] },
  },
  '17': {
    class_type: 'MiniMaxH3TurboSampler',
    inputs: {},
  },
  '23': {
    class_type: 'VAEDecodeAudio',
    inputs: { samples: ['14', 0], vae: ['24', 0] },
  },
  '24': {
    class_type: 'VAELoader',
    inputs: { vae_name: H3_REFERENCE_MODELS.audioVae },
  },
  '91': {
    class_type: 'CreateVideo',
    inputs: { images: ['10', 0], audio: ['23', 0], fps: 24, bit_depth: 8 },
  },
  '92': {
    class_type: 'SaveVideo',
    inputs: {
      video: ['91', 0],
      filename_prefix: 'video-director/minimax-h3/video',
      format: 'auto',
      codec: 'auto',
    },
  },
  '104': {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['13', 0],
      vae: ['11', 0],
      prompt: 'replaced by the prompt binding',
      width: 1280,
      height: 704,
      length: 158,
    },
  },
  '134': {
    class_type: 'MiniMaxH3TurboLoRA',
    inputs: {
      model: ['6', 0],
      lora_name: H3_REFERENCE_MODELS.turboLora,
      strength: 1,
      low_vram: false,
    },
  },
}

const H3_T2V_TURBO_BINDINGS: ComfyWorkflowBinding[] = [
  { nodeId: '104', input: 'prompt', from: 'prompt' },
  { nodeId: '104', input: 'width', from: 'width' },
  { nodeId: '104', input: 'height', from: 'height' },
  { nodeId: '104', input: 'length', from: 'frames' },
  { nodeId: '15', input: 'noise_seed', from: 'seed' },
  { nodeId: '9', input: 'steps', from: 'steps' },
  { nodeId: '9', input: 'scheduler', from: 'scheduler' },
  { nodeId: '91', input: 'fps', from: 'fps' },
]

const H3_AUDIO_TURBO_WORKFLOW: Record<string, unknown> = {
  '6': {
    class_type: 'UNETLoader',
    inputs: { unet_name: H3_REFERENCE_MODELS.fl2va, weight_dtype: 'default' },
  },
  '9': {
    class_type: 'BasicScheduler',
    inputs: { model: ['134', 0], scheduler: 'simple', steps: 6, denoise: 1 },
  },
  '11': {
    class_type: 'VAELoader',
    inputs: { vae_name: H3_REFERENCE_MODELS.videoVae },
  },
  '13': {
    class_type: 'CLIPLoader',
    inputs: { clip_name: H3_REFERENCE_MODELS.textEncoder, type: 'minimax', device: 'default' },
  },
  '14': {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['15', 0],
      guider: ['16', 0],
      sampler: ['17', 0],
      sigmas: ['9', 0],
      latent_image: ['104', 1],
    },
  },
  '15': {
    class_type: 'RandomNoise',
    inputs: { noise_seed: 0 },
  },
  '16': {
    class_type: 'BasicGuider',
    inputs: { model: ['134', 0], conditioning: ['104', 0] },
  },
  '17': {
    class_type: 'MiniMaxH3TurboSampler',
    inputs: {},
  },
  '23': {
    class_type: 'VAEDecodeAudio',
    inputs: { samples: ['14', 0], vae: ['24', 0] },
  },
  '24': {
    class_type: 'VAELoader',
    inputs: { vae_name: H3_REFERENCE_MODELS.audioVae },
  },
  '25': {
    class_type: 'SaveAudio',
    inputs: { audio: ['23', 0], filename_prefix: 'video-director/minimax-h3/audio' },
  },
  '104': {
    class_type: 'MiniMaxH3ImageToVideo',
    inputs: {
      clip: ['13', 0],
      vae: ['11', 0],
      prompt: 'replaced by the prompt binding',
      width: 32,
      height: 32,
      length: 158,
    },
  },
  '134': {
    class_type: 'MiniMaxH3TurboLoRA',
    inputs: {
      model: ['6', 0],
      lora_name: H3_REFERENCE_MODELS.turboLora,
      strength: 1,
      low_vram: false,
    },
  },
}

const H3_AUDIO_TURBO_BINDINGS: ComfyWorkflowBinding[] = [
  { nodeId: '104', input: 'prompt', from: 'prompt' },
  // Audio-only mode never exposes a configurable visual canvas. Literal
  // bindings keep the disposable latent at the verified 32x32 size.
  { nodeId: '104', input: 'width', from: 'literal', value: 32 },
  { nodeId: '104', input: 'height', from: 'literal', value: 32 },
  { nodeId: '104', input: 'length', from: 'frames' },
  { nodeId: '15', input: 'noise_seed', from: 'seed' },
  { nodeId: '9', input: 'steps', from: 'steps' },
  { nodeId: '9', input: 'scheduler', from: 'scheduler' },
]

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createH3T2vTurboPreset(providerId: string): Partial<DirectorNodeData> {
  return {
    providerId,
    modelFamily: 'minimax-h3',
    width: 1280,
    height: 704,
    duration: 6,
    fps: 24,
    variant: 'turbo',
    steps: 6,
    scheduler: 'simple',
    workflow: clone(H3_T2V_TURBO_WORKFLOW),
    bindings: clone(H3_T2V_TURBO_BINDINGS),
  }
}

export function createH3AudioTurboPreset(providerId: string): Partial<DirectorNodeData> {
  return {
    providerId,
    modelFamily: 'minimax-h3',
    width: 32,
    height: 32,
    duration: 6,
    fps: 24,
    variant: 'turbo',
    steps: 6,
    scheduler: 'simple',
    workflow: clone(H3_AUDIO_TURBO_WORKFLOW),
    bindings: clone(H3_AUDIO_TURBO_BINDINGS),
  }
}
