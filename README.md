# @dsh-external/llm-degen-heal

Detect and self-heal LLM [output degeneration loops](https://en.wikipedia.org/wiki/Text_generation#Degenerative_behavior) inside a DeepSeek Harness agent session. 检测并自愈 LLM 输出退化循环（长会话收尾阶段的碎词循环 / 熵塌陷 / 思维链泄漏 / 空转 turn）。

Plugin-only implementation: it hooks documented harness extension points and never edits core routing / session / serialize logic. Pure fail-open design — it cannot deadlock itself (see [死锁逃逸](#死锁逃逸lockout-语义)).

## Application scenario 应用场景

Long agent sessions (tool result logs, build/CMake output, big snapshots filling context) push the model into a **degeneration loop** at the tail:

- consecutive turns emit meaningless short fragments (`Let me commit / Execute / Now / 跑`…) without ever issuing a tool call;
- "calls" often arrive with missing arguments (argument JSON truncated into fragments).

This is the classic *degenerate repetition* failure mode. The plugin detects it in-stream, self-heals with a corrective injection / bounded retry, and (if escalation keeps failing) fail-opens into a per-session lockout so it can never trap a session in a retry loop.

```bash
pnpm test        # or from the plugin root: node tests/self-test.mjs
```

## Installation 安装

The plugin is a source package (`.gitignore`: `node_modules/`, `lib/` are never tracked). Install by building against a DeepSeek Harness checkout, then hot-inject.

### 1. Requirements

- A DeepSeek Harness checkout (the DSH monorepo) — for type-check deps and tsc.
- Node.js + pnpm (harness standard), plus bash (the build script is POSIX sh).
- `gh` CLI / git to fetch this repo.

### 2. Clone & build

```bash
git clone https://github.com/KakaruHayate/dsh-degen-heal.git
cd dsh-degen-heal
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh
# Windows example: set DSH_CHECKOUT=Z:\path\to\deepseek-harness then run git-bash:
#   DSH_CHECKOUT=Z:\path\to\deepseek-harness bash scripts/build.sh
```

`scripts/build.sh` probes `DSH_CHECKOUT`, junction-links the harness packages the plugin type-checks against, and compiles `src/ → lib/` with the checkout's tsc.

### 3. Hot-inject (no restart)

Use the harness dev pipeline:

```bash
dev_inject_plugin --dir /abs/path/to/dsh-degen-heal
```

or load it at runtime through your profile configuration (see the plugin form used by `dev_scaffold_plugin` / `dev_install_package` in the harness). The plugin is `enabled: true` by default.

## Configuration 配置

Every tunable is a validated config field (fail-loud on bad values). Override in your `cordis.yml` / profile patch / inject config:

```yaml
plugins:
  '@dsh-external/llm-degen-heal':
    enabled: true
    # windowTokens: 256        # detection rolling window
    # repeatThreshold: 8       # run length that flags a token-loop
    # entropyRatio: 0.35       # unique/total below this (unstructured) => entropy-drop
    # detectAlternating: true  # detect consecutive A,B,A,B,… runs
    # idleTurns: 2             # no-tool short degenerate turns before meter steer
    # idleTurnWords: 60
    # temperatureDelta: 0      # request temp adjust per healing epoch (0 disables)
    # cooldownMs: 30000        # healing epoch cooldown
    # escalateAt: 2            # which degenerate stream causes the interrupt
    # maxRetriesPerEpoch: 1    # bounded retries per epoch
    # lockoutAt: 3             # triggers in one epoch before fail-open lockout
    # lockoutMs: 180000        # lockout suspension duration
    # healMessage: "..."       # corrective prompt injected to the model
```

| field | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch; `false` = pure passthrough with no logging |
| `providers` | `[]` | provider allowlist, empty = all |
| `windowTokens` | `256` | detection rolling window size |
| `shortTokenMaxLen` | `32` | short-token length cap |
| `repeatThreshold` | `8` | run length (same token, or alternating) that flags a loop |
| `entropyRatio` | `0.35` | entropy-drop threshold |
| `detectAlternating` | `true` | also count consecutive `A B A B…` runs |
| `leakMarkers` | built-in | phrases treated as leaked thinking/planning prose |
| `leakThreshold` | `2` | marker hits in a window before `leak-out` fires |
| `idleTurns` | `2` | consecutive idle turns before the meter acts |
| `idleTurnWords` | `60` | idle turn word cap |
| `temperatureDelta` | `0` | request temperature adjust per healing epoch (0 disables) |
| `cooldownMs` | `30000` | healing epoch cooldown |
| `escalateAt` | `2` | which degenerate stream triggers the interrupt |
| `maxRetriesPerEpoch` | `1` | degenerate retries granted per epoch |
| `lockoutAt` | `3` | triggers in one epoch before fail-open lockout |
| `lockoutMs` | `180000` | lockout suspension duration |
| `healMessage` | built-in | corrective message injected to the model |

## How it works 触发规则与自愈

Four signals feed a per-session rolling window (default 256 tokens):

1. **token-loop**: a *consecutive run* of the same short token ≥ `repeatThreshold`, or a consecutive alternation `A B A B…` ≥ `2*repeatThreshold-1` tokens. Global frequency/bigram counts are deliberately NOT signals — scattered 的 or a common Chinese bigram in ordinary prose is not degeneration; only a true run is.
2. **entropy-drop**: unique/total < `entropyRatio` and no structure (code fence, list, numbered line, newline).
3. **leak-out**: planning/thinking phrasing (`let me think`, `我的思路是`, …) hits ≥ `leakThreshold` times — model printing reasoning as visible output.
4. **idle-turn meter**: ≥ `idleTurns` consecutive turns with no tool call, < `idleTurnWords` words, and a degenerate window.

When triggered: inject a corrective system-level message once per epoch, optionally adjust temperature, then escalate to a stream interrupt + bounded retry. Every action is idempotent (single-shot per epoch), cooled down, recorded to the session log (`llm/degen-trigger`, `llm/degen-heal`) and `ctx.logger`.

### 死锁逃逸（lockout）语义

独立于上述 epoch 的兜底：当同一 epoch 内退化触发数达到 `lockoutAt`，写 `lockoutUntil = now + lockoutMs` 并记录一条 `action: lockout (...)` 触发；期间 `llm/stream` 完全透传、`request-error` 不授权 retry、`turn-stopping` 不 steer —— **fail-open**。任何健康输出 / 用户输入 / 冷却自然 `recover()` 也一并清 `lockoutUntil`。

## Diagnostics 诊断

`dev_loop_status` tool：`enabled`、每 session 窗口 token 数、epoch、`triggersInEpoch`、`consecutiveIdle`、`locked`、最近 10 条记录（原因/动作/窗口统计）。会话日志含 `llm/degen-trigger` 与 `llm/degen-heal` 事件。

## Testing 验收自测

`tests/self-test.mjs` — synthetic, deterministic, no real provider call needed. Covers: detection correctness (including scattered-CJK-和-scattered-bigram regressions don't fire, real runs fire), thought-leak path, disabled passthrough, arm→escalate→`LLM_DEGENERATION`→bounded retry, dispose cleanliness, and the **lockout deadlock escape**.

## Known limitations

- No wire-level `repetition_penalty`/`presence_penalty` — `packages/llm/llm-deepseek/src/serialize.ts` only forwards `temperature/maxTokens/stop` + reasoning fields, and `GenerateOptions`/`LlmCallConfig` have no penalty field (requires a one-line core change; plugin substitutes with message injection + temperature adjust instead).
- True history rollback ("revert to previous assistant message") is not plugin-only; approximated via interrupt + steer.
- Does not call `dev_router_mode` itself; band escalation is left to the operator or a future router extension point.

## License

BSD-3-Clause. See `package.json`.
