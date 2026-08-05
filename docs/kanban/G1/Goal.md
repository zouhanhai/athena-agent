---
id: g1
title: "G1: 项目骨架 + AgentSession 个人对话"
layer: G
owner: hermes   # 发起人 (当前为 Hermes 扮演, 后续员工/Pi 各自)
status: active
created_at: 2026-08-04
milestone: M1
acceptance_criteria:
  - "Node/TS + Fastify 后端能启动"
  - "AgentSession 内嵌 Pi 成功"
  - "个人对话端到端跑通 (前端→后端→Pi→回答)"
  - "Vue 前端有侧边栏骨架"
---

# G1: 项目骨架 + AgentSession 个人对话

## 背景 / Context

这是 athena-agent 项目的第一个 Goal，对应 Milestone M1。
目标：搭起整个项目的技术骨架，并跑通最核心的"个人对话"闭环。

参考设计文档：
- README.md (架构概览 + M1 验收标准)
- docs/adr/0001-node-fastify-agent-session.md (Node/TS + Fastify + AgentSession)
- docs/git-kanban-design.md (git 驱动 Kanban)
- CONTEXT.md (术语表)

## 目标 / Goal

1. 建立 athena-agent 项目的 Node/TS + Fastify 后端骨架
2. 通过 `AgentSession`（@earendil-works/pi-coding-agent）内嵌 Pi
3. 建立 Vue 3 + TDesign 前端骨架（CALEO 橙色主题）
4. 跑通"个人对话"端到端：员工 → 前端 → 后端 → Pi(AgentSession) → 回答

## 已确认决策

- 后端: Node/TS + Fastify (ADR-0001)
- Pi 内嵌: AgentSession (ADR-0001)
- 前端: Vue3 + TDesign, CALEO 橙色 #ff6633
- 部署目标: 6900XT (开发时本地跑通)

## 技术栈

```
server/   → Node/TS Fastify + AgentSession
web/      → Vue3 + TDesign + Vite
models    → DeepSeek (对话) + Qwythos MTP (本地, 可选)
```

## 完成标准

见 frontmatter acceptance_criteria。对应 Spec G1.S1 及其下 Ticket 全部 approved。
