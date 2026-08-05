# AGENTS.md — athena-agent Dev Worker 指南

本文件是 OpenCode/agent 开发此项目时的操作规范。

## 项目本质

athena-agent 是一个以 **Pi 为核心**的多员工智能协作门户。
- **Pi SDK** 是核心引擎（对话/agent/logic），Fastify 是 HTTP 薄壳
- 开发帝的 Dev Worker 是 **OpenCode**（本项目只是用 OpenCode 写 athena 代码，这与 athena 产品本身无关）

## Kanban 结构（git-driven）

所有任务通过 git 仓库里的 markdown 文件管理。看板在 `docs/kanban/`：

```
docs/kanban/
├── G{序号}/              ← Goal 层（目录）
│   ├── Goal.md           ← 该 Goal 的目标/grill 产物/验收标准
│   └── S{序号}/          ← Spec 层（子目录）
│       ├── Spec.md       ← 该 Spec 的需求/实现决策/验收标准
│       └── T{序号}.md    ← Ticket 层（你要完成的具体任务）
```

### 从 Ticket 找到 Spec 和 Goal（必须遵守）

每个 Ticket 的 frontmatter 有层级字段：
- `parent: G1.S1` → 定位到 `docs/kanban/G1/S1/Spec.md`
- `parent` 的上级 → 定位到 `docs/kanban/G1/Goal.md`

**开发任何 ticket 前**，读取：
1. 该 ticket 文件本身（当前任务）
2. `docs/kanban/{G}/{S}/Spec.md`（需求/验收标准）
3. `docs/kanban/{G}/Goal.md`（整体目标/验收标准）

### Ticket 状态流转（领取锁）

```
backlog → in_progress → done → in_review → approved
                            ↘ rejected → Eng Director 重新生成 T{N}.N
```

**认领 ticket**：把 status 改为 `in_progress`，assignee 改为 `opencode`，
然后 `git add + commit + push`（git push 原子性保证互斥，防冲突）。

**只能认领 status=backlog 的 ticket。rejected 的不可直接认领。**

## 开发规范（OpenCode Worker）

### 必用 Skills

- **tdd**: 红-绿-重构循环。先在公共 seam 写测试，再最小实现
- **implement**: 基于 spec/ticket 实现，用 `codegraph_explore` 理解代码
- **code-review**: 完成实现后，按 Standards + Spec 双轴审查
- **diagnosing-bugs**: 遇到 bug 用系统化 6 阶段诊断

### 必用 CodeGraph

项目代码用 **CodeGraph** 索引（`codegraph serve --mcp`）。
理解/定位代码时优先用 `codegraph_explore`（比 grep/find 更全面），
它能跟随调用链、动态分发，找到 grep 找不到的连接。

### 工作流

一个 ticket 的完整流程：
1. 读 ticket + 对应 Spec.md + Goal.md
2. 认领（改 status + push）
3. `codegraph_explore` 理解现有代码
4. 按 **tdd** 开发（先测试后实现）
5. 实现完成，改 status=done，写 Log
6. commit + push

## 技术栈

- Node 24+ / TypeScript（严格模式）
- 后端: Fastify + @earendil-works/pi-coding-agent (Pi SDK)
- 前端: Vue3 + TDesign + Vite
- 数据库: Postgres 16 + pgvector

## 参考文档

- `README.md` — 项目概览 + 里程碑
- `docs/adr/` — 架构决策（每条一个文件）
- `docs/git-kanban-design.md` — Kanban 机制
- `docs/pi-capabilities.md` — Pi SDK + packages 能力
