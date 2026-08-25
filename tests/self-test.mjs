/**
 * llm-degen-heal self-test - synthetic degeneration scenario, deterministic.
 *
 * Run from the plugin root: `node tests/self-test.mjs` (or `pnpm test`).
 * Uses the built lib/ and an in-process cordis Context + fake adapter, so it
 * works anywhere Node can resolve the plugin's linked node_modules.
 * All sources are ASCII (CJK test data is written as \u escapes) so the file
 * survives any tool that writes non-UTF8 content.
 */

import assert from 'node:assert/strict'
import { Context, Service } from 'cordis'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import * as plugin from '../lib/index.js'

/** A degenerate model script: many short fragments, no structure, no tool calls. */
const DEGEN_SCRIPT = Array.from({ length: 40 }, (_, i) => ({ type: 'text-delta', index: 0, text: `Word${i % 3} ` }))

/** A productive script: prose then a real code block. */
const HEALTHY_SCRIPT = [
  { type: 'text-delta', index: 0, text: 'The build failed because the linker could not find zlib. ' },
  { type: 'text-delta', index: 0, text: '```\nset(CMAKE_EXE_LINKER_FLAGS "-lz")\n```\n' },
  { type: 'text-delta', index: 0, text: 'I will rerun the build.' },
]

function chunksFrom(script, turn = 1, step = 1, sessionId = 'session-1') {
  return script.map(chunk => ({ ...chunk })).concat([
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
}

class FakeSessions extends Service {
  sessions = new Map()
  constructor(ctx) { super(ctx, 'sessions') }
  get(id) { return this.sessions.get(String(id)) }
  add(stub) { this.sessions.set(String(stub.id), stub) }
}

function makeSessionStub(id) {
  const events = []
  return {
    id,
    events,
    append(type, data) { events.push({ type, data }); return { type, data } },
  }
}

/** A scriptable LlmAdapter: `setScript` replaces what the next stream() emits. */
class ScriptedAdapter extends LlmAdapter {
  constructor() {
    super()
    this.provider = () => (async function* () {})()
    this.lastOptions = null
  }
  setScript(fn) { this.provider = fn }
  stream(options) {
    this.lastOptions = options
    const source = this.provider()
    // LlmRuntime expects an AsyncIterable; yield* normalizes a plain array too.
    return (async function* () { yield* source })()
  }
}

/** Create a context wired the way the plugin expects, with a scripted adapter. */
async function makeEnv() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const sessions = new FakeSessions(ctx) // Service constructor registers ctx.sessions
  const session = makeSessionStub('session-1')
  sessions.add(session)
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  return { ctx, sessions, session, adapter }
}

async function runCases() {
  console.log('[llm-degen-heal self-test] starting')
  let pass = 0
  const ok = (name) => { pass += 1; console.log(`  ok - ${name}`) }

  // ── 1. pure detection ──
  {
    const { tokenize } = plugin
    assert.deepEqual(tokenize('abc def  def'), ['abc', 'def', 'def'])
    // CJK "跑跑跑 hello" split per ideograph (escaped to keep the file ASCII).
    assert.deepEqual(tokenize('\u8dd1\u8dd1\u8dd1 hello'), ['\u8dd1', '\u8dd1', '\u8dd1', 'hello'])
    ok('tokenize splits words and CJK runs into per-character tokens')
  }
  {
    const { classifyWindow } = plugin
    const cfg = { windowTokens: 256, shortTokenMaxLen: 32, repeatThreshold: 8, entropyRatio: 0.35, detectAlternating: true }
    const degenerate = classifyWindow(Array.from({ length: 30 }, () => 'Word0'), cfg)
    assert.equal(degenerate.degeneration, true)
    assert.equal(degenerate.tokenLoop, true)
    const entropy = classifyWindow(['a', 'a', 'a', 'b', 'b', 'c'], cfg)
    // unique/total = 3/6 = 0.5 > 0.35, top count 3 < 8 -> healthy
    assert.equal(entropy.degeneration, false)
    const unstructured = classifyWindow(Array.from({ length: 20 }, (_, i) => `w${i % 4}`), { ...cfg, repeatThreshold: 20 })
    // unique 4/20 = 0.2 < 0.35, no structure -> entropy-drop
    assert.equal(unstructured.entropyDrop, true)
    assert.equal(unstructured.degeneration, true)
    const structured = classifyWindow(Array.from({ length: 20 }, (_, i) => `w${i % 4} \`fence\``), { ...cfg, repeatThreshold: 20 })
    assert.equal(structured.stats.structured, true)
    assert.equal(structured.degeneration, false)
    ok('classifyWindow catches token-loop, entropy-drop; honors structure')
  }
  {
    const { assessTurn } = plugin
    const idle = assessTurn([
      { turn: 1, step: 1, words: 10, chars: 50, toolCall: false, degenerate: true },
      { turn: 1, step: 2, words: 8, chars: 40, toolCall: false, degenerate: true },
    ], 60)
    assert.equal(idle.idle, true)
    const works = assessTurn([
      { turn: 2, step: 1, words: 200, chars: 1000, toolCall: false, degenerate: true },
    ], 60)
    assert.equal(works.idle, false)
    const callsTool = assessTurn([
      { turn: 3, step: 1, words: 10, chars: 50, toolCall: true, degenerate: true },
    ], 60)
    assert.equal(callsTool.idle, false)
    ok('assessTurn flags idle meter correctly (short, no tool call, degenerate)')
  }

  {
    const { classifyWindow, defaultLeakMarkers } = plugin
    const leakCfg = { windowTokens: 256, shortTokenMaxLen: 32, repeatThreshold: 100, entropyRatio: 0.01, detectAlternating: false, leakMarkers: defaultLeakMarkers(), leakThreshold: 2 }
    // Leaked thinking: repeated first-person planning phrases as visible prose.
    const leakText = Array.from({ length: 30 }, (_, i) => `Let me think ${i % 4}`)
    const leak = classifyWindow(leakText, leakCfg)
    assert.equal(leak.leakOut, true)
    assert.equal(leak.degeneration, true)
    assert.ok(leak.leakMatches.length >= 1)
    // A single incidental "let me check" does not fire.
    const benign = classifyWindow(['i', 'will', 'report', 'now', 'let', 'me', 'check', 'then', 'reply', 'done'], leakCfg)
    assert.equal(benign.leakOut, false)
    assert.equal(benign.degeneration, false)
    ok('classifyWindow catches thinking/planning leaked as visible output (leak-out), ignores incidental mentions')
  }

  {
    const { classifyWindow, tokenize } = plugin
    const cfg = { windowTokens: 256, shortTokenMaxLen: 32, repeatThreshold: 8, entropyRatio: 0.35, detectAlternating: true }
    // Realistic Chinese prose where the function word \u7684 (de) appears often
    // but never consecutively. Escaped to keep the file ASCII.
    const prose = '\u5f53\u524d\u4efb\u52a1\u662f\u4fee\u590d\u4e00\u4e2a\u63d2\u4ef6\u7684\u6b7b\u9501\u95ee\u9898\u3002\u6211\u4eec\u9700\u8981\u68c0\u67e5\u5b83\u7684\u6e90\u7801\u548c\u6784\u5efa\u6b65\u9aa4\u3002\u8fd9\u4e2a\u95ee\u9898\u7684\u6839\u6e90\u53ef\u80fd\u662f\u4ee5\u4e0b\u51e0\u70b9\u3002' // a normal sentence with several \u7684
    const tokens = tokenize(prose)
    // A window of many distinct tokens (high entropy) but with \u7684 scattered
    // 8 times — the exact shape that used to false-positive at "x 8".
    const window = []
    const vocab = Array.from(new Set(tokens.concat(['\u4fee\u590d', '\u63d2\u4ef6', '\u6e90\u7801', '\u6784\u5efa', '\u6b65\u9aa4', '\u95ee\u9898', '\u89e3\u51b3', '\u65b9\u6848', '\u68c0\u6d4b', '\u89e6\u53d1', '\u6d4b\u8bd5', '\u901a\u8fc7', '\u5e76\u4e14'])))
    while (vocab.length < 90) vocab.push(`W${vocab.length}`) // distinct filler, high entropy
    for (let i = 0; i < 240; i += 1) window.push(vocab[i % vocab.length])
    // place \u7684 at 8 scattered positions
    ;[10, 40, 72, 101, 133, 165, 204, 237].forEach(p => { window[p] = '\u7684' })
    const verdict = classifyWindow(window, cfg)
    assert.equal(verdict.tokenLoop, false, 'scattered \u7684 must not count as a token loop')
    assert.equal(verdict.degeneration, false, 'normal high-entropy CJK window must not fire')
    // But the same ideograph repeated into an actual run fires.
    const run = classifyWindow(['\u7684', '\u7684', '\u7684', '\u7684', '\u7684', '\u7684', '\u7684', '\u7684'], cfg)
    assert.equal(run.degeneration, true, 'a real repeated run must still fire')
    ok('classifyWindow: scattered CJK function words are NOT a loop; real runs still are')
  }
  {
    const { classifyWindow } = plugin
    const cfg = { windowTokens: 256, shortTokenMaxLen: 32, repeatThreshold: 8, entropyRatio: 0.35, detectAlternating: true }
    // Scattered common bigram (e.g. the frequent Chinese 2-token pair \u5f53\u524d)
    // appearing 8 times across a high-entropy window is NOT an alternating loop.
    const window = []
    const v2 = []
    while (v2.length < 90) v2.push(`T${v2.length}`)
    for (let i = 0; i < 240; i += 1) window.push(v2[i % v2.length])
    ;[3, 33, 66, 99, 132, 165, 198, 231].forEach(p => { window[p] = '\u5f53\u524d'; window[p + 1] = '\u95ee\u9898' })
    const scattered = classifyWindow(window, cfg)
    assert.equal(scattered.tokenLoop, false, 'scattered common bigram must not fire')
    assert.equal(scattered.degeneration, false, 'high-entropy prose with scattered bigram must not fire')
    // But a genuine consecutive alternation A,B,A,B,… fires: 16 tokens = 8 pairs.
    const alt = []
    for (let i = 0; i < 16; i += 1) alt.push(i % 2 === 0 ? '\u4f1a' : '\u7684') // 会 的 会 的 …
    const altVerdict = classifyWindow(alt, cfg)
    assert.equal(altVerdict.tokenLoop, true, 'consecutive alternation A,B,A,B must fire')
    ok('classifyWindow alternation: consecutive A,B,A,B fires; scattered common bigram does not')
  }
  // ── 2. integration: disabled = pure passthrough ──
  await (async () => {
    const { ctx, session, adapter } = await makeEnv()
    adapter.setScript(() => chunksFrom(DEGEN_SCRIPT))
    const eventsBefore = session.events.length
    plugin.apply(ctx, { enabled: false })
    const out = []
    for await (const chunk of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) out.push(chunk)
    assert.equal(out.some(c => c.type === 'finish' && c.reason.kind === 'error'), false)
    assert.equal(session.events.length, eventsBefore) // nothing logged when disabled
    assert.equal(out.filter(c => c.type === 'text-delta').length, DEGEN_SCRIPT.length) // passthrough, not merged
    ok('disabled config: llm/stream is a passthrough with no logging')
    ctx.stop?.()
  })()

  // ── 3. integration: armed -> escalate interrupt -> LLM_DEGENERATION finish error ──
  await (async () => {
    const { ctx, session, adapter } = await makeEnv()
    let callNo = 0
    adapter.setScript(() => {
      const n = callNo++
      // call 0: degenerate stream (arms the epoch, attempt 1)
      // call 1: degenerate stream (attempt 2 -> escalate interrupt)
      return chunksFrom(n === 0 ? DEGEN_SCRIPT : DEGEN_SCRIPT.slice(0, 8), 1, n + 1)
    })
    plugin.apply(ctx, { enabled: true, escalateAt: 2, maxRetriesPerEpoch: 1, cooldownMs: 1000 })
    const first = []
    for await (const c of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) first.push(c)
    assert.equal(first.at(-1).type, 'finish')
    assert.equal(first.at(-1).reason.kind, 'stop') // attempt 1 arms but does not interrupt
    assert.ok(session.events.some(e => e.type === 'llm/degen-trigger' && e.data.action === 'armed'))

    const second = []
    for await (const c of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) second.push(c)
    assert.equal(second.at(-1).type, 'finish')
    assert.equal(second.at(-1).reason.kind, 'error')
    assert.equal(second.at(-1).reason.failure.code, plugin.LLM_DEGENERATION)
    assert.ok(session.events.some(e => e.type === 'llm/degen-trigger' && e.data.action === 'escalate'))
    ok('llm/stream: attempt 1 arms, attempt 2 escalates to LLM_DEGENERATION finish')
    ctx.stop?.()
  })()

  // ── 3b. integration: thought-leak also arms and escalates (leak-out) ──
  await (async () => {
    const { ctx, session, adapter } = await makeEnv()
    const leakScript = Array.from({ length: 30 }, (_, i) => ({ type: 'text-delta', index: 0, text: `Let me think ${i % 4} ` }))
    let callNo = 0
    adapter.setScript(() => {
      const n = callNo++
      return chunksFrom(n === 0 ? leakScript : leakScript.slice(0, 8), 1, n + 1)
    })
    plugin.apply(ctx, { enabled: true, escalateAt: 2, maxRetriesPerEpoch: 1, cooldownMs: 1000 })
    const first = []
    for await (const c of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) first.push(c)
    assert.equal(first.at(-1).reason.kind, 'stop')
    // The trigger reason must carry the leak-out tag.
    assert.ok(session.events.some(e => e.type === 'llm/degen-trigger' && e.data.reasons.some(r => r.startsWith('leak-out'))))
    const second = []
    for await (const c of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) second.push(c)
    assert.equal(second.at(-1).reason.kind, 'error')
    assert.equal(second.at(-1).reason.failure.code, plugin.LLM_DEGENERATION)
    ok('thought-leak output arms the epoch and escalates through the SAME heal loop')
    ctx.stop?.()
  })()

  // ── 4. agent/request-error grants a bounded retry ──
  await (async () => {
    const { ctx, session, adapter } = await makeEnv()
    adapter.setScript(() => chunksFrom(DEGEN_SCRIPT))
    plugin.apply(ctx, { enabled: true, maxRetriesPerEpoch: 1, cooldownMs: 1000 })
    const agent = { session, options: { provider: 'test', model: 'm' } }
    // simulate an armed epoch by running one degenerate stream first
    for await (const _ of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) { /* drain */ }
    const dispatch = agentEvents(ctx, agent)
    const failure = { message: 'd', code: plugin.LLM_DEGENERATION }
    const firstOutcome = await dispatch.waterfall('agent/request-error', { turn: 1, step: 1, provider: 'test', failure, retryPolicy: undefined, signal: new AbortController().signal }, () => Promise.resolve(undefined))
    assert.equal(firstOutcome.kind, 'retry') // within budget -> retry
    const secondOutcome = await dispatch.waterfall('agent/request-error', { turn: 1, step: 1, provider: 'test', failure, retryPolicy: undefined, signal: new AbortController().signal }, () => Promise.resolve(undefined))
    assert.equal(secondOutcome, undefined) // budget exhausted -> terminal
    ok('agent/request-error: grants one retry per epoch, then stays terminal')
    ctx.stop?.()
  })()

  // ── 5. HMR/dispose cleanliness ──
  await (async () => {
    const { ctx, adapter } = await makeEnv()
    adapter.setScript(() => chunksFrom(DEGEN_SCRIPT.slice(0, 8)))
    plugin.apply(ctx, { enabled: true })
    for await (const _ of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) { /* drain */ }
    ctx.stop?.()
    ok('dispose/stop cleans up without throwing (HMR-safe teardown reached)')
  })()

  // ── 6. deadlock escape hatch: repeated escalation triggers lockout ──
  await (async () => {
    const { ctx, session, adapter } = await makeEnv()
    let callNo = 0
    adapter.setScript(() => {
      const n = callNo++
      return chunksFrom(n === 0 ? DEGEN_SCRIPT : DEGEN_SCRIPT.slice(0, 8), 1, n + 1)
    })
    // lockoutAt: 3 -> attempts 1(arm)/2(escalate+interrupt)/3(lockout fail-open).
    plugin.apply(ctx, { enabled: true, escalateAt: 2, maxRetriesPerEpoch: 1, cooldownMs: 1000, lockoutAt: 3, lockoutMs: 5000 })
    const calls = []
    for (let c = 0; c < 4; c += 1) {
      const out = []
      for await (const chunk of ctx.llm.stream({ provider: 'test', model: 'm', messages: [], sessionId: 'session-1' })) out.push(chunk)
      calls.push(out)
    }
    // Attempt 3 must NOT interrupt (lockout fail-open), i.e. a later call is passthrough.
    const anyError = calls.some(c => c.at(-1).type === 'finish' && c.at(-1).reason.kind === 'error')
    assert.equal(anyError, true) // escalate happened before lockout
    const lockTrigger = session.events.find(e => e.data?.action?.startsWith('lockout'))
    assert.ok(lockTrigger, 'expected a lockout trigger record')
    ok('repeated escalation fails open into lockout (deadlock escape)')
    ctx.stop?.()
  })()

  console.log(`[llm-degen-heal self-test] ALL PASS (${pass})`)
}

runCases().catch(error => {
  console.error('[llm-degen-heal self-test] FAILED', error)
  process.exitCode = 1
})
