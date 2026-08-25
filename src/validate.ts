/**
 * Fail-loud config validation for llm-degen-heal. Kept in its own module so
 * it can be unit-tested without dragging cordis types through the tree.
 * @module @dsh-external/llm-degen-heal/validate
 */

export interface ValidatableConfig {
  windowTokens: number
  shortTokenMaxLen: number
  repeatThreshold: number
  entropyRatio: number
  detectAlternating: boolean
  leakMarkers: string[]
  leakThreshold: number
  idleTurns: number
  idleTurnWords: number
  temperatureDelta: number
  cooldownMs: number
  escalateAt: number
  maxRetriesPerEpoch: number
  healMessage: string
}

/**
 * Validate fail-loud against bad config values. Every constraint is a
 * detected-misconfiguration guard: an invalid value throws at plugin load,
 * never silently falls back to a hidden default.
 */
export function validateConfig(config: ValidatableConfig): void {
  const ints: Array<[keyof Pick<ValidatableConfig, 'windowTokens' | 'repeatThreshold' | 'escalateAt' | 'maxRetriesPerEpoch' | 'idleTurns' | 'leakThreshold'>, number]> = [
    ['windowTokens', config.windowTokens],
    ['repeatThreshold', config.repeatThreshold],
    ['escalateAt', config.escalateAt],
    ['maxRetriesPerEpoch', config.maxRetriesPerEpoch],
    ['idleTurns', config.idleTurns],
    ['leakThreshold', config.leakThreshold],
  ]
  for (const [key, value] of ints) {
    if (!Number.isInteger(value) || (key === 'maxRetriesPerEpoch' ? value < 0 : value <= 0)) {
      throw new Error(`llm-degen-heal: ${key} must be ${key === 'maxRetriesPerEpoch' ? 'an integer >= 0' : 'a positive integer'}`)
    }
  }
  if (!Array.isArray(config.leakMarkers) || config.leakMarkers.some(marker => typeof marker !== 'string' || marker.trim().length === 0)) {
    throw new Error('llm-degen-heal: leakMarkers must be a non-empty-string array')
  }
  if (!Number.isFinite(config.entropyRatio) || config.entropyRatio <= 0 || config.entropyRatio > 1) {
    throw new Error('llm-degen-heal: entropyRatio must be in (0, 1]')
  }
  if (!Number.isFinite(config.cooldownMs) || config.cooldownMs < 0) {
    throw new Error('llm-degen-heal: cooldownMs must be >= 0')
  }
  if (!Number.isInteger(config.idleTurnWords) || config.idleTurnWords <= 0) {
    throw new Error('llm-degen-heal: idleTurnWords must be a positive integer')
  }
  if (!Number.isInteger(config.shortTokenMaxLen) || config.shortTokenMaxLen <= 0) {
    throw new Error('llm-degen-heal: shortTokenMaxLen must be a positive integer')
  }
  if (!Number.isFinite(config.temperatureDelta) || Math.abs(config.temperatureDelta) > 2) {
    throw new Error('llm-degen-heal: temperatureDelta must be finite within ±2')
  }
  if (typeof config.healMessage !== 'string' || config.healMessage.length === 0) {
    throw new Error('llm-degen-heal: healMessage must be a non-empty string')
  }
}
