# 管理面板前端评审（FRONTEND-REVIEW）

评审对象：`web/`（shadcn-admin 骨架 + shadcn/ui + TanStack Router/Query/Table + Connect 客户端）
评审时间：2026-10-22
评审范围：`web/src/` 下项目自己写的部分（`features/`、`hooks/`、`lib/`、`routes/`、`components/layout/`、`components/data-table/`、`test/`）。`components/ui/` 下 27 个 shadcn CLI 生成的组件不逐个评。

只读、只跑，没有改任何代码。

---

## 一、怎么验的

```
mise run web:typecheck   → 通过（tsc -b --force，无错）
mise run web:build       → 通过（2136 modules，795ms）
mise run web:test        → 通过（4 个文件 / 15 个用例，2.19s）
```

另外起了真的网关（上游全关，不花 token）实测了契约的真实行为，这是下面几条「严重」的证据：

- `ListConfig` 对 `secret: true` 的项返回的 `value` 是**字面量 `"***"`**（当前只有 `REQUIRE_API_KEY` 一项命中 `_KEY` 后缀）。
- `SetConfig` 写 `value: "***"` → 服务端 `ok: true`，数据库 `config` 表里真的存进了 `{"key":"REQUIRE_API_KEY","value":"***"}`。
- `SetConfig` 写不认识的键 → **HTTP 200 + `{"ok":false,...}`**（不是 HTTP 错误）。
- 令牌不对 → HTTP 401 + `{"code":"unauthenticated","message":"面板令牌不对。"}` → Connect-ES 会把它变成 `Code.Unauthenticated`。
- `ListCredentials` 传空 `account_id` → 返回全部 14 条（空串 = 全部，服务端确实这么实现）。

`mise run test:admin`（后端自测）**有 2 条失败**，与前端无关，见第九节。

---

## 二、结论

**能跑，但有两处会真的把东西写坏。** 骨架、Query/Router/Table 的用法、中文文案与目录布局都在水准上，契约字段基本逐个对得上（我按 proto 逐字段核过 `SetConfig`/`SetUpstreamEnabled`/`SavePublishedModel`/`ListCredentials`/`GetUsageSummary` 的形状，没有发现字段名或类型写错的地方）。问题集中在**「服务端用一个 `ok: false` 的成功响应表达失败」这件事，前端有一半地方没接**，以及**敏感值在编辑框里被原样回写**。

要修的顺序：**先修 §3 的两条，再修 §4 的 1、2、3**，其余可以排后面。

---

## 三、严重（2 条）

### 3.1 编辑敏感配置项会把掩码 `"***"` 原样写进数据库

**位置**
- `web/src/features/config/index.tsx:167` —— `setDraft(item.value)`
- `web/src/features/config/index.tsx:216-222` —— 输入框 `value={draft}`
- `web/src/features/config/index.tsx:237-239` —— 保存 `save(editing.key, draft, false)`
- `web/src/features/config/api.ts:29-36` —— `SetConfigRequest{key, value, clear:false}`
- 服务端：`lib/admin/config.ts:116` —— `value: secret && raw ? "***" : raw`

**是什么问题**

服务端对敏感项不回真值，回的是字面量 `"***"`。前端把列表里拿到的 `item.value` 直接塞进编辑框的初始值。于是：打开「配置」页 → 找到 `REQUIRE_API_KEY` → 点「改」→ 输入框（password 类型）里是 `***` → 不改内容直接点「保存」→ 前端把 `value: "***"` 发出去 → 服务端 `configOverride` 原样写库。

**为什么会出错**

我实测过：写完之后 `config` 表里就是 `{"key":"REQUIRE_API_KEY","value":"***"}`，服务端还回 `ok: true`。

重启后 `configFlag("REQUIRE_API_KEY", false)` → `parseBool("***")` 返回 `null`（`lib/env.ts:17-23` 只认 `1/true/yes/on` 与 `0/false/no/off`）→ 回落到默认值 `false`。**agent 侧的前门从「要 api key」变成「公开」，而面板上从头到尾显示的是「已保存，重启后生效」。**

这是「敏感值只写不读」这条约定（设计文档 4.3）在前端的破口：只写不读意味着前端拿到的永远是掩码，掩码不能当输入回传。

**怎么改**

前端侧（最小改动）：secret 项不要把 `item.value` 灌进 draft。
- `setDraft(item.secret ? '' : item.value)`（`config/index.tsx:167`）；
- 弹窗里给一句提示：「这一项的值现在读不出来，留空表示不改；要改就填新值」；
- 保存时若 `editing.secret && draft === ''` → 走 `clear: true`（或干脆不发请求），不要发 `value: ''`（空串会被当成「把密钥清空」）。

契约/服务端侧（更稳）：让 `ListConfig` 对 secret 项返回空 `value` 而不是 `"***"`，另加一个布尔（如 `has_value`）表示「库里现在有值」。这样前端没有机会把掩码当值回传。这条建议同时写进 `docs/reference/admin-panel/CONTRACT-FIXES.md`（现在那份清单里没有它）。

### 3.2 保存模型失败时，界面报的是「成功」，还会把弹窗关掉

**位置**
- `web/src/features/models/index.tsx:65-76` —— `const result = await save.mutateAsync(model); toast.success(result.message || '已保存'); setDialogOpen(false)`
- `web/src/features/models/model-dialog.tsx:171` —— `const valid = draft.id.trim().length > 0 && draft.targets.length > 0`
- `web/src/features/models/model-dialog.tsx:118-131` —— `fromDraft` 过滤掉没填全的目标
- 服务端：`lib/admin/models.ts:146-147` —— `if (!input.targets?.length) return { ok: false, ... }`

**是什么问题**

`SavePublishedModelResponse` 有 `ok` 字段，前端在这个文件里一次都没看。

`valid` 检查的是**过滤之前**的目标数，`fromDraft` 又把没填全（组名或模型 id 为空）的目标过滤掉。两个一拼，校验就漏了：

**为什么会出错**

新建模型 → 填了对外 id → 「上游目标」页里默认有一行空的（`emptyTarget()`，`model-dialog.tsx:58-66`）→ 什么都不填 → 「保存」按钮是亮的（`valid` 为真，因为 `targets.length === 1`）→ `fromDraft` 把这一行过滤掉 → 发出去的 `targets` 是空数组 → 服务端回 `ok: false, message: "模型至少要有一个上游"` → 前端 **`toast.success`** 显示「模型至少要有一个上游」（绿色成功提示），**并且 `setDialogOpen(false)` 把弹窗关了**，用户填的 id 也没了。

用户看到的是「绿色对勾 + 一句说不通的提示」，第一反应是保存成功了。

**怎么改**

`models/index.tsx:68-71` 改成看 `ok`：

```ts
const result = await save.mutateAsync(model)
if (!result.ok) {
  toast.error(result.message || '没保存成')
  return          // 不要关弹窗，用户还要改
}
toast.success(result.message || '已保存')
setDialogOpen(false)
```

顺带把 `model-dialog.tsx:171` 的 `valid` 改成按**过滤后**的条数算（`draft.targets.filter(t => t.groupName.trim() && t.upstreamModel.trim()).length > 0`），这样按钮一开始就是灰的；再给每个目标行一个「这一行还没填全」的行内提示。

---

## 四、该改（11 条）

### 4.1 `ok` 字段只在两个地方被看，另外四处没有

**位置**
- `web/src/features/upstreams/index.tsx:36-41`（`SetUpstreamEnabledResponse.ok` 没看）
- `web/src/features/config/index.tsx:79-80`（`SetConfigResponse.ok` 没看）
- `web/src/features/models/index.tsx:69`（`SavePublishedModelResponse.ok` 没看）
- `web/src/features/models/index.tsx:83`（`DeletePublishedModelResponse.ok` 没看）
- 对照：`web/src/features/accounts/index.tsx:51-55`、`69-75`（**看了**，写法是对的）

**为什么**

服务端对「不认识的配置项」「不认识的上游」「模型没有 id」这类失败，返回的是 **HTTP 200 + `ok: false`**（我实测过 `SetConfig` 的未知键就是这样）。前端当成功处理 → 绿色 toast + `setEditing(null)` / `setDialogOpen(false)`。

配置页那条虽然 UI 上点不出未知键，但 `SetUpstreamEnabled` 的 `ok:false` 分支是存在的（`lib/admin/service.ts:191-197`），一旦上游 id 与服务端 `UPSTREAM_IDS` 对不上（比如面板缓存的是旧列表），用户会看到绿色的「不认识的上游：xxx」。

**怎么改**

在 `web/src/lib/` 加一个小工具，四处统一用：

```ts
// web/src/lib/errors.ts
export function isOk(result: { ok: boolean }): boolean { return result.ok }
```

或者更直接：每个 mutation 的 `onSuccess` 里判断 `if (!result.ok) { toast.error(result.message); return }`，把 toast 逻辑收到 `api.ts` 的 mutation 里，页面只管 `mutateAsync` 的 catch。现在 toast 散在 6 个页面里，各自复制一遍「成功/失败」判断，早晚会漏掉一处（已经漏了 4 处）。

### 4.2 用量页没有「加载中」和「出错」这两种状态

**位置**
- `web/src/features/usage/index.tsx:30-36`（`summary` / `events` 两个 query 的 `isPending`、`isError` 从没被读）
- `web/src/features/usage/index.tsx:38-46`（`total?.requests ?? 0n` → 加载中显示 0）
- `web/src/features/usage/index.tsx:104-111`（`data={events.data?.events ?? []}`）
- `web/src/features/usage/usage-table.tsx:268-276`（空态文案「没有匹配的记录。」）

**为什么**

这是整个面板里唯一一个没做状态区分的页面（总览、上游、配置、账号、余额、模型都有 `isPending`/`isError` 分支）。结果是：

- 加载中：统计卡片显示「0 请求」，表格显示「没有匹配的记录。」
- 请求失败（比如网关 500）：**完全一样**，「没有匹配的记录。」

用户分不清「今天真的一条请求都没有」和「面板没取到数据」。用量页恰恰是最需要可信的一页。

**怎么改**

`usage/index.tsx` 里：

```tsx
{summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
 : summary.isPending ? <LoadingState />
 : ...}
```

表格那侧把 `events.isPending` / `events.isError` 传进 `UsageTable`（加两个 prop），分别渲染 `<LoadingState/>` 和 `<ErrorState/>`，空态文案只在真的是空的时候出现。

### 4.3 401 只在 query 上被处理，mutation 上的 401 不会把面板送回令牌页

**位置** `web/src/lib/query-client.ts:26-33` —— 只有 `queryCache: new QueryCache({ onError })`，没有 `mutationCache`。

**为什么**

TanStack Query 的 `QueryCache.onError` 只对 **query** 生效；mutation 的错误走 `MutationCache`。所以：

- query 401 → `clearToken()` → 回到令牌输入页 ✓
- mutation 401（比如令牌过期后点「试一下」凭据）→ 只有 `describeError` 出来的 toast「鉴权没过：面板令牌不对。（令牌填错了，或者还没填）」，**令牌没被清掉，人还留在面板上**，而面板上显示的又全是旧数据（`refetchOnWindowFocus: false` + `staleTime: 10s`，闲着的面板不会自己再取一次）。

用户被卡在一个「看起来正常但什么都不对」的状态里。

**怎么改**

```ts
// web/src/lib/query-client.ts
mutationCache: new MutationCache({
  onError: (error) => { if (isAuthError(error)) clearToken() },
}),
```

另外 `web/src/lib/errors.ts:81-86` 的 `isAuthError` 把 `PermissionDenied`（403）也算成鉴权失败 → 403 会把令牌清掉、把人踢回登录页，而 403 的意思恰恰是「令牌没问题，只是不许」。403 应该单独一类，不要动令牌。

### 4.4 表格的筛选状态和 URL 会各走各的

**位置** `web/src/hooks/use-table-url-state.ts:89-111`（`initialColumnFilters` 是个 `useMemo`，但 `columnFilters` 用 `useState` 只取初值）、`:136-140`（`globalFilter` 同理）。

**为什么**

`columnFilters` 和 `globalFilter` 是本地 state，只在**第一次挂载**时从 URL 读一次。之后 URL 变了它们不跟着变。

在用量页上这个错位是可见的，因为同一个 URL 参数（`upstream` / `model`）同时喂给两处：

- `usage/index.tsx:27-28` → 服务端查询用 URL 的值
- `usage-table.tsx:62-71` → 客户端列筛选用本地 state 的值

**触发场景**：在 `/usage?upstream=minimax` 上按浏览器「后退」回到 `/usage`：

- 服务端那边（URL）→ 不筛了，返回全部事件
- 表格这边（本地 state）→ 还筛着 minimax，表格里只显示 minimax 的行
- 上游下拉框也还显示着「minimax」

**URL、表格、下拉框三者对不上，而且没有任何提示。**刷新一下就好了，但用户不会想到要刷新。

**怎么改**

把这两个 state 改成从 URL 派生（受控），或者加一个同步 effect：

```ts
useEffect(() => {
  setColumnFilters(initialColumnFilters)
}, [initialColumnFilters])
```

注意 `initialColumnFilters` 依赖 `columnFiltersCfg`，而调用方（`usage-table.tsx:67-70`）每次渲染都传一个新的数组字面量 → useMemo 每次都重算 → effect 每次都跑。要么在调用方用 `useMemo` 包住配置，要么在 hook 里按 `searchKey` 做深比较再决定要不要 setState。后者更稳。

### 4.5 账号行只能鼠标点，键盘走不到凭据

**位置** `web/src/features/accounts/index.tsx:121-126` —— `<TableRow onClick={() => setSelected(account.id)} className='cursor-pointer'>`。

**为什么**

`<tr>` 没有 `tabIndex`、没有 `role`、没有 `onKeyDown`。整个「账号与凭据」页里，进入凭据列表的唯一入口就是点这一行 → 纯键盘用户（或者用屏幕阅读器的人）根本看不到凭据列表。

这一页是面板的核心用途（设计文档 4.3：账号 → 多凭据），键盘不可达等于功能缺失。

**怎么改**

两种都行：

- 把整行变成按钮：`<TableRow><TableCell><button …>` —— 但一整行的按钮语义不好；
- 更好：在「账号」列里放一个真按钮（`<Button variant='ghost' size='sm'>` 写账号名），`tabIndex`/`role="button"`/`onKeyDown` 补在行上只是权宜。

顺带：选中状态除了 `data-state='selected'`（只有底色变化）之外没有别的提示，屏幕阅读器也不知道哪一行被选中了。选中行里加一个 `aria-current` 或者把状态写进单元格文本。

### 4.6 `useCredentials` 的 `enabled` 条件是死代码，还白拉一次全部凭据

**位置** `web/src/features/accounts/api.ts:25-35` —— `enabled: accountId !== undefined`。

**为什么**

参数类型是 `string`，永远不会是 `undefined` → 这个条件恒为真。原意应该是 `accountId !== ''`。

后果：`accounts/index.tsx:39-40` 初始 `selected = ''` → 组件一挂载就发一次 `ListCredentials{account_id: ''}` → 服务端按「空 = 全部」返回**全部 14 条凭据**（实测），而界面此时显示的是「还没选账号」（`:167-168`）。多拉一次、多存一份缓存，键是 `['accounts','','credentials']`。

**怎么改**

`enabled: accountId !== ''`，同时 `accounts/index.tsx:40` 传 `selected`（空串）时不要发请求。

### 4.7 模型编辑弹窗里有一半控件没有可访问名称

**位置** `web/src/features/models/model-dialog.tsx:210`（策略）、`:287-295`（上游组）、`:297-305`（上游模型 id）、`:307-312`（权重）、`:317-322`（顺序）。

**为什么**

这几个地方是 `<Label>文本</Label>` 后面跟一个没有 `id` 的 `<Input>`，`<Label>` 也没有 `htmlFor`。对比同一个文件里的「对外 id」「显示名」「上下文长度」「最大输出」「推理档位」都规规矩矩配了 `htmlFor` + `id`（`:192-194`、`:202-204`、`:226-229`、`:239-242`、`:249-251`），也能看到配置页的弹窗是配了的（`config/index.tsx:215-217`）。所以是漏了，不是风格问题。

屏幕阅读器读这几个输入框只会报「编辑框」，不报「上游组」「权重」。

**怎么改**

给每个 Input 一个 id，Label 加 `htmlFor`。

### 4.8 令牌页不验令牌，也不给反馈

**位置** `web/src/features/auth/token-gate.tsx:30-38`。

**是什么问题**

```tsx
setChecking(true)
setToken(value)
// 令牌对不对，由第一次请求去问网关；错了网关会回 401，面板会退回这里。
setChecking(false)
```

**为什么会出错**

1. `setChecking(true)` 和 `setChecking(false)` 在同一个事件处理函数里 → React 批处理后只渲染一次，`checking` 永远是 false → 那个转圈是死代码，`checking` state 整体可以删掉。
2. 令牌**先存后验**：`setToken` 立刻写进 localStorage，面板才开始渲染、开始发请求。如果令牌是错的：面板闪一下 → query 401 → `clearToken()` → 回到这个表单 → **表单上没有任何错误提示**，输入框里还留着刚才填的内容。用户看到的是「我明明填了，怎么又让我填」。
3. `autoComplete='off'` + `type='password'` 是对的，但 `autoFocus` 加上没有错误区，第一次进来没有「哪里错了」的落点。

**怎么改**

- 填完先验一次（`GetSystemStatus` 是个便宜的调用），验过了再 `setToken`；失败就在表单上方显示一行红色提示（`describeError(error)` 已经会翻成人话）。
- 或者保留「先存后验」，但要在 `TokenGate` 里监听子组件的 401 —— 更麻烦，不如直接先验。
- `checking` 改成真正有用的：验证期间禁用按钮并转圈。

### 4.9 配置页的「默认值」显示条件是反的

**位置** `web/src/features/config/index.tsx:144-148` —— `item.fallback && item.source !== 'database' ? '默认 {fallback}' : null`

**为什么**

`ConfigItem.fallback` 的语义（`docs/reference/admin-panel/CONTRACT-FIXES.md` 第 8 条已确认）是**这个键的代码默认值**。服务端的 `configItems()`（`lib/admin/config.ts:118`）也确实是这么给的。

现在的条件是「来源不是 database 才显示默认值」，于是：

| source | 当前值 | fallback（代码默认） | 现在显示 | 应该显示吗 |
|---|---|---|---|---|
| `database` | `true`（面板改的） | `false` | **不显示** | 最需要显示（覆盖掉了默认值） |
| `environment` | `30000` | `30000` | 显示「默认 30000」 | 重复了当前值，噪声 |
| `default` | `30000` | `30000` | 显示「默认 30000」 | 重复了当前值，噪声 |

也就是说：默认值只在最没用的场合出现，在最有用的场合（数据库覆盖）被藏起来了。

**怎么改**

去掉 `source !== 'database'` 这个条件，改成「值和 fallback 不一样时才显示」，并且文案改成「默认值 xxx」而不是「默认 xxx」（现在读起来像「默认值是 xxx」的意思是默认值，但用户会以为当前值就是它）。

### 4.10 模型编辑一次，就把「继承上游」写死成具体数字

**位置**
- `web/src/features/models/model-dialog.tsx:88-92`（`toDraft` 读 `model.contextWindow` 等）
- `web/src/features/models/model-dialog.tsx:110-117`（`fromDraft` 原样写回）
- 服务端：`lib/admin/models.ts:54-82`（`resolveMetadata` 算的是**解析后**的值）、`:87-91`（列表返回的就是解析后的值）

**为什么**

契约里没有「留空」这个说法，服务端用 `contextWindow > 0 ? value : null` 表示「留空 = 继承上游的」（`lib/admin/models.ts:164-167` 的注释写得很清楚）。但 `listPublishedModels` 返回的是**解析后**的上下文/输出/effort/reasoning（取所有启用目标的交集、最小值）。

于是模型原本是「继承」的时候：

- 列表显示 200000（解析出来的）
- 点「改」→ 输入框里是 200000 → 保存 → 前端发 200000 → 服务端存成显式值 200000
- **继承语义没了**，以后上游目录变了，这个模型不再跟着变

`effort_options`、`reasoning`、`tool_call` 同理：服务端给的是多个目标的交集/any/all，前端原样写回就变成了显式值。

**怎么改**

根因在服务端（返回的是解析值而不是存储值），契约层面解决：给 `PublishedModel` 加一组「哪些字段是继承的」标记，或者让服务端在返回时把「存储值为空」的字段原样留空。

前端侧的权宜办法：`fromDraft` 里不写这些字段（保持 0/空 = 继承），代价是用户就没法在面板上显式指定上下文了 —— 除非面板上分开两个输入框（「自己指定」+「继承上游」）。

### 4.11 上游开关的 busy 状态在快速连点时会串

**位置** `web/src/features/upstreams/index.tsx:29`（`busy` 只是一个 string）、`:31-47`（`toggle` 里 `setBusy(id)` / `finally { setBusy(null) }`）、`:138-145`（`disabled={busy === upstream.id}`）。

**为什么**

同时点两个上游的开关：第二个的 `finally` 会把 `busy` 清成 `null` → 第一个开关重新可点 → 用户可以重复发同一个请求。

另外这个 Switch 是受控的（`checked={upstream.enabled}`，值来自服务端数据），点击后要等 mutation 成功 + invalidate 重取之后才会变。局域网内也就几十毫秒，但**点下去看起来没反应**，用户容易连点。

**怎么改**

- `busy` 换成 `Set<string>`（或直接用 `setEnabled.isPending && setEnabled.variables?.upstreamId === upstream.id` 判断，TanStack Query v5 的 mutation 就有 `variables`）。
- 想让点击立刻有反馈，就做乐观更新：`onMutate` 里 `setQueryData` 先改，失败再回滚。

---

## 五、可以商量（9 条）

1. **`window` 这个字段实际上没被用起来**（`usage/index.tsx:30` 传空串 = 全部；总览 `overview/index.tsx:32` 传 `'day'`）。契约注释写「按天 / 按小时」，服务端其实支持 `hour/1h/day/24h/1d/week/7d/month/30d` 和 `3d` 这种（`lib/admin/usage.ts:68-96`）。用量页给个窗口选择器，这个字段才算有落点。契约要改成 enum 这件事已经记在 `CONTRACT-FIXES.md` 第 3 条里了。
2. **`ListCredentials` 空串 = 全部**这个语义前端猜对了（服务端 `lib/admin/accounts.ts:235-236` 确实这么实现，实测返回 14 条），但契约里没写。`CONTRACT-FIXES.md` 第 7 条已经记了，改契约时补一句注释就行，前端这边不用动。
3. **`PublishedTarget.requests/failed` 不会被覆盖**：前端 `fromDraft` 写的是 `0n`（`model-dialog.tsx:128-129`），但服务端 `savePublishedModel` 根本不读这两个字段（`lib/admin/service.ts:451-457` 只取 group/model/weight/position/enabled），列表里的统计是从 `aggregate_usage` 现算的（`lib/admin/models.ts:100-113`）。**所以没有数据丢失**，不用改。`CONTRACT-FIXES.md` 第 9 条说要标只读 —— 标上是为了让下一个人别再查一遍。
4. **`view-options.tsx:49`**：「列」菜单里显示的是内部列 id（`ts` / `upstream` / `model` / `dialect`），不是中文表头（时间 / 上游 / 模型 / 方言）。用户得自己对号入座。用 `column.columnDef.header` 就好。
5. **死代码**：`components/data-table/faceted-filter.tsx` 和 `bulk-actions.tsx` 从 `index.ts` 导出了但没人用（用量页用的是 `extra` 里的两个 `Select`）。是从 shadcn-admin 抄来没用上的，要么删要么留个注释说为什么留。
6. **`refetchOnWindowFocus: false`**（`query-client.ts:19`）：切回标签页不会自动刷新。观测面板一般希望回来就是新的。要么改成 `true`，要么加个「刷新」按钮（现在整个面板**没有手动刷新按钮**）。
7. **实时性**：设计文档 4.4 提了 `GET /admin/events` 的 SSE 事件流，用量现在是「打开页面拉一次」。服务端也还没这个路由（`CONTRACT-FIXES.md` 第 12 条记着「下一轮」）。等 SSE 落地时，用量页要接，否则「用量」这一页永远是打开那一刻的快照。
8. **时间格式不统一**：`usage-table.tsx:81` 用 `toLocaleString('zh-CN')` 自己拼，其它地方都用 `lib/format.ts` 的 `formatDateTime`（固定 `Intl.DateTimeFormat`）。同一屏里两种格式。顺便 `latencyMs` 是裸输出（`usage-table.tsx:138`），而 `formatMillis`（`lib/format.ts:59-66`）已经写好了却没人用。
9. **令牌存 localStorage**：XSS 就能拿到它，而它是全权的面板密钥。现状是**没有明显的泄漏面** —— 全项目搜不到 `dangerouslySetInnerHTML`、`console.log(token)`、令牌进 URL（`grep` 过，只有 `nav-group.tsx:38` 用了 `location.href`，那是路由不是令牌）。面板是同源部署、渲染的都是文本，风险有限。但可以考虑：加 CSP、给 `index.html` 加 `Referrer-Policy: no-referrer`，或者长期换成 HttpOnly cookie（要服务端配合）。另外 `token-store.ts` 在模块加载时就把令牌读进内存变量（`:17`），多标签页之间不同步 —— 一个标签页「忘掉令牌」，另一个还拿着旧令牌继续用，下次请求才 401。

---

## 六、测试（5 条）

现在一共 4 个文件 / 15 个用例，覆盖的是总览页 + 两个 hook + 赠金表格。

1. **`test/app.test.tsx:22-24` 的注释和它做的事对不上**：注释写「没有令牌的时候给令牌输入页，填了之后进总览」，但 `test/setup.ts:6` 在模块加载时就往 localStorage 里塞了令牌，所以**令牌闸门一次都没被测过**。要测闸门，得在测试里 `localStorage.removeItem('buddy.admin.token')` 再 `setToken(...)`。
2. **断言太松**：`test/app.test.tsx:99` 的 `expect(screen.getAllByText('总览').length).toBeGreaterThan(0)` —— 跟 `toBeTruthy()` 一个级别。应该断言具体的那一个元素（`getByRole('heading', {name:'总览'})`）。
3. **错误路径基本没测**。没有一条用例覆盖：
   - 401 → 清令牌 → 回到令牌页（这条路径是整个鉴权设计的核心）；
   - 服务端回 `ok: false` 时界面怎么显示（§4.1）；
   - 配置页读回来的是 `"***"` 时，保存会不会把 `"***"` 发出去（§3.1）；
   - 用量页加载中/出错（§4.2）；
   - 敏感配置项的往返。

   顺带：配置页、账号页、模型页、余额页（`balance/index.tsx`）、用量页**一个交互用例都没有**。
4. **mock 的类型被抹掉了**：`test/mock-transport.ts:4` 的 `Handler = (input: unknown) => unknown`，`:31` 的 `message: handler(input) as never`。所以处理器返回错形状（比如把 `upstreams` 写成 `items`）测试也不会红。用 `create(XxxResponseSchema, …)` 的写法是好的，但没有强制。可以给 `mockAdminClient` 加上按方法名的返回类型约束（从 `AdminService` 的方法签名推），这样形状写错就编译不过。
5. **错误用例造的错不对**：`features/upstreams/api.test.tsx:101` 抛的是 `new Error('网关炸了')`，而真实链路里是 `ConnectError`。`lib/errors.ts:9-39` 里 `describeError` 对 `ConnectError` 的那一整段分支（把 code 翻成「鉴权没过」「网关连不上」…）**一条用例都没有**。mock transport 应该抛 `ConnectError`。

写得好的部分：`features/balance/credit-lots.test.tsx` 测的是真东西 —— 2099-12-31 原样透出、倒计时给「—」、已到期标红、空态；`features/upstreams/api.test.tsx` 的第二条（改了开关之后列表会重取）也是测行为不是测 mock。

---

## 七、与仓库的约定

对得上的：

- 注释和界面文案是中文 ✓，口吻跟 `lib/` 里的写法一致 ✓（「契约里没有…所以面板发什么就存什么」这种解释性注释是对的写法）。
- 目录布局照 `docs/reference/admin-panel/README.md` 4.8 的骨架来：`features/<domain>/` 切分、`routes/_authenticated/` 文件路由、`components/layout/`、`components/data-table/`、`hooks/`、`lib/` ✓。
- `web/dist/`、`web/node_modules/` 在 `.gitignore` 里 ✓（根 `.gitignore` 末尾 + `web/.gitignore`）。
- 没有 `any`（只有生成物 `routeTree.gen.ts` 里有）、没有 `dangerouslySetInnerHTML`、没有 `console.log`、没有把令牌写进 URL ✓。

不一致的：

1. **引号风格**：`web/src/hooks/use-mobile.ts` 用双引号（`import * as React from "react"`、`"change"`），其余文件全是单引号（全项目 grep `from "` 只此一处）。统一成单引号。
2. **`web/src/hooks/use-mobile.ts` 整个文件是从 shadcn 抄的英文注释**（`const MOBILE_BREAKPOINT = 768` 上面没有中文说明），跟仓库「注释是中文」的约定不齐 —— 虽然它是生成式的工具文件。
3. **`web/.gitignore` 忽略了 `src/routeTree.gen.ts`**。设计文档 4.5 说「生成物要提交进仓库」，但那是指 proto 的生成物（`lib/gen/`，确实提交了 ✓）。前端这个是 build 时现生成的，忽略掉没问题 —— **前提是镜像构建时跑一遍 build**（见第九节）。
4. `web/src/lib/utils.ts` 里 `getPageNumbers` 是从 shadcn-admin 抄的，注释也抄了中文版 —— 这个没问题。

---

## 八、已经报过、不用再报的

`docs/reference/admin-panel/CONTRACT-FIXES.md` 里那 13 条（`BalanceSummary.upstream_id`、`ListUsageEventsRequest.before_id`、`window` 改 enum、`UsageEvent.client`、`Account.balance`、`Upstream.base_url/region`、`account_id` 语义、`fallback` 语义、`requests/failed` 只读、`SavePublishedModelRequest.model.id` 语义、账号凭据增删改、SSE、重启中状态、数据迁移）我逐条核过，跟前端现在的实现对得上，**这次不重复**。

要补进那份清单的只有 §3.1 那条（**secret 项回传掩码会把 `"***"` 写进库**）—— 那不是契约「没写清」，是契约与服务端的返回形状（掩码长得像值）导致的前端陷阱，要么前端改，要么服务端把 secret 的 `value` 改成空串 + 加一个 `has_value`。

---

## 九、与前端无关的问题（后端 agent 正在改的东西）

1. **`mise run test:admin` 有 2 条失败**（其余 52 条通过）：
   ```
   FAIL 改完要重启才生效      （SetConfig 之后 pending_restart 应为 true）
   FAIL 改了上游要重启才生效  （SetUpstreamEnabled 之后 pending_restart 应为 true）
   ```
   原因在 `lib/config.ts:216-223`：`configPendingRestart()` 遍历 `listConfig()`，但 `startup` 里只有**进程运行时问过过的键**；自测里上游全关，`HEALTH_CACHE_MS` 这类键压根没被问过 → `continue` 跳过 → 返回 false。面板上的「配置改了，重启后生效」徽章（`overview/index.tsx:55-60`、`config/index.tsx:94-96`）全靠这个字段，所以这个 bug 会直接让面板**不提示待重启**。
2. **`lib/admin/http.ts:72` 的 CORS 是 `Access-Control-Allow-Origin: *`，而且是无条件设的**（生产环境同源也设）。任何一个网站都能对网关的 admin API 发跨域请求；令牌是唯一的门槛，而令牌是要让人手工复制到浏览器里的。生产环境建议按源收紧，或者至少不要在同源部署时发这个头。
3. **Dockerfile 没有把 `web/dist` 拷进镜像**（`Dockerfile:15-16` 只 COPY 了 `router-proxy.ts`、`config-cli.ts`、`lib/`），而 `lib/admin/http.ts:103-114` 的 `webDistDir()` 指向 `/app/web/dist` → 容器里 `hasWebDist()` 恒为 false → 镜像里的面板是 404。`mise.toml` 的 `build` 任务已经依赖 `web.build` 了，`.dockerignore` 也没排掉 `web/`，所以只差 Dockerfile 里一步 `COPY web/dist/ ./web/dist/`（多阶段的话在 builder 阶段跑 `pnpm build`）。按 `docs/reference/admin-panel/PLAN.md`，这一步本来就是「集成（我做）」的活。
4. **仓库里现在什么前端东西都没提交**：`git status` 显示 `web/`、`lib/admin/`、`test/admin-check.ts` 都是未跟踪，`proto/`、`lib/gen/`、`router-proxy.ts`、`lib/config.ts`、`mise.toml` 是已修改未提交。契约改过（`git diff proto/` 有 54 行变更）且 `lib/gen/` 已重新生成 —— 前后端现在是对得上的，但**还没进版本库**。
