# 子代理角色索引

角色定义就在子代理自己的文件里：`.pi/agents/<角色>.md`。一个子代理只读自己那一份，加上
主代理指名的任务上下文 `docs/tasks/<任务>/context.md`。不要读别的角色的文件。

| 角色 | 文件 | 一句话 |
|---|---|---|
| fe | `.pi/agents/fe.md` | 面板前端实现与单测 |
| be-core | `.pi/agents/be-core.md` | 转发链路：路由、选路、方言、传输 |
| be-admin | `.pi/agents/be-admin.md` | provider/upstream 增删改查、凭据、登录、签到、admin 接口 |
| fe-review | `.pi/agents/fe-review.md` | 前端代码与前端单测的 review |
| be-review | `.pi/agents/be-review.md` | 后端代码与后端单测的 review |
| e2e | `.pi/agents/e2e.md` | 端到端测试编写与维护 |
| js-reverse | `.pi/agents/js-reverse.md` | 上游客户端与平台的调研、必要时逆向 |

每个角色文件里都写全了：职责、范围、边界、验收、工作方式、通用约定（不部署、不推 git、
不碰凭据、不发真请求、交付写进「交付记录」）。

派发方式与经验：`docs/reference/agent-specs/collaboration.md`。
任务上下文：`docs/tasks/<任务>/context.md`（主代理写，子代理把交付追加在「交付记录」）。
