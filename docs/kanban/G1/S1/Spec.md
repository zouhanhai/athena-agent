---
id: g1_s1
title: "G1.S1: 后端服务骨架 (Fastify + AgentSession)"
layer: S
parent: G1
owner: hermes
status: active
milestone: M1
acceptance_criteria:
  - "Node/TS Fastify 后端能启动"
  - "AgentSession 内嵌 Pi 成功 (DeepSeek 对话)"
  - "提供 POST /api/chat 端点 (个人对话)"
  - "深色架构清晰可扩展"
---

# G1.S1: 后端服务骨架 (Fastify + AgentSession)

## Problem Statement

athena-agent 需要一个 Node/TS 后端作为门户的核心，通过 AgentSession 内嵌 Pi，
为每个员工提供个人对话能力。当前无任何代码骨架。

## Solution

用 Node/TS + Fastify 搭建后端骨架，集成 @earendil-works/pi-coding-agent 的 AgentSession。
提供基础 API 路由（个人对话），支持 DeepSeek 作为对话模型。

## User Stories

1. As an 员工, I want 使用个人对话, so that 可以和自己的 Pi 私聊
2. As an 开发者, I want 清晰的模块结构, so that 后续能加知识库/Kanban/团队对话
3. As an 管理员, I want AgentSession 正确内嵌, so that Pi 能力复用

## Implementation Decisions

- 框架: Fastify (ADR-0001)
- Pi 内嵌: AgentSession (@earendil-works/pi-coding-agent)
- 对话模型: DeepSeek (默认), 支持 Qwythos MTP 本地
- 模块划分:
  - `src/agents/` — AgentSession 管理 (每员工常驻实例)
  - `src/routes/` — API 路由 (个人对话)
  - `src/config/` — 配置
- API: POST /api/chat (个人对话, 流式)

## Testing Decisions

- 单元测试: AgentSession 创建/对话
- 集成测试: POST /api/chat → Pi → 回答
- 只测外部行为，不测实现细节

## Out of Scope

- 前端 (G1.S2)
- 知识库 / Kanban / 团队对话 (M2-M3)
- 多员工身份隔离 (M4)

## Further Notes

- 开发环境本地(6900XT)跑通，部署到 6900XT
- 参考 docs/adr/0001-node-fastify-agent-session.md
