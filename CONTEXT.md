# Athena Agent

为 CALEO 部门 3 名员工提供统一智能协作门户：每个人有自己的 Pi 助手，团队共享对话、知识图谱、Wiki、Kanban。底层全部由开源组件（Pi + LightRAG + LLM Wiki + CodeGraph）驱动，通过 git repo 跨机器多 agent 协作。

## Language

**员工 (Employee)**:
CALEO 部门真人成员（A/B/C），通过浏览器访问门户，每人有独立 git 身份。
_Avoid_: 用户, member

**Pi (Agent)**:
底层 AI 编码代理（`@earendil-works/pi-coding-agent`），每位员工的智能助手。通过 AgentSession 内嵌在门户后端。
_Avoid_: bot, assistant

**AgentSession**:
Pi 的核心类，进程内嵌的 agent 会话实例。每员工一个（常驻，天然隔离）。
_Avoid_: session, worker process

**个人对话**:
员工与自己的 Pi 私聊（独立 AgentSession）。
_Avoid_: DM, private chat

**团队对话**:
所有员工 + 共享 Pi 的协作区。POC 为助手模式，最终目标 Pi 可发言（方案 B）。
_Avoid_: group chat

**Goal (G)**:
一个由某 Pi 发起的顶层目标。全局编号递增（G1、G2...）。每个 Goal 一个文件夹，含 grill 产出的 **Goal.md**。
_Avoid_: project, initiative

**Spec (S)**:
Goal 下的功能容器（G1.S1）。由 PM 读 G1/CONTEXT.md 用 to-spec 生成。含 spec.md 和其下所有 tickets。
_Avoid_: feature, module

**Ticket (T)**:
Spec 下的原子任务（G1.S1.T1）。由 Eng Director 用 to-tickets 拆解。Worker 通过领取锁认领。
_Avoid_: task, issue

**领取锁**:
Worker 认领 ticket 的机制：改 frontmatter status=in_progress + git push 原子操作。push 冲突 = 互斥锁。
_Avoid_: lock, reservation

**Wiki**:
LLM 增量生成的互联 markdown 知识库（Karpathy 模式）。
_Avoid_: knowledge base

**知识图谱**:
实体关系可视化（LightRAG NetworkX 图数据）。
_Avoid_: graph view

**Kanban**:
Pi 驱动的任务看板（git-driven，docs/kanban/ 为真相源）。
_Avoid_: board, taskboard

## Rules

- **员工/Pi 独立 git 身份** — git commit 能区分是谁操作的
- **Markdown 是唯一真相源** — docs/kanban/*.md 存所有任务状态，无本地 SQLite
- **grill 产出 = G1/Goal.md** — 是 to-spec 的输入；项目根 CONTEXT.md 只是术语表
- **ADR 只在三条件全满足时写** — 难反转 + 意外 + 真实权衡
- **领取锁只领 backlog** — rejected 需先通知 Eng Director 重新生成
- **前 3 阶段（GRILL/SPEC/PLAN）单 agent 完成** — 同一 Pi 扮演 Consultant→PM→Eng Director
