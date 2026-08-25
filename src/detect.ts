/**
 * Pure degeneration-detection primitives for llm-degen-heal. No cordis
 * imports; everything here is a function of its inputs so the synthetic
 * self-test can drive the exact chunk streams a failing model produces.
 * @module llm-degen-heal/detect
 */

/** CJK ideograph range used to split dense runs into single-character tokens. */
const CJK = /[\u4E00-\u9FFF]/

/**
 * A "token" for detection purposes: whitespace-separated words plus
 * individual CJK ideographs. Splitting CJK runs into one token per ideograph
 * lets the detector catch "跑跑跑…" loops that whitespace tokenization would
 * fuse into one unbroken string.
 * @param text - deltas accumulated so far.
 * @returns the token sequence.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let latin = ''
  const flush = (): void => {
    if (latin.length > 0) {
      tokens.push(...latin.split(/\s+/).filter(Boolean))
      latin = ''
    }
  }
  for (const char of text) {
    if (CJK.test(char)) {
      flush()
      tokens.push(char)
    } else if (/\s/.test(char)) {
      flush()
    } else {
      latin += char
    }
  }
  flush()
  return tokens
}

/** Full result of classifying one rolling window. */
export interface WindowVerdict {
  /** Set when any configured degeneration signal fired. */
  degeneration: boolean
  /** Human-readable reason tags for the trigger log. */
  reasons: string[]
  /** Diagnosed per-signal flags. */
  tokenLoop: boolean
  entropyDrop: boolean
  /** True when the window shows thinking/planning text leaked as visible output. */
  leakOut: boolean
  /** The leaking markers matched in this window (diagnostic; empty when none). */
  leakMatches: string[]
  /** Rolling-window statistics snapshot for the trigger record. */
  stats: {
    tokens: number
    unique: number
    uniqueRatio: number
    topToken: string
    topCount: number
    structured: boolean
    /** Longest consecutive run of one short token (the token-loop signal). */
    runMax: number
    /** Longest consecutive alternating run in tokens (the pair-loop signal). */
    altMax: number
  }
}

/** Detection thresholds; defaults mirror the design doc. */
export interface DetectConfig {
  windowTokens: number
  shortTokenMaxLen: number
  repeatThreshold: number
  entropyRatio: number
  detectAlternating: boolean
  /** Marker phrases that indicate thinking/planning leaked into visible output. */
  leakMarkers: string[]
  /** Minimum marker match count (across the window) before `leak-out` fires. */
  leakThreshold: number
}

export const defaultDetectConfig: DetectConfig = {
  windowTokens: 256,
  shortTokenMaxLen: 32,
  repeatThreshold: 8,
  entropyRatio: 0.35,
  detectAlternating: true,
  leakMarkers: defaultLeakMarkers(),
  leakThreshold: 2,
}

/** Default leak-marker phrases (first-person planning / self-directed narrative leaked as output). */
export function defaultLeakMarkers(): string[] {
  return [
    'let me think',
    'let me start',
    'let me first',
    'let me check',
    'let me try',
    'let me work',
    'my plan is',
    'i will now',
    "i'm going to",
    '我思考一下',
    '我的思路是',
    '让我先',
    '让我来',
  ]
}

/** Append new tokens to a bounded rolling window, preserving insertion order. */
export function pushTokens(window: string[], additions: string[], size: number): string[] {
  const next = [...window, ...additions]
  return next.length > size ? next.slice(next.length - size) : next
}

/** Test whether a token is short enough to represent a stuck fragment. */
function shortToken(token: string, maxLen: number): boolean {
  if (token.length > maxLen) return false
  return /[A-Za-z0-9\u4E00-\u9FFF]/.test(token)
}

/** Whether the token carries visible structure (newline, fence, bullet, list numbering). */
function structuredToken(token: string): boolean {
  return /[`\n]/.test(token)
    || /^[-*]\s/.test(token)
    || /^\d+\.\s/.test(token)
}

/**
 * Longest consecutive run of identical short tokens in a window, plus the
 * token that forms it. A run of `的的的…` or `跑跑跑…` is the degenerate
 * signature; scattered occurrences of a frequent function word are not.
 */
function longestShortRun(window: string[], isShort: (token: string) => boolean): { token: string; length: number } {
  let runToken = ''
  let runLen = 0
  let best = { token: '', length: 0 }
  for (const token of window) {
    if (token === runToken && isShort(token)) {
      runLen += 1
    } else {
      runToken = token
      runLen = isShort(token) ? 1 : 0
    }
    if (runLen > best.length) best = { token: runToken, length: runLen }
  }
  return best
}

/**
 * Longest consecutive strict alternation A,B,A,B,… of two distinct short
 * tokens, measured in tokens. A degenerated alternating repeat is a *run*
 * (`高 的 高 的 高 的…`); scattered bigrams in ordinary prose are not. A run of
 * length L contains floor(L/2) pairs.
 */
function maxAlternatingRun(window: string[]): number {
  let best = 0
  let i = 0
  while (i + 1 < window.length) {
    if (window[i] === window[i + 1]) { i += 1; continue }
    const a = window[i]
    const b = window[i + 1]
    let len = 2
    let j = i + 1
    while (j + 1 < window.length) {
      const expected = ((j + 1 - i) % 2 === 0) ? a : b
      if (window[j + 1] !== expected) break
      len += 1
      j += 1
    }
    if (len > best) best = len
    i += 1
  }
  return best
}

/**
 * Count leak-marker matches in a token window. Markers (which may be
 * multi-word phrases or CJK fragments) are matched case-insensitively against
 * the window's joined text. Purely advisory: the result feeds the `leakOut`
 * signal and its diagnostic reasons.
 * @param window - the bounded token window, oldest first.
 * @param markers - lowercase marker phrases.
 * @returns `{ matches, hitCount }` — distinct matched markers and total matches.
 */
export function countLeakMatches(window: string[], markers: string[]): { matches: string[]; hitCount: number } {
  if (markers.length === 0 || window.length === 0) return { matches: [], hitCount: 0 }
  const text = window.join(' ').toLowerCase()
  const matches: string[] = []
  let hitCount = 0
  for (const marker of markers) {
    if (marker.length === 0) continue
    const needle = marker.toLowerCase()
    if (!text.includes(needle)) continue
    matches.push(marker)
    // Count non-overlapping occurrences (a marker may legitimately repeat,
    // and inside one degenerated window that repetition is itself the signal).
    let from = 0
    let hits = 0
    while ((from = text.indexOf(needle, from)) !== -1) {
      hits += 1
      from += needle.length
    }
    hitCount += hits
  }
  return { matches, hitCount }
}

/**
 * Classify one rolling token window against the configured signals. Pure:
 * the same input always yields the same verdict.
 * @param window - the bounded token window, oldest first.
 * @param config - detection thresholds.
 * @returns the verdict and snapshot statistics.
 */
export function classifyWindow(window: string[], config: DetectConfig): WindowVerdict {
  const tokens = window.length
  const unique = new Set(window).size
  const uniqueRatio = tokens === 0 ? 1 : unique / tokens

  const counts = new Map<string, number>()
  for (const token of window) counts.set(token, (counts.get(token) ?? 0) + 1)
  let topToken = ''
  let topCount = 0
  for (const [token, count] of counts) {
    if (shortToken(token, config.shortTokenMaxLen) && (count > topCount || (count === topCount && (topToken === '' || token < topToken)))) {
      topCount = count
      topToken = token
    }
  }
  let altMax = 0
  if (config.detectAlternating) altMax = maxAlternatingRun(window)
  const structured = window.some(structuredToken)
  // Degenerate signature: a run of the same short token, or a consecutive
  // strict alternation A,B,A,B,…. Global frequency is deliberately NOT a
  // signal — one frequent function word (e.g. 的) or a common bigram in an
  // ordinary Chinese window is not degeneration.
  const run = longestShortRun(window, candidate => shortToken(candidate, config.shortTokenMaxLen))
  const tokenLoop = run.length >= config.repeatThreshold || altMax >= 2 * config.repeatThreshold - 1
  const entropyDrop = uniqueRatio < config.entropyRatio && !structured
  const leakMarkers = config.leakMarkers ?? []
  const leakThreshold = config.leakThreshold ?? 2
  const leak = countLeakMatches(window, leakMarkers)
  const leakOut = leak.hitCount >= leakThreshold
  const reasons: string[] = []
  if (run.length >= config.repeatThreshold) reasons.push(`token-loop: run "${run.token}" x ${run.length}`)
  if (altMax >= 2 * config.repeatThreshold - 1) reasons.push(`pair-loop: alternating run x ${altMax} token`)
  if (entropyDrop) reasons.push(`entropy-drop: unique ${unique}/${tokens} (${(uniqueRatio * 100).toFixed(0)}%) unstructured`)
  if (leakOut) reasons.push(`leak-out: thinking/planning leaked as output (${leak.hitCount} hits: ${leak.matches.join(', ')})`)
  return {
    degeneration: tokenLoop || entropyDrop || leakOut,
    reasons,
    tokenLoop,
    entropyDrop,
    leakOut,
    leakMatches: leak.matches,
    stats: { tokens, unique, uniqueRatio, topToken, topCount, structured, runMax: run.length, altMax },
  }
}

/** One completed assistant step: the raw facts the idle meter aggregates. */
export interface StepFacts {
  turn: number
  step: number
  words: number
  chars: number
  toolCall: boolean
  degenerate: boolean
}

/**
 * Judgment on a whole assistant turn given the per-step facts of its model
 * calls. "Idle" is one turn with no tool calls, little text, and a degenerate
 * window; the meter then flags enough consecutive idle turns.
 */
export function assessTurn(steps: StepFacts[], idleTurnWords: number): {
  idle: boolean
  words: number
  toolCall: boolean
  degenerate: boolean
  reason: string
} {
  const words = steps.reduce((total, step) => total + step.words, 0)
  const toolCall = steps.some(step => step.toolCall)
  const degenerate = steps.length > 0 && steps.every(step => step.degenerate)
  const empty = words === 0 && !toolCall
  const idle = !empty && !toolCall && words < idleTurnWords && degenerate
  const reason = empty
    ? 'no output'
    : idle
      ? `${words} words, no tool call, degenerate window`
      : 'productive'
  return { idle, words, toolCall, degenerate, reason }
}
