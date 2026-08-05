---
id: g1_s2
title: "G1.S2: 前端 Web 门户骨架 (Vue3 + TDesign)"
layer: S
parent: G1
owner: hermes
status: active
milestone: M1
acceptance_criteria:
  - "Vue3 + Vite + TS 项目能启动，TDesign 引入"
  - "CALEO 品牌主题 (橙#ff6633 + 深灰蓝 + 天空蓝)"
  - "侧边栏布局骨架 (个人对话/知识/Kanban 路由占位)"
  - "个人对话面板可用 (发消息 + 显示回答, 支持 SSE 流式)"
  - "对接后端 POST /api/chat"
---

# G1.S2: 前端 Web 门户骨架 (Vue3 + TDesign)

## Problem Statement

athena-agent 需要一个前端门户，让员工通过 Web 界面与个人 Pi 对话。
当前后端 (G1.S1) 已提供 POST /api/chat 端点。前端需消费它，并提供门户导航骨架。

## Solution

用 Vue3 + Vite + TypeScript + TDesign (Vue) 搭建前端门户。
提供侧边栏导航骨架 + 个人对话面板（对接后端 /api/chat，支持 SSE 流式）。
CALEO 品牌色主题。

## User Stories

1. As an 员工, I want 在浏览器打开门户, so that 看到登录后的工作界面
2. As an 员工, I want 通过侧边栏导航, so that 在个人对话/知识/Kanban 面板间切换
3. As an 员工, I want 发送消息给个人 Pi 并实时看到回答, so that 完成个人对话
4. As an 员工, I want 看到流式输出, so that 对话体验流畅
5. As an 开发者, I want 清晰的组件结构, so that 后续加面板/功能容易

## Implementation Decisions

- 框架: Vue3 + Vite + TypeScript (Composition API)
- UI 库: TDesign Vue (腾讯, 与 WeKnora 同源)
- 状态: Pinia (Vue 官方状态管理)
- 路由: Vue Router
- 配色: CALEO 品牌 (橙 #ff6633 主 + 深灰蓝 #2d3142 + 天空蓝 #69b3e7)
- 目录结构 (web/):
  - `src/views/` — 页面 (个人对话/知识/Kanban 占位)
  - `src/components/` — 组件 (侧边栏/聊天气泡等)
  - `src/api/` — API 客户端 (POST /api/chat + SSE)
  - `src/stores/` — Pinia 状态
  - `src/router/` — 路由
- 个人对话 MVP: 手动输入 userId (M4 才做 Resend 登录)
- 对接后端: http://localhost:3000 (开发代理到 /api)

## Testing Decisions

- 组件测试: Vitest + Vue Test Utils
- 单元/集成: 对话面板发消息 → mock API
- 只测外部行为

## Out of Scope

- 知识库 / Kanban / 团队对话面板 (M2-M3)
- Resend 登录 / 多员工身份 (M4)
- Output 页面 (M5)

## Further Notes

- 开发目录: web/ (6900XT)
- 参考后端 API: POST /api/chat (G1.S1, 已 done)
- 参考 WeKnora 前端设计风格
- 面向德国/国际团队 (英文 UI)
