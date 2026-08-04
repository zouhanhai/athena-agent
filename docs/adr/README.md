# ADR 记录

每个 ADR 记录一个关键架构决策的背景、选择和后果。编号连续。

---

## ADR-001: 使用 Node/TS + Fastify 作为门户后端，内嵌 Pi AgentSession

**状态**: 已接受（2026-08-04）

**背景**: 门户需要把 Pi 作为对话后端。Pi 是纯 TypeScript 项目（`@earendil-works/pi-coding-agent`），官方推荐用 `AgentSession` 直接内嵌（`src/core/agent-session.ts`），而非 spawn 子进程走 RPC。

**决策**: 后端用 Node/TS + Fastify，通过 `AgentSession` 内嵌 Pi。每个员工一个 AgentSession 实例（常驻，天然隔离）。

**理由**:
- AgentSession 内嵌 = 进程内直接调用，无 shell 网关开销
- Pi 的 8 个扩展都是 npm 包，Node 生态直接复用
- Fastify 性能好、TS 友好、适合实时聊天流式

**后果**: 后端必须 Node.js（不能 Python 内嵌）；门户后端与 Pi 引擎同进程。

---

## ADR-002: 认证用邮箱魔法链接（Resend）

**状态**: 已接受（2026-08-04）

**背景**: 3 名员工通过 Tailscale 访问门户，需要身份区分。公司邮箱是 Outlook（Microsoft 365），但 SMTP AUTH 被租户禁用（普通密码和应用密码都 535）。

**决策**: 用邮箱魔法链接登录，通过 **Resend API** 发信（key 已验证有效）。

**理由**: Resend 绕过 Outlook SMTP 限制，免费额度够 POC，不依赖公司 IT。

**后果**: 需在 Resend 验证 caleo.com 域名才能发员工；POC 阶段只能发给自己（`zouhanhai@live.com`）。

---

## ADR-003: 知识检索用 LightRAG，图谱用其自带 UI

**状态**: 已接受（2026-08-04）

**背景**: 需要向量+图谱检索，且要在门户展示知识图谱。

**决策**: LightRAG 作为检索服务，POC 阶段用默认 NetworkXStorage（文件后端，零额外依赖）。图谱可视化直接用 LightRAG 自带 Web UI（iframe 嵌入门户图谱面板）。

**理由**: LightRAG 自带 `GET /graphs` API 和完整图谱可视化 UI（力导向布局、节点类型分类），不用自绘。

**后果**: 规模变大后需迁移 Neo4j 或 Milvus。

---

## ADR-004: Wiki 用 llm_wiki 服务 + 前端自绘

**状态**: 已接受（2026-08-04）

**背景**: 需要"Wiki 沉淀"能力（Karpathy 模式：LLM 增量生成互联 markdown wiki）。

**决策**: 用 nashsu/llm_wiki 作为服务（:19828 HTTP API + MCP），门户后端调其 API 拿 wiki 数据，前端用 Vue 自绘（CALEO 风格）。

**理由**: llm_wiki 有独立 HTTP API（tiny_http，:19828）+ MCP，数据能力完整；其前端是 Tauri 桌面应用不能 Web iframe，故前端自绘。

**后果**: 需验证 llm_wiki 能 headless 跑（6900XT 有 Xvfb）；需装 Rust 编译。

---

## ADR-005: 开发模式 = 本地 Hermes + 远程 OpenCode

**状态**: 已接受（2026-08-04）

**背景**: 项目在 6900XT 开发/部署，但用户希望保留本地 Hermes 的 TUI 体验。

**决策**: 本地 WSL 跑 Hermes（TUI），6900XT 装 OpenCode（headless serve），Hermes 编排 + OpenCode 执行编码。athena-agent 仓库放 6900XT。

**理由**: 符合用户现有 Hermes→OpenCode 工作流；OpenCode 有 headless 模式适合远程。

**后果**: 本地和 6900XT 各装一套工具；通过 SSH/Tailscale 通信。

---

## ADR-006: Kanban 用 TS 重写，Pi 驱动

**状态**: 已接受（2026-08-04）

**背景**: 现有 Kanban 是 Python 写的，用户希望结合 Pi 扩展增强。

**决策**: 不用现有 Python Kanban，门户内用 TS 重新实现，由 Pi 驱动任务流转（结合 pi-task / pi-goal-list-loop-audit / pi-dynamic-workflows）。

**理由**: 与 Node/TS 后端统一；Pi 扩展能自动拆解/审计/并行执行任务。

**后果**: 需重新实现 Kanban（工作量大），但换来 Pi 驱动的自动化。

---

## ADR-007: 对话结构 = 个人独立 AgentSession + 团队共享 Pi

**状态**: 已接受（2026-08-04），目标演进

**背景**: 需要个人对话隔离 + 团队协作对话。

**决策**: POC 阶段个人对话 = 每员工独立 AgentSession（常驻）；团队对话 = 一个共享 AgentSession。最终目标（方案 B）：Pi 作为可发言的团队成员，通过 pi-intercom 通信。

**理由**: POC 简单清晰；方案 B 预留扩展性（团队消息用统一事件流，Pi 接入即加订阅者）。

**后果**: POC 是"Pi 是助手"；架构预留"Pi 可发言"。
