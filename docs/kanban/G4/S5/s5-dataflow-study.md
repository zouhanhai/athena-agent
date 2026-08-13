# S5 数据流与 Local kanban stalled 矛盾研究 (2026-08-13)

## 背景

G4.S5 (Kanban ↔ GitHub 双向同步) 全部完成 (T1-T12)。研究中发现一个**核心矛盾**：
Local kanban 视图通过 **Progress Log 判断 stalled** 是很好的模式，但在**远程场景**（视图读 GitHub 远程 md）下无法准确实现。

## 当前数据流

| 视图 | 数据源 | 内容 |
|---|---|---|
| **Local kanban**（选 repo）| GitHub 远程 md（`readRemoteIndex` / `scanRemoteBoard`）| 卡片、状态、Progress Log（**已 commit 的**）、stalled |
| **GitHub Project 视图** | GitHub（getRepoProjects / getProjectItems / listIssues）| 状态列、卡片、进度条 |
| **详情面板**（点卡片）| 本地 md（parseTicketMd）+ GitHub 评论 | 描述、Progress Log、评论 |
| **评论** | GitHub（getIssueComments / createIssueComment）| 讨论 |

## 核心矛盾：Progress Log 本地实时 vs 远程 commit 快照

### 设计（§44 + progress-log.ts:92）
- worker 在 **6900XT 本地**写 Progress Log（实时，`writeFile` 本地）
- **Progress Log 不 commit**（避免 git 噪音）
- stalled = `isStalled(status, 最后 Progress Log 时间戳)`，> 3 分钟 = stalled

### 矛盾
- worker 在本地写 Progress Log（未 commit）→ 实时进度在本地
- **Local kanban（选 repo）读 GitHub 远程 md** → 只能看到**已 commit** 的 Progress Log
- 远程 md 的 Progress Log 停在"认领时"（认领行随 claim commit 提交）
- → `isStalled` 判定 `now - 远程最后行时间戳 > 3min` = **误判 stalled**（worker 明明在跑）

### 实测确认（2026-08-13）
- T12 worker 认领 10 分钟，session 有 activity（msgs 16+），但 Local kanban 显示 **STALLED**
- 根因：远程 md 的 Progress Log 无新行（本地未 commit）

## 可能的解决方案（权衡）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. Local kanban 读 6900XT 服务端本地 md**（走 API 读服务端磁盘）| stalled 准确（读实时本地 Progress Log）| 只能看服务端 repo；浏览器不直接读服务端磁盘（需 API）|
| **B. Progress Log 也 commit**（低频：每 5 分钟 / 里程碑）| 远程能看到实时 Progress Log | 增加 git 噪音（违背 §44 设计初衷）|
| **C. 用别的 stalled 信号**（如 GitHub issue 活跃时间 / session 心跳，而非 Progress Log）| 远程可读 | 偏离"Progress Log 是源"的设计；需新信号源|
| **D. 混合**：Local 读服务端本地（准确 stalled）+ 远程用 GitHub 信号 | 兼顾 | 复杂，两套信号|
| **E. 接受现状**：stalled 是"观察提醒"，误判可接受（提醒检查）| 简单 | 误报会误导|

## 相关未决问题（待研究）

1. **详情面板数据源**：用户希望读 **GitHub issue body**（通用任何 repo），而非本地 md。当前详情面板读本地 md。
2. **Local kanban 视图去留**：暂不删（用户认为 stalled 判断模式有用），G6 再讨论。
3. **stalled 误判修复方向**：以上 A-E 方案选择。

## 方向决策（2026-08-13）

**两版功能分层**（用户决定）：平台分 web 版 + app 版，功能按场景分层：

| | **Web 版**（远程协作）| **App 版**（本地开发）|
|---|---|---|
| 场景 | 团队远程，浏览器连平台 | 本地安装，本机跑 worker |
| 读数据 | GitHub Project 视图为主 | 读本机文件系统 + worker |
| Progress Log / stalled | **不显示**（浏览器读不到本地，避免误判）| **显示**（读本机 md/worker，准确 stalled）|
| 定位 | 团队协作、GitHub 看板 | 单机开发、进度监控 |

**核心认知**：Progress Log（本地）在 web 下传不回来，是浏览器读不到本地文件系统的固有限制；app 版天然能读本机所以 stalled 准确。web 版专注 GitHub Project 视图（不依赖本地 Progress Log），app 版承载 Local kanban + Progress Log + stalled。

**stalled 天然只属于 app 版**（2026-08-13 确认）：Progress Log 不 commit → GitHub 上根本没有 Progress Log → web 版读 GitHub 天然不会有 stalled（无需专门去掉）；app 版读本地 md 有 Progress Log → stalled 准确。

**实现方式：单 repo + feature flag**（2026-08-13 确认）：web 和 app 共享 ~90%+ 代码，用**同一个 repo** + 运行时/build flag（如 `VITE_APP_MODE=web|app`）区分。web 模式不加载 stalled/Progress Log 本地逻辑，app 模式加载（读本地文件系统）。**不是 branch、不是 fork**（避免 branch drift 和 fork 重复）。

## 结论

Local kanban 的 stalled 判断模式有价值，但**web 场景下 Progress Log 不可见**导致误判。**方向：web 版不带 stalled 同步（专注 GitHub Project 视图），app 版带（读本机，stalled 准确）**。app 版作为本地开发工具，与 web 控制平面互补。此为 S5 收尾后的一个方向决策，细节留到 S6（远程 agent 联邦）一起设计。
