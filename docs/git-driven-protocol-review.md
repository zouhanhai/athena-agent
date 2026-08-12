# Git-Driven Development — Protocol Review (WIP, 2026-08-12)

> 用户要求的完整梳理（grill）：目标/角色/协议接口/状态机/worker 生命周期(认领-进度-完成)/review/各 agent 接入。
> 本文档记录 grill 过程中**已确认的决策点**；完整协议重写见 `docs/git-kanban-design.md`（待更新）。

## 核心前提（用户确认）

- **协议 vs 实现分离**：git-driven development 是 athena 平台**推荐的 work 流协议**，不绑定某个 agent。
  每个 user 有不同本地 agent + 不同 code worker agent（opencode 只是当前用的）。
  athena 只需告诉各 agent "**怎么接入我们的 workflow**"，不固定工具链。
- **Progress Log 表**在 ticket md 文件底部（`docs/kanban/Gx/Sx/Tx.md` 的 `## Progress Log` 段），不是 kanban index。
- **S4 插件扩展**：插件自动做认领（git lock）+ 记进度；**完成 commit 留 worker**（质量判断）。

## 已确认决策点

### D1. ## Log vs ## Progress Log（讨论后）
- 分开：`## Log` 保留（生命周期审计：认领/完成/review 事件，LLM 手动），
  `## Progress Log` 新增（实时进度表，**插件自动写**，真实 wall-clock 时间戳 + 限流）。
- 但认领/完成**也应进 Progress Log**（插件写），省去 LLM 忘写。
  （详见后续 grill——此点待完全敲定合并/分开。）

### D2. kanban index 更新责任（用户确认）
- **index 文件必须 commit**：repo 在远程(GitHub)，服务器只通过 git pull 看远程变化。
  若不 commit index，服务器 pull 后读不到远程 repo 的进度。
- **index 随每次 board 变化 commit**：新建 G/S/T、认领、完成都要 commit；
  在这些 commit **顺带一起跑 `write-index.ts` 更新 kanban-index.json**（不会多 commit，
  因为本来就要 commit）。
- 触发：S4 插件认领时自动跑；worker 完成时也做；规划者新建 G/S/T 时也做。
- 前端看板 Refresh → `rescan=1` 自动重建（运行时快），但 index 文件 commit 保证远程 repo 最新。
