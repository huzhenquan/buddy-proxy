# PR review 流程

外部 PR（GitHub 上别人提交的分支）与本仓库自己的实现单不同：提交人不在这条会话里，
改动的意图、边界、踩过的坑都不在你手上。所以用两条独立通道 + 主代理收尾。

**这份讲流程，「查什么」在 [`pr-review-checklist.md`](pr-review-checklist.md)。** 那份按
真实踩过的坑分了类（翻译放错层、生命周期窗口、假绿、脱敏器两个方向、位置参数错位……），
每条都写清症状与查法。派单前两份一起读。

## 0. 准备（主代理做，不要交给子代理）

```bash
git fetch buddy '+refs/pull/*/head:refs/pr/*'
git log --oneline -1 main
git log --oneline main..refs/pr/<N>
git diff main...refs/pr/<N>          # 三点：只看这个 PR 引入的改动
git rev-list --count $(git merge-base main refs/pr/<N>)..main   # 基线落后多少
```

记录四项事实：PR 号、作者、基线（merge-base）、改动面（文件数/行数）。基线落后 main
的要特别注意：作者看到的主干不是你正在跑的主干。

**工作区提醒**：如果当前在功能分支上开发，工作树内容不是 PR 的内容。判断 PR 的代码一律
用 `git show refs/pr/<N>:<路径>`，只有判断「与现状是否冲突」时才看工作树。

## 1. 两条独立通道（并行，互不通气）

每个 PR 派两个 reviewer，**不同模型家族**，独立上下文：

- 通道 A：`buddy/minmax-m3.1-flash`
- 通道 B：`buddy/deepseek-flash`（与主代理同一个模型）

两条通道**都不允许**：改代码、git 写操作、跑测试、发真实上游请求。
另外两条通道互不告知对方的结论 —— 交叉 review 的价值在于独立，先看别人的结论再「确认」
等于只有一条通道。

给 reviewer 的任务书必须包含三样，缺一样就是泛泛读代码：

1. **这个项目相关的硬规矩**（逐条列出来，写在任务书里，不要让 reviewer 自己回忆）。
   例：冷却只在流真正成功后清（`Settlement`）、5xx 不写冷却、402/503/502 的语义、
   一个会话只有一个刷新者、注销要删干净、模拟客户端的指纹不许改、不许假绿。
   完整的七条在 [`pr-review-checklist.md`](pr-review-checklist.md) 第 11 节，直接抄进任务书，
   并要求 reviewer 逐条给「成立 / 违反 / 未改动」的结论。
2. **要核的具体问题**（带文件与怀疑点），不是「请 review 这个 PR」。
3. **交付形状**：逐条结论（文件:行号）+ 能不能合（直接合 / 修完再合 / 重做）+
   必须改的 + 合并冲突面 + 给作者的英文短句。

任务书禁止 reviewer 只读 diff 标题就下结论；要求它读 `git show refs/pr/<N>:<文件>` 看
改动后的完整函数，因为 diff 看不到上下文。

## 2. 交叉比对（主代理做）

两份结论并列，逐条对照，只看三类：

- **两边都说有问题** → 直接采信，进「必须改」。
- **一边说有问题、另一边说没问题** → 这是最有价值的一条：主代理自己去核，用可执行的证据
  （读代码、看测试是否真断言、必要时在临时 worktree 里跑）。
- **两边都说没问题** → 仍需主代理抽查 2 到 3 条（尤其是「测试是否真断言」这类，最容易被
  两份 review 同时放过）。

分歧不要用「多数表决」解决，用证据解决。

## 3. 收尾验证（主代理做，不可委派）

review 只是读，结论要靠跑：

仓库已经有 CI（`.github/workflows/ci.yml`，动作与 `mise run check` 同一套，另外多一步隐私
扫描）。所以先看 CI，不要重复跑：

```bash
gh pr checks <N> -R <owner>/<repo>            # fork 的 PR 可能卡在 action_required（等批准）
```

`action_required` 不是失败，是等维护者批准（`0s`）。批准：

```bash
gh api -X POST repos/<owner>/<repo>/actions/runs/<run-id>/approve
```

CI 绿之后仍要**自己抽查关键行为**（第 3 条判据），以及在有冲突时验证合并。CI 只跑测试，
测试只覆盖作者想到的路径 —— 「CI 绿 ≠ 修好了」在 checklist 总则里写着原因。

需要本地复现时（合并验证、反证测试）：

```bash
git worktree add ~/projects/worktrees/pr<N> refs/pr/<N>   # 同一文件系统，不要放 /tmp
cd ~/projects/worktrees/pr<N>
mise run web:install && mise exec -- pnpm install         # 面板与网关两侧
mise run web:build                            # 面板静态托管那一段测试要 web/dist
mise run check                                 # 两侧 typecheck + 两套测试
```

不要在这些步骤里手敲 `pnpm`：它继承当前 shell 的 `NODE_OPTIONS`（其中可能有 Node 26 已删的
flag），必须走 `mise run` / `mise exec` 才拿到正确环境。

合并验证（在临时 worktree 里，不碰主工作树）：

```bash
git merge --no-commit --no-ff main             # 或 main 合入 PR 分支
mise run check                                 # 冲突解决后必须重跑，不许只看「合并成功」
```

三条判据，缺一不算验完：

1. **PR 自己绿**（在它的基线上跑 `mise run check`）。
2. **与 main 合并后绿**（冲突解决后重跑，不是看 merge 有没有报错）。
3. **关键行为抽查**：从两份 review 里挑 2 到 3 条断言，自己动手复现或反证
   （例如注释掉守卫看测试是否变红；跑一次假上游看状态码与冷却是否按规矩走）。

## 4. 结论与动作

主代理给每个 PR 一个结论，写清依据：

- **可合**：两通道无遗留问题 + 合并后 `mise run check` 绿 + 抽查成立。
- **修完再合**：列出必须改的项，等作者推新提交后回到第 0 步重跑（不要只核增量）。
- **重做**：涉及上面硬规矩中任何一条（会话持有者、注销残留、冷却语义、指纹改动）。

结论同时回一份给作者（英文短句，只说事实与要改的点，不评价人）。

## 5. 不要做的事

- 不要替作者改代码再「合进去」：那会把责任混掉，也掩盖了真正的问题面。
- 不要因为「测试都绿」就跳过读实现：这个仓库里测试曾经把错误命令固化成预期过。
- 不要在没跑过合并验证的情况下说「可以合」。
