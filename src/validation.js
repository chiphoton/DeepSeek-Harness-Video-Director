const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export class DirectorInputError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'DirectorInputError'
    this.code = 'video-director/invalid-input'
    this.details = details
  }
}

export function record(value, label = 'value') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DirectorInputError(`${label} must be an object`)
  }
  return value
}

export function string(value, label, options = {}) {
  if (typeof value !== 'string') throw new DirectorInputError(`${label} must be a string`)
  const trimmed = options.trim === false ? value : value.trim()
  const min = options.min ?? 0
  const max = options.max ?? 16_384
  if (trimmed.length < min || trimmed.length > max) {
    throw new DirectorInputError(`${label} length must be between ${String(min)} and ${String(max)}`)
  }
  return trimmed
}

export function optionalString(value, label, options = {}) {
  return value === undefined || value === null ? undefined : string(value, label, options)
}

export function identifier(value, label) {
  const parsed = string(value, label, { min: 1, max: 128 })
  if (!ID_PATTERN.test(parsed)) throw new DirectorInputError(`${label} is not a valid identifier`)
  return parsed
}

export function uuid(value, label) {
  const parsed = string(value, label, { min: 36, max: 36 })
  if (!UUID_PATTERN.test(parsed)) throw new DirectorInputError(`${label} must be a UUID`)
  return parsed
}

export function finiteNumber(value, label, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DirectorInputError(`${label} must be a finite number`)
  }
  if (options.min !== undefined && value < options.min) {
    throw new DirectorInputError(`${label} must be at least ${String(options.min)}`)
  }
  if (options.max !== undefined && value > options.max) {
    throw new DirectorInputError(`${label} must be at most ${String(options.max)}`)
  }
  return value
}

export function oneOf(value, label, choices) {
  if (!choices.includes(value)) {
    throw new DirectorInputError(`${label} must be one of: ${choices.join(', ')}`)
  }
  return value
}

export function jsonValue(value, label = 'value', maxBytes = 20 * 1024 * 1024) {
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw new DirectorInputError(`${label} must be JSON-serializable`, { cause: String(error) })
  }
  if (json === undefined) throw new DirectorInputError(`${label} must be JSON-serializable`)
  if (Buffer.byteLength(json) > maxBytes) {
    throw new DirectorInputError(`${label} exceeds ${String(maxBytes)} bytes`)
  }
  return JSON.parse(json)
}
