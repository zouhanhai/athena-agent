---
id: g2
title: "G2: 知识库 (LightRAG + llm_wiki + docling 摄入)"
layer: G
owner: hermes
status: active
created_at: 2026-08-05
milestone: M2
acceptance_criteria:
  - "LightRAG 启动配 DeepSeek + Postgres(pgvector)"
  - "llm_wiki headless 跑提供 :19828 API"
  - "docling 统一解析所有文件类型 + URL → Markdown → 双管道摄入"
  - "Pi 通过 MCP 检索两个知识系统 (Agentic RAG 路由)"
  - "前端有 Knowledge 图谱面板 (iframe) + Wiki 浏览面板"
  - "前端有数据/文档输入接口 (上传 + URL + 进度条)"
---

# G2: 知识库 (LightRAG + llm_wiki + docling 摄入)

## 背景 / Context

对应 Milestone M2。目标：为 athena 门户建立团队知识库 —— 双知识系统
(LightRAG 向量+图谱, llm_wiki wiki 页面) + 统一文档摄入 (docling)。

参考设计文档:
- README.md (架构概览 + M2 验收标准)
- docs/knowledge-rag-design.md (知识库 + RAG 路由设计, 唯一参考)
- docs/adr/0004-llm-wiki-service.md (llm_wiki 服务决策)
- CONTEXT.md (术语表)

## 目标 / Goal

1. 部署 LightRAG (DeepSeek + Postgres/pgvector)
2. 部署 llm_wiki headless (:19828 API)
3. 用 docling 做统一解析层: 所有文件类型 + URL → Markdown → 双管道摄入
4. 接入层 + Pi 检索路由 (knowledge_search/query_graph/wiki_search + Capabilities)
5. 前端 Knowledge 图谱面板 + Wiki 浏览面板 + 数据输入接口 (上传/URL/进度条)

## 架构

```
数据/文档输入 (前端上传 / URL)
  → 后端 /api/kb/ingest
    → docling 统一解析 (pdf/docx/xlsx/pptx/图像/HTML/URL → Markdown)
      → 共享 input-dir (markdown)
        → LightRAG (向量 + 图谱)
        → llm_wiki (wiki 页面 + 关键词索引)
      → 返回处理进度/状态 (进度条)

Pi (AgentSession) → pi-mcp-adapter → 各知识源 MCP
  └─ capabilities 路由: wiki / keyword / vector / graph
```

## 已确认决策

- 知识系统: LightRAG (向量+图谱) + llm_wiki (wiki)
- 统一解析: docling (支持所有格式 + URL/HTML, 输出 Markdown)
- 摄入: 统一解析 → 双管道 (LightRAG + llm_wiki)
- Pi 检索: pi-mcp-adapter + Capabilities 路由 (AnyOf/AllOf)
- 前端: Knowledge 图谱 iframe + Wiki 自绘 (CALEO 风格)
- 输入接口: 文件上传 + URL + 每个来源进度条

## 技术栈

```
LightRAG  → Python, DeepSeek LLM, Postgres/pgvector, NetworkX 图谱
llm_wiki  → Rust 编译, headless (:19828)
docling   → Python, 统一解析
Pi        → pi-mcp-adapter 接 MCP
```

## 完成标准

见 frontmatter acceptance_criteria。对应 Spec G2.S1..S5 及其下 Ticket 全部 approved。
