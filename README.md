# @dsh-external/llm-degen-heal

> **Detect and self-heal LLM output degeneration loops inside a DeepSeek Harness agent session.**
> **检测并自愈 DeepSeek Harness 代理会话中的 LLM 输出退化循环。**

Plugin-only implementation: hooks documented harness extension points, never edits core routing / session / serialize logic. Pure fail-open design — it cannot deadlock itself.
纯插件实现：挂接 Harness 文档化的扩展点，不修改任何核心 routing / session / serialize 逻辑。纯 fail-open 设计——自身不可能陷入死锁。

---

## Table of Contents / 目录

1. [Application Scenario / 应用场景](#application-scenario--应用场景)
2. [Architecture & Extension Points / 架构与接线点](#architecture--extension-points--架构与接线点)
3. [Detection Signals / 触发规则](#detection-signals--触发规则)
4. [Self-Healing Actions / 自愈动作](#self-healing-actions--自愈动作)
5. [State Machine & Safety / 状态机与安全](#state-machine--safety--状态机与安全)
6. [Configuration / 配置](#configuration--配置)
7. [Diagnostics / 诊断](#diagnostics--诊断)
8. [Installation / 安装](#installation--安装)
9. [Testing / 验收自测](#testing--验收自测)
10. [Known Limitations / 已知限制](#known-limitations--已知限制)
11. [License / 许可证](#license--许可证)

---

## Application Scenario / 应用场景

Long agent sessions — filled with tool result logs, CMake/build output, large snapshots — push the model into a **degeneration loop** at the tail:

长代理会话中，上下文被工具输出、CMake 日志、快照等内容塞满后，模型在收尾阶段容易陷入**退化循环**：

- consecutive turns emit meaningless short fragments (`Let me commit / Execute / Now / 跑`…) without ever issuing a tool call;
  连续多轮只输出无意义短碎词（"Let me commit / Execute / Now / 跑" 等），从不真正发出工具调用；
- "calls" often arrive with missing arguments (argument JSON truncated into fragments).
  偶有"调用"也常缺参数（JSON 被碎词截断）。

This is the classic *degenerate repetition* failure mode. The plugin detects it in-stream, self-heals with corrective injection / bounded retry, and (if escalation keeps failing) fail-opens into a per-session lockout so it can never trap a session in a retry loop.

这是典型的**退化重复**失效模式。本插件在流式输出中实时检测，通过修正注入 / 有界重试来自愈；若升级仍然失败，则对当前会话进入 fail-open lockout，确保不会把会话锁死在重试循环里。

### When You Need This Plugin / 何时需要

| Situation / 场景 | Without plugin / 无插件 | With plugin / 有插件 |
|---|---|---|
| Model emits 20× "Let me commit" then stops / 模型连发 20 次 "Let me commit" 后卡死 | User must manually intervene / 用户手动中断 | Auto-detected → corrective message + retry / 自动检测 → 修正注入 + 重试 |
| Alternating pair loop "OK. OK. OK. OK." / 交替对循环 "OK. OK. OK." | Wastes tokens until context overflow / 耗尽 token 才停 | Interrupt on 2nd trigger, temperature adjusted / 第 2 次触发即中断并调整 temperature |
| Model prints "我的思路是…" as visible output / 模型把"我的思路是…"当作可见输出 | Leaked reasoning pollutes response / 推理内容泄漏到回复 | `leak-out` detected → injected steer message / 检测到泄漏 → 注入引导消息 |
| 3+ idle turns with no tool calls / 3+ 个空转 turn 无工具调用 | Session stuck forever / 会话永久卡住 | Idle meter forces a tool-call steer / 空转仪表强制工具调用引导 |

---

## Architecture & Extension Points / 架构与接线点

### Plugin Identity / 插件标识

```
name:    '@dsh-external/llm-degen-heal'
inject:  ['agents', 'sessions']
```

The plugin consumes two Cordis services:
插件消费两个 Cordis 服务：

- `agents` — to access the current `Agent`, its `Session`, and to call `agent.steer()` for idle-meter injection.
  访问当前 `Agent`、其 `Session`，并通过 `agent.steer()` 注入空转仪表引导。
- `sessions` — to resolve live sessions by id for event logging (`session.append`).
  按 id 解析活跃会话，记录事件（`session.append`）。

### Harness Extension Points Used / 使用的 Harness 扩展点

The plugin registers listeners on **six** documented harness waterfall / serial events:
插件在 **六个** 文档化的 Harness waterfall / 串行事件上注册监听器：

| Event / 事件 | Type / 类型 | Purpose / 用途 |
|---|---|---|
| `llm/stream` | waterfall | Per-chunk tokenization, rolling window update, in-stream classification, escalate-interrupt | 逐 chunk 分词、滚动窗口更新、流内分类、升级中断 |
| `agent/pre-step` | waterfall | Idle-turn aggregation, corrective message injection (once per epoch) | 空转 turn 聚合、修正消息注入（每 epoch 一次） |
| `agent/request` | waterfall | Temperature rewrite (once per epoch, optional) | Temperature 重写（每 epoch 一次，可选） |
| `agent/request-error` | waterfall | Bounded retry for `LLM_DEGENERATION` interrupt finish reason | `LLM_DEGENERATION` 中断原因的有界重试 |
| `agent/turn-stopping` | serial | Idle-turn meter: escalate when consecutive idle turns exceed threshold | 空转仪表：连续空转 turn 超阈值时升级 |
| `ctx.tools.register` | injection | Register `dev_loop_status` diagnostic tool | 注册 `dev_loop_status` 诊断工具 |

Plus one lifecycle hook:
外加一个生命周期钩子：

| Hook / 钩子 | Purpose / 用途 |
|---|---|
| `ctx.effect(() => cleanup)` | Clear all process-local state on fiber dispose | fiber 释放时清空所有进程内状态 |

### Internal Module Structure / 内部模块结构

```
src/
  index.ts      — Plugin entry: listeners + tool registration (497 lines)
  detect.ts     — Pure detection primitives: tokenize, classifyWindow, assessTurn (297 lines)
  state.ts      — Per-session state machine: epoch, cooldown, lockout, ring (153 lines)
  validate.ts   — Fail-loud config validation (65 lines)
lib/            — tsc build output (entry points mirror src/)
```

| Module / 模块 | Dependencies / 依赖 | Purity / 纯度 | Testability / 可测性 |
|---|---|---|---|
| `detect.ts` | None (pure functions) / 无（纯函数） | 100% pure / 纯函数 | Unit-testable standalone / 可独立单测 |
| `state.ts` | `detect.ts` types only / 仅类型 | Pure state transitions / 纯状态转换 | Unit-testable standalone / 可独立单测 |
| `validate.ts` | None / 无 | Pure validation / 纯校验 | Unit-testable standalone / 可独立单测 |
| `index.ts` | cordis Context + all above / cordis + 以上全部 | Event-driven / 事件驱动 | Self-test with fake adapter / 自测用 fake adapter |

---

## Detection Signals / 触发规则

Four independent signals feed a per-session rolling token window (default 256 tokens). A signal fires only on a **true run** — global frequency and scattered bigrams in ordinary CJK prose are explicitly excluded.

四个独立信号作用于每会话的滚动 token 窗口（默认 256 token）。信号仅在**真正的连续重复**时触发——全局频率和普通中文语篇中的离散共现被明确排除。

### Signal 1: Token Loop (`tokenLoop`) / 碎词循环

A consecutive run of the same short token (≤ `shortTokenMaxLen` chars, default 32) ≥ `repeatThreshold` (default 8).

同一短词（≤ `shortTokenMaxLen` 字符，默认 32）连续出现 ≥ `repeatThreshold` 次（默认 8）触发。

**Examples that trigger / 触发示例：**

- `跑跑跑跑跑跑跑跑` (8×)
- `OK OK OK OK OK OK OK OK` (8×)
- `Execute Execute Execute Execute Execute Execute Execute Execute` (8×)

**Examples that do NOT trigger / 不触发示例：**

- `的的的的的的的的` in normal Chinese prose — `的` is a function word appearing naturally; **but** `跑跑跑…` does trigger because it is a content word repeated unnaturally.
  正常中文中的 `的的的的的的的的`——`的` 是自然出现的高频虚词；但 `跑跑跑…` 作为实词 unnatural 重复会触发。
- scattered occurrences of `的` across a long window — not a consecutive run.
  长窗口中离散散布的 `的`——不是连续 run。

### Signal 2: Alternating Pair Loop (`pairLoop`) / 交替对循环

Consecutive strict alternation `A B A B A B…` of two distinct short tokens, with run length ≥ `2 × repeatThreshold − 1` (default 15 tokens = 7½ pairs).

两个不同短词的严格交替 `A B A B A B…`，run 长度 ≥ `2 × repeatThreshold − 1`（默认 15 token = 7.5 对）触发。

**Examples that trigger / 触发示例：**

- `高 的 高 的 高 的 高 的 高 的 高 的 高 的 高 的 高` (15 tokens, 7 pairs)
- `OK . OK . OK . OK . OK . OK . OK . OK . OK . OK . OK . OK . OK . OK` (15 tokens)

**Examples that do NOT trigger / 不触发示例：**

- Scattered bigrams in prose like "高的评价是高的标准" — not a strict alternating run.
  语篇中的离散共现如 "高的评价是高的标准"——不是严格交替 run。

### Signal 3: Entropy Drop (`entropyDrop`) / 熵骤降

`unique-tokens / total-tokens < entropyRatio` (default 0.35) **AND** the window shows no structure (no code fences, no list bullets, no numbered lines, no newlines).

`unique-tokens / total-tokens < entropyRatio`（默认 0.35）**且**窗口无结构（无代码围栏、无列表标记、无编号行、无换行）触发。

This catches the case where the model has collapsed to emitting the same 1-2 tokens every call — unique ratio collapses but the window is too short to register as a token-loop.

这捕获模型每次调用只输出相同 1-2 个 token 的情况——unique ratio 崩溃但窗口长度不足以注册为 token-loop。

### Signal 4: Leak-Out (`leakOut`) / 思维泄漏

A configurable set of marker phrases (defaults include both English and Chinese planning language) hits ≥ `leakThreshold` (default 2) times in the window.

可配置的标记短语集合（默认同时包含英文和中文规划语言）在窗口中命中 ≥ `leakThreshold` 次（默认 2）触发。

**Default markers / 默认标记：**

| English / 英文 | Chinese / 中文 |
|---|---|
| `let me think` | `我思考一下` |
| `let me start` | `我的思路是` |
| `let me first` | `让我先` |
| `let me check` | `让我来` |
| `let me try` | |
| `let me work` | |
| `my plan is` | |
| `i will now` | |
| `i'm going to` | |

**Customization example / 自定义示例：**

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    leakMarkers:
      - 'let me think'
      - '我的思路是'
      - '先让我看看'
      - 'step by step'
```

### Signal 5: Idle-Turn Meter (`idle`) / 空转仪表

Aggregated at the **turn** granularity (not per-chunk). A turn is "idle" when:

在 **turn** 粒度聚合（非逐 chunk）。一个 turn 为"空转"当：

- no tool call was issued in the entire turn / 整个 turn 没有发出任何工具调用
- total text < `idleTurnWords` (default 60 words) / 总文本 < `idleTurnWords`（默认 60 词）
- every model call in the turn had a degenerate window / turn 内每次模型调用的窗口均为退化

Consecutive idle turns ≥ `idleTurns` (default 2) → meter fires and forces a tool-call steer.

连续空转 turn ≥ `idleTurns`（默认 2）→ 仪表触发并强制工具调用引导。

### Tokenization / 分词

CJK ideographs are split into single-character tokens; Latin text is whitespace-tokenized. This ensures `跑跑跑…` is caught as a run of individual characters, not fused into one unbreakable string.

CJK 汉字按单字切分；拉丁文本按空白分词。这确保 `跑跑跑…` 被识别为单字 run，而非融合为不可拆分的字符串。

---

## Self-Healing Actions / 自愈动作

When any detection signal fires, the plugin enters a **healing epoch** — a bounded, idempotent intervention round with cooldown.

任一检测信号触发后，插件进入**治愈 epoch**——一个有界、幂等的干预轮次，带冷却。

### Action Layers / 干预层级（按优先级）

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Corrective Message Injection (pre-step)            │
│  第 1 层：修正消息注入（pre-step）                            │
│                                                              │
│  "Degeneration detected: stop writing fragments, stop        │
│   leaking your thought process. Truncate and rephrase from   │
│   your last meaningful step, then make exactly ONE tool      │
│   call now to make concrete progress."                       │
│                                                              │
│  Injected once per epoch. Idempotent.                        │
│  每个 epoch 注入一次。幂等。                                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Temperature Rewrite (agent/request)                │
│  第 2 层：Temperature 重写（agent/request）                  │
│                                                              │
│  temperature ← clamp(base + temperatureDelta, [0, 2])        │
│  Default delta = 0 (disabled). Set > 0 to activate.         │
│  默认 delta = 0（关闭）。设为 > 0 启用。                      │
│  Applied once per epoch. Idempotent.                         │
│  每个 epoch 一次。幂等。                                      │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Stream Interrupt + Bounded Retry                   │
│  第 3 层：流中断 + 有界重试                                  │
│                                                              │
│  On escalateAt (default 2) triggers in one epoch:           │
│  同一 epoch 内达到 escalateAt（默认 2）次触发时：              │
│    - Yield finish chunk with reason.code = LLM_DEGENERATION  │
│    - agent/request-error grants 1 retry (maxRetriesPerEpoch) │
│    - Stream window cleared for fresh slate                   │
│                                                              │
│  On lockoutAt (default 3) triggers with no recovery:         │
│  达到 lockoutAt（默认 3）次且未恢复时：                        │
│    - Set lockoutUntil = now + lockoutMs                      │
│    - All detection silenced for this session                 │
│    - No interrupt, no retry, no steer — FAIL OPEN            │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Lockout (deadlock escape hatch)                    │
│  第 4 层：Lockout（死锁逃逸 hatch）                          │
│                                                              │
│  Independent of epoch cooldown. When escalation keeps        │
│  failing, detection suspends entirely — the session cannot   │
│  be trapped in a self-perpetuating interrupt/retry loop.     │
│                                                              │
│  Recovery: any healthy output, user message, or cooldown     │
│  expiry calls recover() and clears lockout.                  │
│  独立于 epoch 冷却。升级反复失败时完全暂停检测——会话不会陷入    │
│  自我维持的中断/重试循环。恢复条件：健康输出、用户消息、冷却到期。│
└─────────────────────────────────────────────────────────────┘
```

### Retry Semantics / 重试语义

When `agent/request-error` sees `failure.code === 'LLM_DEGENERATION'`:

- the degenerate stream's finish chunk carries `{ reason: { kind: 'error', failure: { code: 'LLM_DEGENERATION', message: '...' } } }`
- the error handler grants `{ kind: 'retry' }` if `retryUsedInEpoch < maxRetriesPerEpoch`
- the retried request carries the **same** session/turn/step, so the agent replays from the same logical position
- the window is cleared (`st.window = []`) before the retry, giving the model a clean slate

`LLM_DEGENERATION` 是一个 harness-recognized finish reason, not a generic error — the agent framework knows this is a controlled interrupt, not a transport failure.

`LLM_DEGENERATION` 是 harness 识别的 finish reason，不是泛泛 error——代理框架知道这是受控中断，不是传输故障。

### Idle-Turn Steer / 空转 Turn 引导

When the idle meter fires (`consecutiveIdle >= idleTurns && inEpoch && !injectedThisEpoch`):

- `agent.steer(healMessageUserMessage())` injects the corrective message as a high-priority system-style user message
- `source: { kind: 'plugin', plugin: '@dsh-external/llm-degen-heal', form: 'notice', summary: 'degeneration self-heal' }`
- The message content defaults to the built-in `DEFAULT_HEAL_MESSAGE`; override via `healMessage` config

空转仪表触发时，通过 `agent.steer()` 注入高优先级系统级用户消息，强制模型在下一轮发出真实工具调用。

---

## State Machine / 状态机

```
                    ┌──────────────────────────────────┐
                    │                                  │
                    ▼                                  │
             ┌──────────────┐                           │
             │   IDLE       │◄── recover() ──┐           │
             │   (正常)      │                 │           │
             └──────┬───────┘                 │           │
                    │ detect                 │           │
                    ▼                         │           │
             ┌──────────────┐                │           │
             │  IN_EPOCH    │                │           │
             │  (干预中)     │                │           │
             │  cooldown    │                │           │
             └──────┬───────┘                │           │
                    │                        │           │
          ┌─────────┼─────────┐              │           │
          │         │         │              │           │
          ▼         ▼         ▼              │           │
    inject    config    retry              │           │
    (1/epoch) (1/epoch) (maxRetries)        │           │
          │         │         │              │           │
          └─────────┼─────────┘              │           │
                    │ triggers >= lockoutAt  │           │
                    ▼                        │           │
             ┌──────────────┐                │           │
             │  LOCKOUT     │                │           │
             │  (fail-open) │                │           │
             └──────────────┘                │           │
                                               │           │
          ┌────────────────────────────────────┘           │
          │                                                 │
          │  healthy output / user message / cooldown expiry │
          │                                                 │
          └─────────────────────────────────────────────────┘
```

### Per-Session State Fields / 每会话状态字段

```typescript
interface SessionDegenState {
  window: string[]              // Rolling token buffer (max windowTokens)
                                // 滚动 token 缓冲（最大 windowTokens）
  turn: number                  // Current agent turn (from agent/pre-step)
                                // 当前代理 turn
  step: number                  // Current model call step (from agent/request)
                                // 当前模型调用 step
  steps: StepFacts[]            // Per-step facts for idle-turn assessment
                                // 空转评估的每步事实
  consecutiveIdle: number       // Consecutive idle turn count
                                // 连续空转 turn 计数
  epoch: number                 // Current healing epoch (increments per round)
                                // 当前治愈 epoch（每轮递增）
  epochAt: number               // Epoch start timestamp (ms)
                                // Epoch 起始时间戳
  cooldownUntil: number         // Epoch cooldown boundary (ms)
                                // Epoch 冷却边界
  triggersInEpoch: number       // Triggers counted in current epoch
                                // 当前 epoch 内触发计数
  injectedEpoch: number         // Last epoch that injected the corrective message
                                // 上次注入修正消息的 epoch
  configAppliedEpoch: number    // Last epoch that rewrote temperature
                                // 上次重写 temperature 的 epoch
  retryUsedInEpoch: number      // Retries granted in current epoch
                                // 当前 epoch 已授权重试次数
  lockoutUntil: number          // Lockout expiry (ms); 0 = not locked out
                                // Lockout 到期时间；0 = 未 lockout
  ring: DegenRecord[]           // Bounded observation ring (max 64 entries)
                                // 有界观察环（最多 64 条）
  lastVerdict?: WindowVerdict   // Most recent classification result
                                // 最近一次分类结果
}
```

### Idempotency Guarantees / 幂等保证

| Action / 动作 | Guard / 保护 | Scope / 范围 |
|---|---|---|
| Corrective message injection | `injectedEpoch === epoch` check before inject | Per epoch / 每 epoch |
| Temperature rewrite | `configAppliedEpoch === epoch` check before rewrite | Per epoch / 每 epoch |
| Retry grant | `retryUsedInEpoch < maxRetriesPerEpoch` | Per epoch / 每 epoch |
| Epoch arm | `now > cooldownUntil` resets all per-epoch counters | Cool-down boundary / 冷却边界 |
| Lockout | `locked(st)` silences all detection + interrupt + steer | Session-wide / 全会话 |

### Recovery Conditions / 恢复条件

`recover()` is called when:
以下情况调用 `recover()`：

- a streamed chunk finishes with `degenerate: false` AND the previous verdict was `degeneration: true` (the window has cleared)
  流式 chunk 以 `degenerate: false` 结束且上次 verdict 为 `degeneration: true`（窗口已清）
- a `user` message appears in `agent/pre-step` (user manually intervened)
  `agent/pre-step` 中出现 `user` 消息（用户手动干预）

Recovery resets epoch, cooldown, trigger count, consecutive idle, and lockout — the session returns to full detection sensitivity immediately.

恢复会重置 epoch、冷却、触发计数、连续空转和 lockout——会话立即恢复完整检测灵敏度。

---

## Configuration / 配置

All tunables are validated at plugin load (fail-loud on bad values). Override in your profile's `cordis.patch.yml`, `cordis.yml`, or inject config.

所有参数在插件加载时校验（非法值报错）。在你的 profile 的 `cordis.patch.yml`、`cordis.yml` 或 inject 配置中覆盖。

### Full Schema / 完整配置

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    # ── Master switch ──
    enabled: true                    # true = active; false = pure passthrough, no logging
                                     # true = 生效；false = 纯透传，无日志

    # ── Detection / 检测 ──
    providers: []                    # Provider allowlist; empty = all providers
                                     # Provider 白名单；空 = 全部
    windowTokens: 256                # Rolling token window size
                                     # 滚动 token 窗口大小
    shortTokenMaxLen: 32             # Max token length for "short token" classification
                                     # "短词"分类的最大 token 长度
    repeatThreshold: 8               # Consecutive identical short tokens to trigger token-loop
                                     # 触发碎词循环的连续相同短词数
    entropyRatio: 0.35               # unique/total below this (unstructured) → entropy-drop
                                     # unique/total 低于此值（无结构）→ 熵骤降
    detectAlternating: true          # Detect A B A B… pair loops
                                     # 检测 A B A B… 交替对循环
    leakMarkers: [...]               # Custom thinking/planning leak phrases (defaults built-in)
                                     # 自定义思维/规划泄漏短语（内建默认值）
    leakThreshold: 2                 # Marker hits in window before leak-out fires
                                     # 窗口内触发泄漏的标记命中次数
    idleTurns: 2                     # Consecutive idle turns before meter fires
                                     # 仪表触发前的连续空转 turn 数
    idleTurnWords: 60                # Word cap for "idle" turn classification
                                     # "空转" turn 分类的词数上限

    # ── Self-healing / 自愈 ──
    temperatureDelta: 0              # Temperature adjustment per epoch; 0 = disabled, range [-2, 2]
                                     # 每 epoch 的 temperature 调整；0 = 关闭，范围 [-2, 2]
    cooldownMs: 30000                # Healing epoch cooldown (ms); triggers within this window stay in one epoch
                                     # 治愈 epoch 冷却（毫秒）；此窗口内的触发归入同一 epoch
    escalateAt: 2                    # Trigger count in epoch that causes stream interrupt
                                     # epoch 内达到此触发数时中断流
    maxRetriesPerEpoch: 1            # Max retry grants per epoch (0 = detect-only, no retry)
                                     # 每 epoch 最大重试授权数（0 = 仅检测，不重试）
    lockoutAt: 3                     # Triggers in epoch before fail-open lockout
                                     # epoch 内触发数超过此值进入 fail-open lockout
    lockoutMs: 180000                # Lockout duration (ms); 180000 = 3 minutes
                                     # Lockout 持续时间（毫秒）；180000 = 3 分钟

    # ── Corrective message / 修正消息 ──
    healMessage: |                  # Message injected when degeneration is detected
      Degeneration detected: your previous output either repeated the same
      short fragments without making progress, or leaked your thinking/planning
      as visible prose instead of concise final answers. Stop writing fragments
      and stop writing your thought process into the reply. Truncate and rephrase
      from your last meaningful step, then make exactly ONE tool call now to make
      concrete progress. If the task is genuinely complete, say so in one short
      sentence and stop.
```

### Quick-Tune Presets / 快速调参

**Observe-only (no intervention / 仅观察，不干预):**

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    enabled: true        # still logs; set false to silence entirely
    maxRetriesPerEpoch: 0
    temperatureDelta: 0
```

**Aggressive (interrupt early / 激进，尽早中断):**

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    repeatThreshold: 5
    escalateAt: 1
    maxRetriesPerEpoch: 2
    temperatureDelta: 0.3
```

**Lenient (high tolerance / 宽松，高容忍):**

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    repeatThreshold: 12
    entropyRatio: 0.25
    idleTurns: 4
    lockoutAt: 5
```

---

## Diagnostics / 诊断

### `dev_loop_status` Tool / 诊断工具

Registered via `ctx.tools.register` — available as a callable tool in-session.

通过 `ctx.tools.register` 注册——会话内可作为可调用工具使用。

```json
{
  "enabled": true,
  "sessions": [
    {
      "sessionId": "abc-123",
      "turn": 5,
      "step": 3,
      "windowTokens": 142,
      "inEpoch": true,
      "epoch": 2,
      "triggersInEpoch": 1,
      "consecutiveIdle": 1,
      "locked": false,
      "lastReasons": ["token-loop: run \"跑\" x 9"],
      "recent": [
        { "at": 1693001234567, "kind": "trigger", "reasons": ["token-loop: run \"跑\" x 9"], "action": "armed" },
        { "at": 1693001234789, "kind": "heal", "action": "message", "step": { "turn": 5, "step": 2 } }
      ]
    }
  ]
}
```

| Field / 字段 | Meaning / 含义 |
|---|---|
| `enabled` | Plugin master switch / 插件总开关 |
| `sessionId` | Session identifier / 会话 ID |
| `turn` / `step` | Current agent turn and model-call step / 当前代理 turn 和模型调用 step |
| `windowTokens` | Tokens currently in the rolling window / 滚动窗口中的 token 数 |
| `inEpoch` | Whether the session is inside an active healing epoch / 是否在活跃治愈 epoch 中 |
| `epoch` | Current epoch number / 当前 epoch 编号 |
| `triggersInEpoch` | Triggers counted in this epoch / 本 epoch 内触发次数 |
| `consecutiveIdle` | Consecutive idle turns / 连续空转 turn 数 |
| `locked` | Whether the session is in lockout / 是否在 lockout 中 |
| `lastReasons` | Human-readable trigger reasons / 人类可读的触发原因 |
| `recent` | Last 10 ring records (trigger / heal / escalate / recover) / 最近 10 条环记录 |

### Session Log Events / 会话日志事件

Two custom event types are declared via cordis module augmentation and appended to the session's event log:

两个自定义事件类型通过 cordis 模块扩充声明，追加到会话事件日志：

| Event / 事件 | Data / 数据 | When / 时机 |
|---|---|---|
| `llm/degen-trigger` | `turn`, `step`, `sessionId`, `reasons[]`, `action` (`armed`/`escalate`/`lockout`), `stats` (tokens, unique, uniqueRatio, topToken, topCount, structured, runMax, altMax) | Detection fires / 检测触发 |
| `llm/degen-heal` | `turn`, `step`, `sessionId`, `kind` (`message`/`config`/`retry`/`meter`), `epoch` | Intervention taken / 执行干预 |

### Harness Logger / Harness 日志

All actions log via `ctx.logger.info()` with the `[llm-degen-heal]` prefix:

所有动作通过 `ctx.logger.info()` 记录，前缀 `[llm-degen-heal]`：

```
[llm-degen-heal] trigger session=abc-123 action=armed reasons=token-loop: run "跑" x 9
[llm-degen-heal] heal session=abc-123 kind=message epoch=2
[llm-degen-heal] escalate interrupt session=abc-123 epoch=2 attempt=2
[llm-degen-heal] grant degenerate retry session=abc-123 round=1
[llm-degen-heal] idle meter session=abc-123 turn=5 consecutive=2 (123 words, no tool call, degenerate window)
[llm-degen-heal] heal session=abc-123 kind=meter epoch=2
```

---

## Installation / 安装

### Prerequisites / 前置要求

- A DeepSeek Harness checkout (`J:\deepseek-harness` monorepo) — for type-check deps and tsc.
  DeepSeek Harness  checkout——用于类型检查和编译。
- Node.js 20+ and pnpm (harness standard).
  Node.js 20+ 和 pnpm（harness 标准）。
- Bash (the build script is POSIX sh; use Git Bash on Windows).
  Bash（构建脚本为 POSIX sh；Windows 使用 Git Bash）。
- `gh` CLI or git to fetch this repo.
  `gh` CLI 或 git 拉取本仓库。

### 1. Clone / 克隆

```bash
git clone https://github.com/KakaruHayate/dsh-degen-heal.git
cd dsh-degen-heal
```

### 2. Build / 构建

```bash
# Linux / macOS
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh

# Windows (Git Bash)
DSH_CHECKOUT=Z:/path/to/deepseek-harness bash scripts/build.sh
```

`scripts/build.sh` probes `DSH_CHECKOUT`, junction-links the harness packages the plugin type-checks against, and compiles `src/ → lib/` with the checkout's tsc.

`scripts/build.sh` 探测 `DSH_CHECKOUT`，将插件类型检查所需的 harness 包做 junction 链接，然后用 checkout 的 tsc 编译 `src/ → lib/`。

### 3. Harness Profile Integration / 接入 Harness Profile

Add to your profile's `package.json` dependencies and bundles:

```json
{
  "dependencies": {
    "@dsh-external/llm-degen-heal": "link:C:/path/to/dsh-degen-heal"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dsh-external/llm-degen-heal"
      ]
    }
  }
}
```

Or hot-inject without modifying profile files:

```bash
dev_inject_plugin --dir /abs/path/to/dsh-degen-heal
```

The plugin is `enabled: true` by default. Set `enabled: false` for observe-only (passthrough with logging).

插件默认 `enabled: true`。设为 `false` 为仅观察模式（透传 + 日志）。

### 4. Verify / 验证

```bash
pnpm test          # Run the self-test from the plugin root
# or
dsh web            # Start harness; check dev_loop_status tool
```

---

## Testing / 验收自测

### `tests/self-test.mjs` — Synthetic Deterministic Self-Test

No real provider call needed. Uses an in-process `cordis.Context` + `ScriptedAdapter` (a programmable `LlmAdapter` whose `stream()` replays a pre-scripted chunk sequence).

无需真实 provider 调用。使用进程内 `cordis.Context` + `ScriptedAdapter`（可编程的 `LlmAdapter`，其 `stream()` 回放预编写的 chunk 序列）。

**Test scripts / 测试脚本：**

| Script / 脚本 | Purpose / 用途 |
|---|---|
| `DEGEN_SCRIPT` | 40 chunks of `Word0 Word1 Word2` cycling — classic token-loop degenerate output / 40 个 `Word0 Word1 Word2` 循环 chunk——经典碎词循环退化输出 |
| `HEALTHY_SCRIPT` | Prose + code block + tool call — structured, productive output / 散文 + 代码块 + 工具调用——结构化、有产出 |

**Test cases / 测试用例：**

| # | Case / 场景 | Assertion / 断言 |
|---|---|---|
| 1 | Token-loop detection (DEGEN_SCRIPT) | `tokenLoop = true`, `degeneration = true` |
| 2 | Entropy-drop + no structure | `entropyDrop = true` on unstructured low-diversity window |
| 3 | Leak-out detection | `leakOut = true` when marker phrases appear ≥ threshold |
| 4 | Healthy passthrough (HEALTHY_SCRIPT) | `degeneration = false`, no injection, no interrupt |
| 5 | Disabled passthrough | `enabled: false` → zero intervention, zero log |
| 6 | Arm → escalate → `LLM_DEGENERATION` → bounded retry | Stream interrupted on trigger #2, retry granted, `retryUsedInEpoch` capped |
| 7 | Disposal cleanup | `ctx.effect` cleanup runs; `states` Map cleared |
| 8 | Lockout deadlock escape | After `lockoutAt` triggers with no recovery → `locked = true`, all detection silenced |

### Manual Verification / 手动验证

In a live harness session:

```bash
# 1. Start harness
dsh web

# 2. Open dev tools or run the diagnostic tool
dev_loop_status
# → { enabled: true, sessions: [...] }

# 3. (Optional) Force a degenerate scenario by appending a patch:
#    - insert a loop of short repeated tokens in a test agent prompt
#    - Observe the trigger → heal → recover cycle in dev_loop_status output
```

---

## Extension Points for Future Integration / 未来集成扩展点

### `LlmRuntime` Waterfall (tool-cordis `api-catalog.ts`)

The harness ships a waterfall around every streaming model call at `packages/extensions/tool-cordis/src/api-catalog.ts` (`LlmRuntime`). The current plugin hooks `llm/stream` directly, which is the public-facing event alias for this waterfall. If the harness later exposes additional waterfall stages (e.g., pre-token hooks, post-stream analysis), the plugin can be extended to listen on those stages without changing its core detection logic.

Harness 在 `packages/extensions/tool-cordis/src/api-catalog.ts` (`LlmRuntime`) 为每次流式模型调用提供了一个 waterfall。当前插件直接挂接 `llm/stream`，该事件是此 waterfall 的公开别名。如果 Harness 后续暴露更多 waterfall 阶段（如 pre-token hooks、post-stream analysis），插件可在不改变核心检测逻辑的前提下扩展监听。

### `repetition_penalty` / `presence_penalty` Wire Fields

As of the current harness version, `packages/llm/llm-deepseek/src/serialize.ts` only forwards `temperature`, `max_tokens`, `stop`, and reasoning fields. There is no `repetition_penalty`, `frequency_penalty`, or `presence_penalty` field in `GenerateOptions` or `LlmCallConfig`.

在当前 Harness 版本中，`packages/llm/llm-deepseek/src/serialize.ts` 只透传 `temperature`、`max_tokens`、`stop` 和 reasoning 字段。`GenerateOptions` 和 `LlmCallConfig` 中没有 `repetition_penalty`、`frequency_penalty` 或 `presence_penalty` 字段。

**Workaround / 变通方案：** The plugin substitutes with (a) corrective message injection (Layer 1) and (b) temperature adjustment (Layer 2). Both are provider-agnostic and work with any LLM backend.

**变通方案：** 插件用 (a) 修正消息注入（第 1 层）和 (b) temperature 调整（第 2 层）替代。两者均与 provider 无关，适用于任何 LLM 后端。

**Core change required for true penalty injection / 真正 penalty 注入所需的核心改动：**

A one-line addition to `packages/llm/llm/src/types.ts` (`LlmCallConfig` interface) and a corresponding passthrough in `packages/llm/llm-deepseek/src/serialize.ts` would enable:

```typescript
// packages/llm/llm/src/types.ts — add to LlmCallConfig:
repetition_penalty?: number
presence_penalty?: number
```

```typescript
// packages/llm/llm-deepseek/src/serialize.ts — add to serialize() output:
...(call.repetition_penalty !== undefined ? { repetition_penalty: call.repetition_penalty } : {}),
...(call.presence_penalty !== undefined ? { presence_penalty: call.presence_penalty } : {}),
```

This is intentionally **not done in the plugin** — per the constraint that the plugin must not modify core packages. If you want this, it is a one-line core change that any DSH maintainer can review and merge independently.

此改动**有意不在插件内完成**——按插件不修改核心包的约束。如需此功能，是一行核心改动，任何 DSH maintainer 可独立审核合并。

### `dev_router_mode` Band Escalation

The plugin does **not** call `dev_router_mode` itself. Band escalation (e.g., `weak → strong`) is left to:

- the operator, who can call `dev_router_status` / `dev_router_mode` manually after seeing a lockout or repeated triggers in `dev_loop_status`
- a future harness extension point that exposes a programmatic "escalate band" signal

插件**不**主动调用 `dev_router_mode`。Band 升级（如 `weak → strong`）留给：

- 操作员：在 `dev_loop_status` 中看到 lockout 或反复触发后手动调用 `dev_router_status` / `dev_router_mode`
- 未来 Harness 扩展点：暴露程序化的 "escalate band" 信号

---

## Known Limitations / 已知限制

| # | Limitation / 限制 | Severity / 严重程度 | Workaround / 变通 |
|---|---|---|---|
| 1 | No wire-level `repetition_penalty` / `presence_penalty` passthrough | Medium / 中 | Temperature delta + corrective message injection (Layers 1 + 2) |
| 2 | No true history rollback ("revert to previous assistant message") | Low / 低 | Interrupt + steer gives the model a fresh start contextually |
| 3 | Does not call `dev_router_mode` for band escalation | Low / 低 | Operator-driven via `dev_loop_status` discovery |
| 4 | Detection window is per-stream, not cross-session | Low / 低 | State is per-session (`SessionDegenState` keyed by sessionId); cross-session aggregation would be a future feature |
| 5 | CJK tokenization splits by character (not by word) | Info / 提示 | Deliberate design choice: catches character-level loops (`跑跑跑…`) that whitespace tokenization would miss. For word-level CJK detection, a dictionary-based segmenter could be added. |
| 6 | `lockoutMs` max 3 minutes prevents permanent silencing but may be too short for very long sessions | Info / 提示 | Tune `lockoutMs` per deployment; set to 0 to disable lockout entirely (not recommended) |

---

## License / 许可证

BSD-3-Clause. See `package.json`.
