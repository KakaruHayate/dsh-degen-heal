/**
 * llm-degen-heal — detect and self-heal LLM output degeneration loops.
 *
 * @module @dsh-external/llm-degen-heal
 *
 * Extension points used (all harness plugin extension points; no core code is
 * edited): `llm/stream` waterfall (streaming scan + escalate-interrupt),
 * `agent/pre-step` waterfall (inject the corrective message),
 * `agent/request` waterfall (rewrite temperature), `agent/request-error`
 * waterfall (bounded retry after a degenerate interrupt), `agent/turn-stopping`
 * serial (idle-turn meter escalation), and `ctx.tools.register` (the
 * `dev_loop_status` diagnostic surface).
 *
 * True `repetition_penalty`/`presence_penalty` wire fields are NOT expressible
 * plugin-only — see README "需核心改一行".
 *
 * `enabled` defaults to `true` in this deployment; a deployment that wants
 * observe-only behavior sets `enabled: false` explicitly.
 */

import type { Context } from 'cordis'
import z from 'schemastery'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { classifyWindow, countLeakMatches, pushTokens, tokenize, assessTurn, defaultLeakMarkers, type DetectConfig } from './detect.js'
import {
  armEpoch,
  configApplied,
  inEpoch,
  locked,
  markConfigApplied,
  markInjected,
  markLockout,
  newState,
  recover,
  record,
  triggersInEpoch,
  type SessionDegenState,
} from './state.js'
import type { DegenRecord } from './state.js'
import { validateConfig } from './validate.js'

export { classifyWindow, tokenize, assessTurn, pushTokens, countLeakMatches, defaultLeakMarkers } from './detect.js'
export * from './state.js'
export { validateConfig } from './validate.js'

/** The stable plugin identity, used as the `MessageSource.plugin` tag. */
export const name = '@dsh-external/llm-degen-heal'

/** Cordis services this plugin reads. `sessions` resolves live sessions for event logging. */
export const inject = ['agents', 'sessions'] as const

/** Default corrective message; covers both fragment loops and thought leakage. */
export const DEFAULT_HEAL_MESSAGE =
  'Degeneration detected: your previous output either repeated the same short '
  + 'fragments without making progress, or leaked your thinking/planning as visible '
  + 'prose instead of concise final answers. Stop writing fragments and stop writing '
  + 'your thought process into the reply. Truncate and rephrase from your last '
  + 'meaningful step, then make exactly ONE tool call now to make concrete progress. '
  + 'If the task is genuinely complete, say so in one short sentence and stop.'

export interface Config {
  enabled: boolean
  providers: string[]
  windowTokens: number
  shortTokenMaxLen: number
  repeatThreshold: number
  entropyRatio: number
  detectAlternating: boolean
  /** Marker phrases for thinking/planning leaked as visible output (see detect). */
  leakMarkers: string[]
  /** Minimum marker match count across the window before `leak-out` fires. */
  leakThreshold: number
  idleTurns: number
  idleTurnWords: number
  temperatureDelta: number
  cooldownMs: number
  escalateAt: number
  maxRetriesPerEpoch: number
  /** Escalations in one epoch after which detection is suspended (fail-open). */
  lockoutAt: number
  /** How long the lockout backoff lasts (ms). */
  lockoutMs: number
  healMessage: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  providers: z.array(z.string()).default([]),
  windowTokens: z.number().default(256),
  shortTokenMaxLen: z.number().default(32),
  repeatThreshold: z.number().default(8),
  entropyRatio: z.number().default(0.35),
  detectAlternating: z.boolean().default(true),
  leakMarkers: z.array(z.string()).default(defaultLeakMarkers()),
  leakThreshold: z.number().default(2),
  idleTurns: z.number().default(2),
  idleTurnWords: z.number().default(60),
  temperatureDelta: z.number().default(0),
  cooldownMs: z.number().default(30000),
  escalateAt: z.number().default(2),
  maxRetriesPerEpoch: z.number().default(1),
  lockoutAt: z.number().default(3),
  lockoutMs: z.number().default(180000),
  healMessage: z.string().default(DEFAULT_HEAL_MESSAGE),
})

/** Stable machine code this plugin owns for a degenerate-interrupt finish chunk. */
export const LLM_DEGENERATION = 'LLM_DEGENERATION'

const PLUGIN_SOURCE = { kind: 'plugin' as const, plugin: '@dsh-external/llm-degen-heal' }

/**
 * Session-event augmentation: durable, non-surface records of detection and
 * healing. Mirrors `dsh-llm-retry`'s `llm/retry` events. The data is plain
 * lossless JSON, so `Session.append` accepts it and persistence stores it.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'llm/degen-trigger': {
      turn: number
      step: number
      sessionId?: string
      reasons: string[]
      action: string
      stats: {
        tokens: number
        unique: number
        uniqueRatio: number
        topToken: string
        topCount: number
        structured: boolean
        runMax: number
        altMax: number
      }
    }
    'llm/degen-heal': {
      turn: number
      step: number
      sessionId?: string
      kind: 'config' | 'message' | 'retry' | 'meter'
      epoch: number
    }
  }
}

function sessionKey(id: SessionId | undefined): string {
  return String(id ?? '')
}

/** Per-stream accumulator (isolated so concurrent streams cannot mix). */
interface StreamAccum {
  turn: number
  step: number
  charCount: number
  wordCount: number
  toolCall: boolean
  degenerate: boolean
  classified: boolean
  armedAttempt: number
}

/** The record-kind vocabulary for the diagnostics ring (subset of DegenRecord‘s kind). */
type RingKind = DegenRecord['kind']

/** Default configuration values (must match the `Config` schema defaults). */
const DEFAULTS: Config = {
  enabled: true,
  providers: [],
  windowTokens: 256,
  shortTokenMaxLen: 32,
  repeatThreshold: 8,
  entropyRatio: 0.35,
  detectAlternating: true,
  leakMarkers: defaultLeakMarkers(),
  leakThreshold: 2,
  idleTurns: 2,
  idleTurnWords: 60,
  temperatureDelta: 0,
  cooldownMs: 30000,
  escalateAt: 2,
  maxRetriesPerEpoch: 1,
  lockoutAt: 3,
  lockoutMs: 180000,
  healMessage: DEFAULT_HEAL_MESSAGE,
}

/**
 * Plugin entry. `enabled` defaults to `true`; set `enabled: false` for a pure
 * observe-only (passthrough) install.
 * @param ctx - cordis context owning the listeners and live sessions.
 * @param configValue - plugin config; validated and merged with defaults.
 */
export function apply(ctx: Context, configValue?: Partial<Config>): void {
  const config = { ...DEFAULTS, ...configValue }
  validateConfig(config)
  const detectConfig: DetectConfig = {
    windowTokens: config.windowTokens,
    shortTokenMaxLen: config.shortTokenMaxLen,
    repeatThreshold: config.repeatThreshold,
    entropyRatio: config.entropyRatio,
    detectAlternating: config.detectAlternating,
    leakMarkers: config.leakMarkers,
    leakThreshold: config.leakThreshold,
  }
  const states = new Map<string, SessionDegenState>()

  function stateFor(session: Session | undefined): SessionDegenState | undefined {
    if (session === undefined) return undefined
    const key = sessionKey(session.id)
    if (key === '') return undefined
    let st = states.get(key)
    if (st === undefined) {
      st = newState()
      states.set(key, st)
    }
    return st
  }

  /** Whether this request participates (enabled, allowlist, conversation calls). */
  function participates(options: GenerateOptions): boolean {
    if (!config.enabled) return false
    if (options.sessionId === undefined) return false
    if (config.providers.length > 0 && !config.providers.includes(options.provider)) return false
    if (options.purpose !== undefined) return false
    return true
  }

  function logTrigger(st: SessionDegenState, session: Session | undefined, action: string): void {
    const verdict = st.lastVerdict
    const data = {
      turn: st.turn,
      step: st.step,
      sessionId: sessionKey(session?.id),
      reasons: verdict?.reasons ?? [],
      action,
      stats: {
        tokens: verdict?.stats.tokens ?? 0,
        unique: verdict?.stats.unique ?? 0,
        uniqueRatio: verdict?.stats.uniqueRatio ?? 1,
        topToken: verdict?.stats.topToken ?? '',
        topCount: verdict?.stats.topCount ?? 0,
        structured: verdict?.stats.structured ?? false,
        runMax: verdict?.stats.runMax ?? 0,
        altMax: verdict?.stats.altMax ?? 0,
      },
    }
    record(st, { at: Date.now(), kind: 'trigger', reasons: data.reasons, action, stats: data.stats })
    session?.append('llm/degen-trigger', data as never)
    ctx.logger?.info?.(`[llm-degen-heal] trigger session=${sessionKey(session?.id)} action=${action} reasons=${verdict?.reasons.join(' | ') ?? 'none'}`)
  }

  function ringRecord(st: SessionDegenState, kind: RingKind, action: string): void {
    record(st, { at: Date.now(), kind, reasons: [], action, step: { turn: st.turn, step: st.step } })
  }

  function logHeal(st: SessionDegenState, session: Session | undefined, kind: 'config' | 'message' | 'retry' | 'meter', epoch: number): void {
    const data = { turn: st.turn, step: st.step, sessionId: sessionKey(session?.id), kind, epoch }
    session?.append('llm/degen-heal', data as never)
    ringRecord(st, kind === 'meter' ? 'escalate' : 'heal', kind)
    ctx.logger?.info?.(`[llm-degen-heal] heal session=${sessionKey(session?.id)} kind=${kind} epoch=${epoch}`)
  }

  function healMessageUserMessage(): ReturnType<typeof createUserMessage> {
    return createUserMessage({
      content: [{ type: 'text', text: config.healMessage }],
      source: { ...PLUGIN_SOURCE, form: 'notice', summary: 'degeneration self-heal' },
    })
  }

  // ─── streaming detection + escalation interrupt ───
  ctx.on('llm/stream', function (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!participates(options)) return next()
    const session = options.sessionId === undefined ? undefined : ctx.sessions.get(options.sessionId)
    const st = stateFor(session)
    if (st === undefined) return next()
    if (locked(st)) return next()
    const downstream = next()
    const acc: StreamAccum = { turn: st.turn, step: st.step, charCount: 0, wordCount: 0, toolCall: false, degenerate: false, classified: false, armedAttempt: 0 }
    const interrupted = { value: false }

    const lockout = (): void => {
      markLockout(st, Date.now() + config.lockoutMs)
      logTrigger(st, session, `lockout (backoff ${config.lockoutMs}ms)`)
      st.lastVerdict = undefined
    }

    const classify = (force: boolean): void => {
      if (acc.classified) return
      if (!force && acc.charCount < 64) return
      acc.classified = true
      if (st.window.length === 0) return
      const verdict = classifyWindow(st.window, detectConfig)
      st.lastVerdict = verdict
      if (!verdict.degeneration) return
      acc.degenerate = true
      if (acc.armedAttempt === 0) {
        armEpoch(st, config.cooldownMs)
        acc.armedAttempt = triggersInEpoch(st)
      }
      if (acc.armedAttempt === 1) {
        logTrigger(st, session, 'armed')
      } else if (acc.armedAttempt >= config.escalateAt) {
        if (triggersInEpoch(st) >= config.lockoutAt) {
          // Deadlock escape hatch: escalating is not working. Fail open —
          // suspend detection for this session so the loop cannot keep
          // interrupting. This is the jump-out mechanism.
          lockout()
          return
        }
        logTrigger(st, session, 'escalate')
        ctx.logger?.info?.(`[llm-degen-heal] escalate interrupt session=${sessionKey(session?.id)} epoch=${st.epoch} attempt=${acc.armedAttempt}`)
        interrupted.value = true
      }
    }

    const finishError: StreamChunk = {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'LLM output degeneration detected; interrupted for self-heal retry',
          code: LLM_DEGENERATION,
        },
      },
    }

    return (async function* (): AsyncIterable<StreamChunk> {
      try {
        for await (const chunk of downstream) {
          if (interrupted.value) break
          if (chunk.type === 'text-delta') {
            const additions = tokenize(chunk.text)
            st.window = pushTokens(st.window, additions, detectConfig.windowTokens)
            acc.wordCount += additions.length
            acc.charCount += chunk.text.length
          } else if (chunk.type === 'tool-call-delta') {
            acc.toolCall = true
          }
          if (chunk.type === 'finish') classify(true)
          else classify(false)
          if (interrupted.value) continue
          yield chunk
        }
      } finally {
        if (!interrupted.value) {
          st.steps.push({
            turn: acc.turn,
            step: acc.step,
            words: acc.wordCount,
            chars: acc.charCount,
            toolCall: acc.toolCall,
            degenerate: acc.degenerate,
          })
          if (!acc.degenerate && st.lastVerdict?.degeneration === true) {
            st.lastVerdict = undefined
            recover(st)
            ringRecord(st, 'recover', 'healthy')
          }
        }
      }
      if (interrupted.value) {
        st.window = [] // fresh slate for the retried call
        yield finishError
        return
      }
    })()
  })

  // ─── pre-step: user reset + corrective-message injection ───
  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const st = states.get(sessionKey(agent.session.id))
    if (st !== undefined && messages.some(message => message.source.kind === 'user')) recover(st)
    if (st === undefined) return next()
    st.turn = turn
    st.step = step
    if (!inEpoch(st)) return next()
    const epoch = st.epoch
    if (st.injectedEpoch === epoch) return next()
    const downstream: PreStepDecision = await next()
    const result = downstream.kind === 'reject'
      ? downstream
      : { ...downstream, messages: [...downstream.messages, healMessageUserMessage()] }
    markInjected(st, epoch)
    logHeal(st, agent.session, 'message', epoch)
    return result
  })

  // ─── agent/request: temperature rewrite once per healing epoch ───
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const st = states.get(sessionKey(agent.session.id))
    if (st === undefined) return next()
    st.turn = turn
    st.step = step
    if (!inEpoch(st)) return next()
    const epoch = st.epoch
    if (configApplied(st, epoch)) return next()
    const base = await next()
    if (config.temperatureDelta === 0) return base
    const replacement = {
      ...base,
      temperature: Math.max(0, Math.min(2, (base.temperature ?? 1) + config.temperatureDelta)),
    }
    markConfigApplied(st, epoch)
    logHeal(st, agent.session, 'config', epoch)
    return replacement
  })

  // ─── agent/request-error: bounded retry for a degenerate interrupt ───
  ctx.on('agent/request-error', async ({ agent, failure }, next) => {
    if (failure.code !== LLM_DEGENERATION) return next()
    const st = states.get(sessionKey(agent.session.id))
    if (st === undefined || locked(st)) return next()
    if (!inEpoch(st)) return next()
    if (st.retryUsedInEpoch >= config.maxRetriesPerEpoch) return next()
    st.retryUsedInEpoch += 1
    logHeal(st, agent.session, 'retry', st.epoch)
    ctx.logger?.info?.(`[llm-degen-heal] grant degenerate retry session=${sessionKey(agent.session.id)} round=${st.retryUsedInEpoch}`)
    return { kind: 'retry' } satisfies RequestErrorAction
  })

  // ─── idle-turn meter: escalate a degenerate no-tool short-turn streak ───
  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const st = states.get(sessionKey(agent.session.id))
    if (st === undefined || locked(st)) return
    const turnFacts = st.steps.filter(step => step.turn === turn)
    st.steps = st.steps.filter(step => step.turn !== turn)
    if (turnFacts.length === 0) return
    const mapped = turnFacts.map(step => ({ turn: 0, step: 0, words: step.words, chars: step.chars, toolCall: step.toolCall, degenerate: step.degenerate }))
    const real = assessTurn(mapped, config.idleTurnWords)
    if (!real.idle) {
      if (real.words > 0 || real.toolCall) st.consecutiveIdle = 0
      return
    }
    st.consecutiveIdle += 1
    ctx.logger?.info?.(`[llm-degen-heal] idle meter session=${sessionKey(agent.session.id)} turn=${turn} consecutive=${st.consecutiveIdle} (${real.reason})`)
    if (st.consecutiveIdle >= config.idleTurns && inEpoch(st) && st.injectedEpoch !== st.epoch && !signal.aborted) {
      st.injectedEpoch = st.epoch
      logHeal(st, agent.session, 'meter', st.epoch)
      agent.steer(healMessageUserMessage())
    }
  })

  // ─── diagnostic tool: dev_loop_status (optional; absent headless) ───
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: 'dev_loop_status',
      description: 'Diagnose LLM output degeneration self-healing state: enabled flag, per-session window stats, recent trigger/heal records.',
      parameters: {
        sessionId: { type: 'string', description: 'Session id to detail (optional; defaults to all sessions summary)' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', required: true },
            sessions: {
              type: 'array',
              required: true,
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args) => {
        const want = args.sessionId
        const all = [...states.entries()].map(([id, st]) => ({
          sessionId: id,
          turn: st.turn,
          step: st.step,
          windowTokens: st.window.length,
          inEpoch: inEpoch(st),
          epoch: st.epoch,
          triggersInEpoch: triggersInEpoch(st),
          consecutiveIdle: st.consecutiveIdle,
          locked: locked(st),
          lastReasons: st.lastVerdict?.reasons ?? [],
          recent: st.ring.slice(-10).map(r => ({ ...r, at: r.at })),
        }))
        return {
          enabled: config.enabled,
          sessions: want === undefined ? all : all.filter(s => s.sessionId === want),
        }
      },
    }))
  })

  // HMR-safe teardown: clear process-local state when the fiber is disposed.
  ctx.effect(() => () => {
    states.clear()
  }, `${name}: clear degeneration state on dispose`)
}
