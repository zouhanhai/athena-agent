# Athena Agent — 术语表（Glossary）

项目统一术语，避免沟通歧义。

## 角色

| 术语 | 定义 |
|------|------|
| **员工 (Employee)** | CALEO 部门真人成员（A/B/C），通过浏览器访问门户 |
| **Pi (Agent)** | 底层 AI 编码代理（`@earendil-works/pi-coding-agent`），每位员工的智能助手 |
| **AgentSession** | Pi 的核心类，进程内嵌的 agent 会话实例。每员工一个（常驻）|

## 门户面板

| 术语 | 定义 |
|------|------|
| **个人对话** | 员工与自己的 Pi 私聊（独立 AgentSession）|
| **团队对话** | 所有员工 + 共享 Pi 的协作区（POC 为助手模式）|
| **Wiki** | LLM 增量生成的互联 markdown 知识库（Karpathy 模式）|
| **知识图谱** | 实体关系可视化（LightRAG NetworkX 图数据）|
| **Kanban** | Pi 驱动的任务看板（TS 实现）|
| **CodeGraph** | 代码结构分析图谱 |

## 服务组件

| 术语 | 定义 |
|------|------|
| **LightRAG** | 向量+图谱检索服务（HKUDS），POC 用 NetworkXStorage |
| **llm_wiki** | nashsu 的 LLM Wiki 桌面应用，提供 :19828 HTTP API + MCP |
| **llama-server** | Qwythos MTP 本地推理服务（:8080，OpenAI 兼容）|
| **DeepSeek** | 云端对话模型（API）|
| **Qwythos** | 本地推理模型（AMD ROCm，57 tok/s，支持视觉）|
| **Postgres** | 主数据库（含 pgvector 向量扩展）|
| **Resend** | 邮件发送服务（魔法链接认证）|
| **Tailscale** | 组网工具（员工在德国，私有网络访问 6900XT）|

## 架构概念

| 术语 | 定义 |
|------|------|
| **Karpathy 模式** | LLM 增量构建互联 wiki：Raw → Wiki → Schema，index.md 为目录，[[wikilink]] 交叉引用 |
| **MCP** | Model Context Protocol，Pi 通过 pi-mcp-adapter 接入外部服务 |
| **RAG** | 检索增强生成 |
| **NetworkXStorage** | LightRAG 的默认图存储（networkx，文件后端）|
| **pgvector** | Postgres 向量扩展，存 embedding |

## 状态

| 术语 | 定义 |
|------|------|
| **MVP** | 最小可行产品（先跑通对话+Kanban）|
| **POC** | 概念验证 |
| **方案 A/B** | 对话结构演进（A=助手，B=可发言团队成员）|

## Pi 扩展包

| 包名 | 用途 |
|------|------|
| **pi-mcp-adapter** | MCP 客户端（接 LightRAG/llm_wiki/CodeGraph）|
| **pi-intercom** | Pi 会话间通信（员工协作）|
| **@mjasnikovs/pi-task** | 任务拆解管线（refine/research/grill/compose/critique）|
| **pi-goal-list-loop-audit** | 目标审计验收（独立审计会话验证完成）|
| **@quintinshaw/pi-dynamic-workflows** | 并行执行（worktree 隔离、模型路由）|
| **pi-hermes-memory** | 持久记忆（Hermes 移植，SQLite FTS5）|
| **pi-web-access** | 网络搜索/PDF/URL |
| **@juicesharp/rpiv-ask-user-question** | 结构化提问（glla 依赖）|
