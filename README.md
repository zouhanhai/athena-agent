# Athena Agent — 团队智能协作门户

> 项目代号 **Athena**（智慧女神）· 部署于 6900XT 团队服务器
> 本文档是 grill-with-docs 流程的产物，固定所有已确认的架构决策。

## 一句话定位

为 CALEO 部门 3 名员工提供一个**统一协作门户**：每个人有自己的 Pi 智能助手，团队共享对话/知识图谱/Wiki/Kanban，底层全部由开源组件（Pi + LightRAG + LLM Wiki + CodeGraph）驱动。

## 已确认决策（ADR 编号见 `docs/adr/`）

| # | 决策 | 说明 |
|---|------|------|
| 1 | 部署目标 | 6900XT Ubuntu，Tailscale 组网（员工在德国）|
| 2 | 认证 | 邮箱魔法链接（Resend key 已验证，需配 caleo.com 域名）|
| 3 | 后端 | Node/TS + Fastify + AgentSession 内嵌 Pi |
| 4 | 前端 | Vue3 + TDesign，参考 WeKnora 布局，CALEO 橙色（#ff6633）|
| 5 | 数据库 | Postgres + pgvector（向量）；图谱 = LightRAG NetworkX（POC）|
| 6 | 对话模型 | DeepSeek（对话）+ Qwythos MTP（本地/视觉，:8080）|
| 7 | 知识检索 | LightRAG（检索+图谱，自带 UI）|
| 8 | Wiki 沉淀 | llm_wiki 服务（:19828 API + MCP），前端自绘 CALEO 风格 |
| 9 | Kanban | TS 重写，Pi 驱动（pi-task/glla/dynamic-workflows）|
| 10 | 开发模式 | 本地 Hermes TUI + 6900XT OpenCode headless |
| 11 | 对话结构 | 个人=独立 AgentSession，团队=共享 Pi（最终目标 B：Pi 可发言）|
| 12 | Pi 扩展 | mcp-adapter/intercom/pi-task/glla/dynamic-workflows/hermes-memory/web-access |

## 系统架构

```
员工浏览器 → Tailscale → 6900XT 门户 (Vue 前端)
  │
  ├─ 💬 个人对话 → 门户后端 → AgentSession (Pi) → DeepSeek/Qwythos
  ├─ 👥 团队对话 → 门户后端 → 共享 AgentSession (Pi)
  ├─ 📚 Wiki     → 门户后端 → llm_wiki (:19828) → markdown → Vue 渲染
  ├─ 🕸 图谱     → iframe 嵌入 LightRAG 自带图谱 UI
  ├─ 📁 CodeGraph → 6900XT 部署 → 代码分析
  └─ 🎫 Kanban  → 门户后端 → Pi 驱动任务流转 (TS)
       ├─ pi-task (任务拆解)
       ├─ pi-goal-list-loop-audit (审计验收)
       └─ pi-dynamic-workflows (并行执行)
```

## 端口规划

| 服务 | 端口 | 绑定 |
|------|------|------|
| llama-server (Qwythos) | 8080 | 127.0.0.1（需改 0.0.0.0）|
| LightRAG | 待定 | - |
| llm_wiki | 19828 | 127.0.0.1（需改 0.0.0.0）|
| 门户后端 (Fastify) | 主端口 | 0.0.0.0 |
| 门户前端 (Vue) | 待定 | 0.0.0.0 |

## 目录结构

```
athena-agent/
├── CONTEXT.md            # 全局术语表 (ubiquitous language)
├── docs/
│   ├── adr/                      # 架构决策记录 (每条一个文件)
│   ├── git-kanban-design.md      # git 驱动 Kanban 设计
│   ├── knowledge-rag-design.md   # 知识库与 RAG 路由设计
│   └── output-design.md          # Output 页面设计 (NotebookLM 式)
├── server/           # Node/TS Fastify 后端
│   ├── src/
│   │   ├── agents/   # AgentSession 管理
│   │   ├── routes/   # API 路由
│   │   ├── kb/       # 知识服务客户端 (LightRAG/llm_wiki)
│   │   └── kanban/   # Pi 驱动 Kanban
│   └── ...
├── web/              # Vue3 + TDesign 前端
├── deploy/           # 部署配置 (6900XT)
└── README.md
```

## 里程碑（MVP 顺序）

每个 Milestone 有明确验收标准（Definition of Done），对应 Goal 全部完成才算 done。

1. **M1**: 项目骨架 + AgentSession 个人对话
   - 验收: Node/TS 后端能启动；AgentSession 内嵌 Pi 成功；个人对话端到端跑通（前端→后端→Pi→回答）；Vue 前端有侧边栏骨架
   - 对应: G1 (项目骨架 + AgentSession)

2. **M2**: 知识图谱 (LightRAG) + Wiki (llm_wiki)
   - 验收: LightRAG 启动配 DeepSeek+Postgres；llm_wiki headless 跑提供 :19828；Pi 能通过 MCP 检索两个系统；图谱面板 iframe 显示
   - 对应: G2 (LightRAG + llm_wiki)

3. **M3**: Pi 驱动 Kanban + 团队对话
   - 验收: git-driven kanban 跑通（G创建/领取锁/PR/Reject）；3 员工可并行领 ticket；团队对话共享 Pi；pi-intercom 协调
   - 对应: G3 (Pi Kanban + 团队对话)

4. **M4**: CodeGraph + 多员工隔离 + 部署 6900XT
   - 验收: CodeGraph 部署索引代码；3 员工独立 git 身份 + 独立 AgentSession；门户部署 6900XT 经 Tailscale 访问；认证(Resend)可用
   - 对应: G4 (CodeGraph + 多员工隔离 + 部署)

5. **M5**: Output 页面 (txt/blog/图表/pptx/html) — 核心跑通后实施
   - 验收: 从知识库+Web 来源生成 txt/blog/图表；pptx/html 生成可用；前端预览 + 下载
   - 对应: G5 (Output 页面)

## 关键风险

- llm_wiki 是 Tauri 桌面应用，需验证 headless 跑（Xvfb 已有）提供 API
- 服务绑定需从 127.0.0.1 改 0.0.0.0 供 Tailscale 访问
- Resend 测试模式只能发给自己，需验证 caleo.com 域名才能发员工
- LightRAG NetworkX POC 可，规模大需 Neo4j

## 未决事项（待后续确认）

- CodeGraph 具体部署方式
- 门户前后端具体端口
- Resend 域名验证
- llm_wiki headless 可行性验证
