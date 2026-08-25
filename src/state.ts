/**
 * Per-session degeneration state for llm-degen-heal: the rolling detection
 * window plus the healing epoch bookkeeping that makes every intervention
 * bounded, idempotent, and rollback-clean. Pure stems of the live machine;
 * the listeners in `index.ts` drive it from cordis events.
 * @module llm-degen-heal/state
 */

import type { StepFacts } from './detect.js'
import type { WindowVerdict } from './detect.js'

/** One recorded trigger or heal action, for the status/observability entry. */
export interface DegenRecord {
  at: number
  kind: 'trigger' | 'heal' | 'escalate' | 'recover'
  reasons: string[]
  step?: { turn: number; step: number }
  action: string
  stats?: WindowVerdict['stats']
}

/** Per-session state object; one per live session id. */
export interface SessionDegenState {
  window: string[]
  /** Latest loop turn observed (from `agent/pre-step`). */
  turn: number
  /** Latest loop step observed (from `agent/request`). */
  step: number
  /** Per-model-call facts for the current turn's idle assessment. */
  steps: StepFacts[]
  /** Consecutive idle turns >= threshold in `assessTurn` (the meter). */
  consecutiveIdle: number
  /** Healing epoch: increments on each fresh detection round. */
  epoch: number
  /** When the current epoch's first trigger fired (ms). */
  epochAt: number
  /** Cool-down boundary for the current epoch (ms). */
  cooldownUntil: number
  /** Degenerate model calls counted in the current epoch. */
  triggersInEpoch: number
  /** Whether pre-step already injected the corrective message this epoch. */
  injectedEpoch: number
  /** Whether agent/request already rewrote the config this epoch. */
  configAppliedEpoch: number
  /** How many degenerate-error retries were granted this epoch. */
  retryUsedInEpoch: number
  /** Lockout boundary (ms epoch time) after repeated escalation with no recovery. */
  lockoutUntil: number
  /** Full record ring for diagnostics (bounded). */
  ring: DegenRecord[]
  /** Last recorded verdict for the status entry. */
  lastVerdict?: WindowVerdict
}

export function newState(): SessionDegenState {
  return {
    window: [],
    turn: 0,
    step: 0,
    steps: [],
    consecutiveIdle: 0,
    epoch: 0,
    epochAt: 0,
    cooldownUntil: 0,
    triggersInEpoch: 0,
    injectedEpoch: 0,
    configAppliedEpoch: 0,
    retryUsedInEpoch: 0,
    lockoutUntil: 0,
    ring: [],
  }
}

const MAX_RING = 64

/** Append to the bounded observation ring (drop the oldest once full). */
export function record(st: SessionDegenState, entry: DegenRecord): void {
  st.ring.push(entry)
  if (st.ring.length > MAX_RING) st.ring.splice(0, st.ring.length - MAX_RING)
}

/**
 * Begin (or continue) a healing epoch. A fresh trigger after recovery starts
 * a new epoch; identical consecutive triggers stay in one epoch so the
 * escalation counter and cool-down act per round, not per token.
 * @param st - session state.
 * @param cooldownMs - configured cool-down.
 * @returns the active epoch id.
 */
export function armEpoch(st: SessionDegenState, cooldownMs: number, now = Date.now()): number {
  if (st.epochAt === 0 || now > st.cooldownUntil) {
    // Fresh round: reset this round's counters.
    st.epoch += 1
    st.epochAt = now
    st.cooldownUntil = now + cooldownMs
    st.triggersInEpoch = 0
    st.injectedEpoch = 0
    st.configAppliedEpoch = 0
    st.retryUsedInEpoch = 0
  }
  st.triggersInEpoch += 1
  return st.epoch
}

/** Whether the session is inside an active healing round. */
export function inEpoch(st: SessionDegenState, now = Date.now()): boolean {
  return st.epochAt !== 0 && now <= st.cooldownUntil
}

/** Number of degenerate model calls observed in the current round. */
export function triggersInEpoch(st: SessionDegenState, now = Date.now()): number {
  return inEpoch(st, now) ? st.triggersInEpoch : 0
}

/** Mark the corrective message injected for one epoch (idempotent single-shot). */
export function markInjected(st: SessionDegenState, epoch: number): void {
  st.injectedEpoch = epoch
}

/** Mark the request config rewritten for one epoch (idempotent single-shot). */
export function markConfigApplied(st: SessionDegenState, epoch: number): void {
  st.configAppliedEpoch = epoch
}

/** Whether the request-level mitigation already ran this epoch. */
export function configApplied(st: SessionDegenState, epoch: number): boolean {
  return st.configAppliedEpoch === epoch
}

/** Enter lockout: drop detection for this session until `untilMs` (epoch ms). */
export function markLockout(st: SessionDegenState, untilMs: number): void {
  st.lockoutUntil = untilMs
}

/** Whether the session is inside a lockout backoff (no detection, no interrupt). */
export function locked(st: SessionDegenState, now = Date.now()): boolean {
  return now <= st.lockoutUntil
}

/** Reset the round bookkeeping once the window read healthy again. */
export function recover(st: SessionDegenState): void {
  st.epoch = 0
  st.epochAt = 0
  st.cooldownUntil = 0
  st.triggersInEpoch = 0
  st.injectedEpoch = 0
  st.configAppliedEpoch = 0
  st.retryUsedInEpoch = 0
  st.consecutiveIdle = 0
  st.lockoutUntil = 0
  st.steps = []
}
