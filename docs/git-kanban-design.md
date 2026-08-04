# athena-agent — Git 驱动协作 Kanban 设计

> 核心设计：3 员工 + 3 Pi 操作同一个 git repo，通过 GitHub 上的 markdown 文件状态 + git commit 历史协调"谁该做什么、继续做什么"。
> 这是纯 git + markdown 模式（无本地 SQLite 真相源）。

## 一、核心原则

1. **Markdown 是唯一真相源** — `docs/kanban/*.md` 存所有任务状态
2. **Git 是协调机制** — commit 历史 = 活动记录，push 冲突 = 互斥锁
3. **GitHub 是共享中枢** — 3 员工 + 3 Pi 都 push/pull 同一个 repo
4. **每人独立 git 身份** — git commit 能区分是谁操作的

## 二、目录结构 = Gx.Sx.Tx 三层

```
athena-agent/docs/kanban/
├── G1/                           ← Goal 1 文件夹（发起时创建）
│   ├── _goal.md                  ← G1 卡片 (owner: pi-a)
│   ├── CONTEXT.md                ← grill 产物（Consultant 写）
│   ├── S1/                       ← Spec 1
│   │   ├── _spec.md              ← G1.S1 卡片
│   │   ├── T1.md                 ← Ticket 卡片
│   │   ├── T2.md
│   │   └── ...
│   └── S2/
├── G2/                           ← Goal 2（其他 Pi 发起）
│   └── ...
```

## 三、G 编号分配（全局递增，git 原子）

```
任何 Pi 发起新 Goal:
  1. git pull（同步最新）
  2. 扫描 docs/kanban/ 找当前最大 G 号（max G 文件夹名）
  3. 新 G = max + 1（如当前到 G5 → 创建 G6）
  4. 创建 G6/ 文件夹 + _goal.md（owner = 发起 Pi）
  5. git commit + push
  6. 若 push 冲突（别人同时建了 G6）→ pull → 重新计算（G7）→ 重试
```

**保证唯一性**：git push 原子性 —— 两个 Pi 同时建 G6，只有一个 push 成功，另一个冲突后重试建 G7。

## 四、Ticket 领取锁（Worker 认领）

```
任何 Worker 领取 ticket:
  1. git pull（最新看板）
  2. 选 ticket: status ∈ {backlog, rejected} 且 assignee 空/自己
  3. 改 T1.md frontmatter:
     status: in_progress
     assignee: pi-a
     started_at: <时间>
  4. git commit -m "领取 G1.S1.T1 (in_progress)" + push
  5. push 成功 → 锁定，开始开发
  6. push 冲突 → pull → 看到 status 已变 → 放弃，选下一个
```

**互斥保证**：git push 原子性 —— 只有第一个 push 成功者获得 ticket。

## 五、Ticket Markdown 格式

```markdown
---
id: t_abc123
title: "G1.S1.T1: 实现登录 API"
layer: T
parent: G1.S1
owner: pi-a
status: in_progress        # backlog → in_progress → done → in_review → approved / rejected
assignee: pi-a
started_at: 2026-08-04
blocked_by: []
acceptance_criteria:
  - "POST /api/login 返回 200"
pr: 0                       # GitHub PR 号
branch: ""                  # feat/t1-login-api
---

## Task
实现细节...

## Log
[2026-08-04] pi-a 领取并开始
[2026-08-04] pi-a 完成实现
```

## 六、状态机

```
backlog ──领取(push)──▶ in_progress ──实现完成──▶ done
   ▲                        │                      │
   │                        │                      ├─ 开 PR → in_review
   │                        │                      │
   └──── reject ◀───────────┴──────────────────────┴→ approved (PR merged)
```

| 状态 | 含义 | 谁设置 |
|------|------|--------|
| backlog | 未开始，可认领 | 规划者 |
| in_progress | 已认领，开发中 | Worker（领取锁）|
| done | 实现完成 | Worker |
| in_review | PR 待审查 | Worker（开 PR 后）|
| approved | 审查通过 + merged | Reviewer |
| rejected | 审查发现问题 | Reviewer |

## 七、PR/Merge 集成

```
T1 done（分支 feat/t1-login-api）:
  → 开 GitHub PR → 更新 ticket: status=in_review, pr=<号>, branch=<名>
  → Reviewer 审查
  → 通过 → merge → ticket: status=approved
  → 拒绝 → PR 更新 → 重新 review
```

自动化选项：GitHub Actions / webhook 检测 PR 状态 → 自动更新 md frontmatter。

## 八、多人协作流程（谁在什么阶段做什么）

```
Goal 发起（多 Pi 各自发起，编号递增）:
  Pi-A 发 G1, Pi-B 发 G2, Pi-C 发 G3

单 Goal 生命周期:
  前 3 阶段（发起 Pi 单人多角色，不拆给他人）:
    Consultant → PM → Eng Director
    （同一个 Pi 扮演，产出 CONTEXT.md + spec + tickets）
  
  Worker 阶段（多人协作开始）:
    Pi-A 领 T1, Pi-B 领 T2, Pi-C 领 T3（git 领取锁）
    通过团队频道 (pi-intercom) 协调分工
  
  审核阶段（另一个 Pi）:
    Pi-B 审查 Pi-A 的 T1 → approve/reject
```

## 九、Pi 之间沟通（团队频道）

用 **pi-intercom**（已装）实现 Pi 会话间协调：
```
Pi-A → Pi-B: "T2 你帮做一下？"
Pi-B → Pi-A: "好，我领了"
```

- 团队对话 = 实时协商（谁帮谁、谁做哪个）
- git 看板 = 持久记录（协商后认领结果写进 md）

## 十、"谁该做什么、继续做什么"判断逻辑

```
每个员工/Pi 启动时:
  git pull → 读所有 T-layer md
  status=backlog + assignee=空 → 候选可领
  status=in_progress + assignee=我 → 我继续做
  status=done + 有PR → 等 review
  status=in_review + 我是reviewer → 我审查
  blocked_by 未done → 等依赖
```

## 十一、Reject 流程（Reviewer 打回 → Eng Director 重新生成）

```
Reviewer (Pi-B) 审查 Pi-A 的 T1 → 发现问题:
  1. T1 标记 rejected（保留历史，不修改原 ticket，`qa_feedback` 记录意见）
  2. 通知 Eng Director（发起该 G 的 Pi）
  3. Eng Director 分析 qa_feedback → 重新拆解 → 创建新 ticket
     ├─ 小返工 → T1.1（parent_id=T1, reopen_reason, qa_feedback）
     └─ 大问题 → 重新审视 spec，可能拆成多个新 ticket
  4. 新 ticket 进入 backlog，等 Worker 认领（领取锁）
```

**关键规则**：
- **新 ticket 由 Eng Director 生成**（发起 G 的 Pi），不是 Reviewer
- **原 ticket 标记 rejected 保留**，不修改（历史不丢）
- 新 ticket 带 `parent_id` 链接旧 ticket + `qa_feedback` + `reopen_reason`
- 任何 Worker 都可认领新 ticket（保持协作开放），但会标注来源

**理由**：Eng Director（规划者）最清楚 spec 全局，review 发现问题往往意味着需要重新审视拆解是否合理，而非简单返工。规划权集中在规划者手里。

## 十二、异常处理

- **Worker 崩溃卡 in_progress**：看 git log 时间戳，超时未更新 → 另一 Worker 可接管（改回 backlog 或接手）
- **md 冲突**：不同 Worker 改不同 ticket 文件不冲突；抢同一 ticket 冲突正是互斥锁
- **main 并发**：多 PR 同时 merge 可能冲突 → rebase 解决
