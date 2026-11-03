// cc-switch「自定义用量查询脚本」：从代理的 /health 读 TokenRhythm 余额。
//
// 背景：代理（buddy-proxy 的 router-proxy，gateway.example:6450）自己持有多个 TokenRhythm
// 账号，按「赠额最先到期的先用」轮转消费（lib/tokenrhythm/accounts.ts 的 pickTenant），
// 所以一张 cc-switch 卡片对应的是**账户池**，不是单个账号 —— 卡片上的余额应该是池子的合计。
//
// 用法（cc-switch 里）：
//   供应商卡片 →「更多」→「配置用量查询」→ 打开「启用用量查询」
//   → **模板必须选「自定义」**（本脚本走 http://gateway.example:6450，非 https 且非
//     loopback；非自定义模板会要求 https 并且与 base_url 同源，会被挡掉）
//   → 把下面整段粘进代码框 →「测试脚本」
//
// 模板是「自定义」时，{{apiKey}} / {{baseUrl}} 会被替换成供应商自身的凭据，
// 本脚本用不到（/health 不校验 Authorization）。
//
// 想只看某一个账号：把下面的 TENANT_INDEX 改成 1 / 2 / 3（null = 池子合计）。

({
  request: {
    url: "http://gateway.example:6450/health",
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "cc-switch/1.0"
    }
  },

  extractor: function (response) {
    // 只看某一个账号；null = 池子合计。粘进 cc-switch 前可以改。
    var TENANT_INDEX = null;

    if (!response || typeof response !== "object") {
      return { isValid: false, invalidMessage: "代理没有返回 JSON" };
    }
    if (response.status && response.status !== "ok") {
      return { isValid: false, invalidMessage: "代理状态异常：" + response.status };
    }
    if (response.enabled && response.enabled.tokenrhythm === false) {
      return { isValid: false, invalidMessage: "代理没有启用 tokenrhythm（enabled.tokenrhythm=false）" };
    }

    var tr = response.upstreams && response.upstreams.tokenrhythm;
    if (!tr) {
      return { isValid: false, invalidMessage: "代理的 /health 里没有 tokenrhythm 一节" };
    }

    var tenants = tr.tenants || [];
    if (!tenants.length) {
      return { isValid: false, invalidMessage: "代理没有配置任何 tokenrhythm 账号" };
    }

    // 只挑没出错的；出错的是取不到余额，不是余额为零
    var ok = [];
    var failed = [];
    for (var i = 0; i < tenants.length; i++) {
      if (tenants[i].error) failed.push(tenants[i]);
      else ok.push(tenants[i]);
    }
    if (!ok.length) {
      return {
        isValid: false,
        invalidMessage: "所有账号都取不到余额：" + ((failed[0] && failed[0].error) || "未知错误")
      };
    }

    // 只统计有 key 的账号：没有 key 的账号接不了推理请求，代理也不会选它
    var usable = [];
    for (var j = 0; j < ok.length; j++) {
      if (ok[j].hasKey && ok[j].wallet) usable.push(ok[j]);
    }
    if (TENANT_INDEX !== null) {
      usable = usable.filter(function (t) { return t.index === TENANT_INDEX; });
      if (!usable.length) {
        return { isValid: false, invalidMessage: "没有编号为 " + TENANT_INDEX + " 的可用账号" };
      }
    }

    var remaining = 0;
    var currency = "CNY";
    var bits = [];
    var soonest = null;
    var soonestName = "";
    for (var k = 0; k < usable.length; k++) {
      var t = usable[k];
      var w = t.wallet;
      var amount = Number(w.availableCny);
      if (!isFinite(amount)) amount = 0;
      remaining += amount;
      if (w.currency) currency = w.currency;
      bits.push((t.name || ("#" + t.index)) + " ¥" + amount.toFixed(2));

      // 代理的选账规则是「有赠额的先用赠额，赠额里最先到期的先花」
      // （lib/tokenrhythm/accounts.ts 的 pickTenant），所以最早到期的那个就是正在被消耗的。
      var gift = Number(w.giftAvailableCny);
      if (!isFinite(gift)) gift = 0;
      var at = t.credits && t.credits.summary && t.credits.summary.nextExpiryAt;
      if (gift > 0 && at) {
        var ts = Date.parse(at);
        if (isFinite(ts) && (soonest === null || ts < soonest)) {
          soonest = ts;
          soonestName = t.name || ("#" + t.index);
        }
      }
    }

    var extra = usable.length + " 个账户 · " + bits.join(" · ");
    if (soonest !== null) {
      extra += " · 先耗 " + soonestName + "（赠额 " + new Date(soonest).toISOString().slice(0, 10) + " 到期）";
    }
    if (failed.length) {
      extra += " · " + failed.length + " 个账户查询失败";
    }
    var noKey = ok.length - usable.length;
    if (noKey > 0) {
      extra += " · " + noKey + " 个账户无 key（未计入）";
    }

    return {
      isValid: true,
      remaining: Math.round(remaining * 100) / 100,
      unit: currency,
      extra: extra
    };
  }
})
