import { DirectorInputError, identifier, record, string } from './validation.js'

export const PROVIDER_SETTINGS_NAMESPACE = 'video-director'

const EDITABLE_FIELDS = new Set([
  'label',
  'baseUrl',
  'model',
  'imageModel',
  'apiKey',
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function cleanBaseUrl(value) {
  const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) ? value : `http://${value}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DirectorInputError('provider baseUrl must use http or https')
  }
  return url.toString().replace(/\/$/u, '')
}

function cleanPatch(inputValue) {
  const input = record(inputValue, 'provider patch')
  const patch = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === 'clearApiKey') continue
    if (!EDITABLE_FIELDS.has(key)) throw new DirectorInputError(`provider field ${key} is not editable`)
    if (value === null) {
      patch[key] = null
      continue
    }
    const parsed = string(value, `provider.${key}`, {
      trim: key !== 'apiKey',
      min: key === 'apiKey' ? 1 : 0,
      max: key === 'apiKey' ? 8_192 : 2_048,
    })
    patch[key] = key === 'baseUrl' && parsed !== '' ? cleanBaseUrl(parsed) : parsed
  }
  return { patch, clearApiKey: input.clearApiKey === true }
}

function mergedProviders(baseProviders, overrides) {
  return baseProviders.map(provider => {
    const editableOverrides = {}
    for (const [key, value] of Object.entries(overrides?.[provider.id] ?? {})) {
      if (EDITABLE_FIELDS.has(key)) editableOverrides[key] = value
    }
    return {
      ...provider,
      ...editableOverrides,
    }
  })
}

/**
 * One small interface over DSH settings. It hides layered provider config,
 * path-addressed secret-safe writes, and live runtime refresh from RPC callers.
 */
export class ProviderSettings {
  constructor(base, onChange) {
    this.base = {
      providers: clone(base.providers ?? []),
      providerOverrides: {},
      minimaxH3LicenseAccepted: base.minimaxH3LicenseAccepted !== false,
    }
    this.current = () => this.base
    this.writer = undefined
    this.onChange = onChange
  }

  attach(writer, source) {
    this.writer = writer
    this.current = source
    this.refresh()
  }

  detach() {
    this.writer = undefined
    this.current = () => this.base
    this.refresh()
  }

  resolved() {
    const settings = this.current()
    return {
      providers: mergedProviders(this.base.providers, settings.providerOverrides ?? {}),
      minimaxH3LicenseAccepted: settings.minimaxH3LicenseAccepted === undefined
        ? this.base.minimaxH3LicenseAccepted
        : settings.minimaxH3LicenseAccepted === true,
    }
  }

  refresh() {
    this.onChange(this.resolved())
  }

  async updateProvider(providerIdValue, patchValue) {
    if (this.writer === undefined) throw new Error('DSH settings are not available in this profile')
    const providerId = identifier(providerIdValue, 'providerId')
    if (!this.base.providers.some(provider => provider.id === providerId)) {
      throw new DirectorInputError(`unknown provider: ${providerId}`)
    }
    const { patch, clearApiKey } = cleanPatch(patchValue)
    const ops = []
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || (value === '' && key !== 'apiKey')) {
        ops.push({ op: 'unset', path: ['providerOverrides', providerId, key] })
      } else {
        ops.push({ op: 'set', path: ['providerOverrides', providerId, key], value })
      }
    }
    if (clearApiKey) ops.push({ op: 'unset', path: ['providerOverrides', providerId, 'apiKey'] })
    if (ops.length > 0) {
      await this.writer.mutate(PROVIDER_SETTINGS_NAMESPACE, ops)
      this.refresh()
    }
    return this.resolved()
  }
}
