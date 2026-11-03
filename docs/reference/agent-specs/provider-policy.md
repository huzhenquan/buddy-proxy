# 上游的 provider 生效策略 —— 设计

状态：已按拍板修订，待派发。

## 1. 目标

一个上游（`provider` 表的一行）名下有多个账号/租户时，网关按「生效策略」决定先调谁、
失败后换谁。策略在上游页面配置，由用户手动设置。

## 2. 三个策略值

| 值 | 语义 | 落在哪 |
|---|---|---|
| `single` | 单调第一个（权重最大的那个）。失败就是失败，不换。 | 共用包 |
| `fallback` | 按权重依次试，遇到「不可用」降级到下一个。 | 共用包 |
| `expiry_first` | 单调一个特定账户：余额最早到期的那个。账户判定变了（钱包刷新后挑到别的账户）就切过去。不做 fallback。 | upstream 侧封装 |

要点：

- `single` / `fallback` 直接复用主路由的逻辑（`router-proxy.ts` 的 `handleAggregate`）：
  目标按权重排序，`single` 只走权重最大的那个，`fallback` 依次试到有一个回答为止。
- 余额到期是 upstream 特有的：**upstream 本身没有余额或限额的概念**，余额是账号
  （租户）层的。所以它不进共用包，在 upstream 侧基于共用包做一层封装。
- 「无周限额优先」不是代码逻辑，是使用者的场景。

### 降级条件

- 主路由：**保持现状**——任何错误都降级到下一个目标，行为一个字节都不改。
- upstream 侧：**区分**。只有「这个候选不可用」才降级：服务不可用（连接失败、超时、
  5xx）、429 额度打满、402 额度/余额用尽、401/403 凭据被拒。请求本身的问题
  （400、404、413 等）不降级——换个账号也一样会错。

## 3. 共用包（be-core 建）

位置：`lib/router/selection.ts`（新建）。

```ts
export type SelectionStrategy = "single" | "fallback";

export interface SelectionCandidate<T> {
  /** 候选的标识：日志与计数用。 */
  id: string;
  /** 权重：大的先上。 */
  weight: number;
  /** 试一次这个候选。 */
  run: () => Promise<T>;
}

export interface SelectionOptions<T> {
  strategy: SelectionStrategy;
  candidates: SelectionCandidate<T>[];
  /**
   * 这个错误算不算「这个候选不可用，可以降级」。
   * 不给就是所有错误都算 —— 主路由现在的行为，一个都不改。
   */
  degradable?: (error: unknown) => boolean;
  /** 每次尝试之后回调：成功或失败。 */
  onAttempt?: (candidate: SelectionCandidate<T>, error: unknown | null) => void;
  /** 全都失败时的错误。 */
  failure?: (lastError: unknown, tried: string[]) => Error;
}

/** 按策略挑一个：single 只试权重最大的那个，fallback 依次试到成功。 */
export async function select<T>(options: SelectionOptions<T>): Promise<T>;
```

语义：

- `single`：只跑权重最大的候选；失败直接抛，不降级。
- `fallback`：按权重降序依次跑；失败且 `degradable` 判定为可降级 → 试下一个；
  不可降级 → 立刻抛；全试完 → 抛 `failure` 造的错误（默认用最后一个错误）。
- 候选按权重降序；权重相同时保持传入次序。

主路由改造：`handleAggregate` 改为调用 `select`，行为不变（现有 `test/aggregate.sh`、
`test/route-e2e-check.ts` 必须仍然通过）。主路由**不注入** `degradable`。

## 4. upstream 侧封装（be-core 建）

位置：`lib/router/provider-selection.ts`（新建）。

```ts
export type ProviderPolicy = "single" | "fallback" | "expiry_first";

/** upstream 侧的候选：账号。id 是账号的标识，weight 是次序（第一个最大）。 */
export type ProviderCandidate<T> = SelectionCandidate<T>;

/**
 * 按策略执行一次。
 * single / fallback 走共用包；expiry_first 是 single 的变体：
 * 候选由上游侧按余额到期排好序，这里只调第一个，不降级。
 */
export async function selectProvider<T>(
  policy: ProviderPolicy,
  candidates: ProviderCandidate<T>[],
  options?: Pick<SelectionOptions<T>, "degradable" | "onAttempt" | "failure">,
): Promise<T>;
```

各 kind 的候选来源：

| kind | 候选 | 备注 |
|---|---|---|
| `minimax-api` | 名下的租户（一把 key 一个） | key 顺序即权重 |
| `tokenrhythm` | 名下的租户（一个账号一个） | `expiry_first` 时按余额最早到期排序，否则按租户次序 |
| 其余 | 单个账号 | 策略不影响行为，但仍走同一封装 |

`expiry_first` 的「账户变了就切」：候选列表每次请求重新算（钱包快照缓存 5 分钟，
刷新后清缓存），所以判定变了，下一个请求自然落到新账户。

## 5. 存储（主代理做）

- `provider` 表加一列 `policy TEXT NOT NULL DEFAULT 'single'`。
  - 迁移：`ALTER TABLE provider ADD COLUMN ...`，已有的库升得上去。
  - **不按 upstream 的特性设代码默认**：代码不知道哪个上游有余额、哪个有多个租户，
    所以不内置 `tokenrhythm = expiry_first` 这类默认。
  - **不回填**：存量行就是 `single`。
  - 用户在面板上手动设置。
- `lib/providers.ts` 暴露 `policyOf(providerId): ProviderPolicy`（读这一列）。

行为变化（部署后要注意）：

- TokenRhythm 与 MiniMax 开放平台会先按 `single` 跑 —— 固定第一个租户/账号，
  不再自动换。要恢复现有的行为，在面板上分别设成「余额到期优先」与「降级」。
- 其余上游只有一个账号，策略不影响它们。

## 6. 契约（主代理做）

```proto
// provider 的生效策略。
enum ProviderPolicy {
  PROVIDER_POLICY_UNSPECIFIED = 0; // 不用；面板总是给具体值
  PROVIDER_POLICY_SINGLE = 1;      // 单调第一个
  PROVIDER_POLICY_FALLBACK = 2;    // 按权重依次试，不可用就降级
  PROVIDER_POLICY_EXPIRY_FIRST = 3;// 单调余额最早到期的那个账户
}

message Upstream {
  // ...既有字段
  // 这个上游名下的多个账号怎么选。
  ProviderPolicy policy = 13;
}

message UpdateProviderRequest {
  // ...既有字段
  // 生效策略。没设 = 不改。
  optional ProviderPolicy policy = 4;
}

message ProviderKind {
  // ...既有字段
  // 这一类上游支持的策略（面板据此显示选项）。
  repeated ProviderPolicy policies = 6;
}
```

改完跑 `mise run proto`（生成物进 `lib/gen/`，`web/.gen/` 由 `web` 的 `gen:sync` 同步），
再 `mise run proto:lint`。

## 7. 面板

位置：**上游行的展开区顶部**（账号列表上方），一行「生效策略」+ 说明文字。

- 选项来自后端（`ProviderKind.policies`），中文标签：
  `single`=单一、`fallback`=降级、`expiry_first`=余额到期优先。
- 只有一个账号的上游：显示但禁用，提示「这个上游只有一个账号，策略不生效」。
- 保存走 `UpdateProvider`（带 `policy`），成功后 toast，列表刷新。

## 8. 子代理分工

见自己那份角色文件 `.pi/agents/<角色>.md`（常驻的职责、范围、边界、验收）与
`docs/tasks/provider-policy/context.md`（这一次的任务上下文、分工、进度、交付记录）。

| 子代理 | 这次做什么 |
|---|---|
| 主代理 | 契约改动 + 生成代码；`provider` 表加列 + `policyOf`；派发；汇总 |
| be-core | 共用包；upstream 侧封装；`toMiniMaxApi` / `toTokenRhythm` 按策略选账号；主路由改用共用包；单测 |
| be-admin | `ListUpstreams` 带出 policy；`UpdateProvider` 接收与校验；`ProviderKind.policies`；签到逻辑；单测 |
| fe | 展开区顶部的策略选择器；单测 |
| fe-review | 审前端改动与前端单测 |
| be-review | 审后端改动与后端单测 |
| e2e | 端到端覆盖三个策略 |
| js-reverse | 各上游额度打满时的状态码（供降级分类参考） |
