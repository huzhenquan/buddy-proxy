# cc-switch「自定义用量查询脚本」机制逆向

> 调研日期：2026-10-21
> 核对版本：cc-switch v4.0.17（2026-10-20 发布），<https://github.com/farion1231/cc-switch>
> 相关：[platform-api.md](platform-api.md)、[multi-tenant.md](multi-tenant.md)

## 一句话结论

**脚本本身够用，平台侧也够用；卡点在「脚本能干什么」和「怎么配」。**

QuickJS 沙箱能表达「一次带自定义请求头的 GET + 解析 JSON 响应」，
正好是查余额需要的形状。平台把余额放在了代理自己的 `/health` 里，
所以脚本只要问代理就行。

## 沙箱能力矩阵

源码：`src-tauri/src/usage_script.rs`（`execute_usage_script`）

| 能力 | 支持 | 依据 |
| --- | --- | --- |
| 脚本自己发网络请求 | ❌ | HTTP 由 Rust 的 reqwest 发（`send_http_request`），沙箱只提供 `request` 描述与 `extractor` |
| 一个脚本发多个请求 | ❌ | `RequestConfig` 只有单个 `{url, method, headers, body}` |
| 自定义请求头 | ✅ | `for (k, v) in &config.headers { req = req.header(k, v) }`，Cookie 头也能原样透传 |
| 请求体 | ✅ | `body: Option<String>` |
| 读本地文件 / 环境变量 | ❌ | 沙箱无 IO，只有纯 JS 能力 |
| 加密解密（crypto） | ❌ | 没有这些全局对象 |
| 响应体必须是 JSON | ✅ | Rust 侧 `ctx.json_parse(response_data)`，非 JSON 直接报错 |
| HTTP 非 2xx 时拿到响应体 | ❌ | `!status.is_success()` 直接抛 `HTTP 401 : <前 200 字符>`，提取器不会被调用 |
| 占位符 | `{{apiKey}}` `{{baseUrl}}` `{{accessToken}}` `{{userId}}` | `build_script_with_vars` 里纯字符串替换 |

返回字段（`validate_single_usage` 逐个查类型）：
`isValid`(bool) `invalidMessage`(str) `remaining`(num) `unit`(str) `total`(num) `used`(num)
`planName`(str) `extra`(str)，全部可选，但**类型必须对**，否则整次查询判失败。

## URL 安全校验（最容易踩）

`validate_request_url(request.url, base_url, is_custom_template)`：

- 非「自定义」模板：请求 URL 必须 https（loopback 放行），且 **host + port 必须与 base_url 同源**
- 「自定义」模板（`template_type == "custom"`）：**跳过全部校验**——任意域名、http 局域网都行
- `base_url` 的校验（`validate_base_url`）也只对非自定义模板生效

判定「自定义」的是 `template_type` 字段，即 UI 里模板下拉选的那一项，**不是**代码内容。
所以即使把代码改成自己的，模板下拉仍得选「自定义」，否则同源校验会拦。

凭据优先级（`resolve_script_credentials`）：脚本配置里显式填的 API Key / Base URL 优先，
留空则回退供应商自身的凭据。自定义模板的 UI 不显示这两个输入框
（`shouldShowCredentialsConfig` 只对 GENERAL / SUB2API / NEW_API 等显示），
所以自定义模式下 `{{apiKey}}` = 供应商的 Key，`{{baseUrl}}` = 供应商端点。

## 本项目的脚本

文件：[docs/reference/token-rhythm/cc-switch/proxy-health.js](docs/reference/token-rhythm/cc-switch/proxy-health.js)。

代理是多租户轮转的——一次请求挑一个上游账号消费——所以**一张 cc-switch 卡片对应的是账户池**，
卡片上的余额取池子合计：

```
剩余 200.00 CNY
3 个账户 · acct-a ¥100.00 · acct-b ¥50.00 · acct-c ¥50.00 · 先耗 acct-b（赠额 2099-12-31 到期）
```

脚本的取值规则：

| 情况 | 结果 |
| --- | --- |
| 代理没启用 tokenrhythm / `/health` 里没有这一节 / 没配账号 | `isValid: false` + 说明 |
| 有账号取不到余额（`error` 非空） | 不计入，`extra` 里写「N 个账户查询失败」 |
| 有账号没有 API Key | 不计入（接不了推理，代理也不会选它），`extra` 里写「N 个账户无 key」 |
| 账号余额为 0 | **照算**（凭据还有效，只是没钱了） |
| 所有账号都取不到余额 | `isValid: false` + 第一个错误原因 |

`extra` 里的「先耗」是按代理的选账规则推的：有赠额的先用赠额，赠额里最先到期的先花
（`lib/tokenrhythm/accounts.ts` 的 `pickTenant`），所以那个账户就是正在被消耗的。

想只看某一个账号：把脚本里的 `TENANT_INDEX` 改成 1 / 2 / 3（`null` = 池子合计）。

## 怎么配

1. 供应商卡片 →「更多」→「配置用量查询」→ 打开「启用用量查询」
2. **模板选「自定义」**（必须）
3. 粘贴 [docs/reference/token-rhythm/cc-switch/proxy-health.js](docs/reference/token-rhythm/cc-switch/proxy-health.js) 的内容
4. 点「测试脚本」

脚本里没有占位符：`/health` 不校验 `Authorization`（实测带一个无关的 Bearer 头也是 200）。

## 坑

### 1. 用量脚本不绕全局代理

`usage_script.rs` 用的是 `crate::proxy::http_client::get()`（全局客户端），
而 app 其他地方（`services/speedtest.rs`、`proxy/forwarder.rs`、
`services/model_fetch.rs`、`services/stream_check.rs`）用的是
`http_client::get_for_url(url)`——后者对 loopback 走 `no_proxy` 直连。

`http_client.rs` 的注释写得很清楚：

> reqwest 不会自动绕开本机地址：配了全局代理时 `Proxy::all` 对所有目标生效……
> 本机推理服务因此会被送进代理，代理不能代连本机时请求就失败。

所以 cc-switch 里配了全局代理时，`127.0.0.1` 上的服务会被送进代理而失败。
本项目的情况没事：代理在 `gateway.example:6450`，本机的全局代理也在同一台 NAS 上
（`gateway.example:5053`），实测经代理请求 200 且数据正确；不配代理时 reqwest 读环境变量，
`no_proxy` 里有 `gateway.example` → 直连。两条路都通。

### 2. 非 2xx 拿不到响应体

会话过期时平台返 401，cc-switch 只显示 `HTTP 401 : {...}`，
提取器里判业务码的分支走不到。所以脚本对「所有账号都取不到余额」要自己判
`isValid: false` 并给出可读的 `invalidMessage`。

### 3. 只在「使用中」刷新

cc-switch 的自动查询只对处于「使用中」状态的供应商触发（官方文档明确写了）。
自动刷新间隔建议 5-60 分钟；用量查询会消耗少量请求配额。

### 4. 响应体必须是 JSON

接口哪天返回 HTML 的话，cc-switch 报的是「解析响应 JSON 失败」，不是 HTTP 错误，容易误判。

## 本地验证

cc-switch 本机没装（2026-10-18 已卸载），所以用仿真测试台验证：按 cc-switch 的真实执行语义跑脚本——

1. 替换占位符 → 2. 沙箱 eval 取 `request`/`extractor` → 3. 沙箱外发请求 →
4. 非 2xx 判失败 → 5. `JSON.parse` → 6. 调 `extractor(response)` → 7. 校验返回字段类型

现在这个仓库里留了一个更轻的自检：它按同样的语义跑脚本，并拿真实的 `/health` 校验取值：

```bash
node tools/check-tr-usage-script.ts
```
