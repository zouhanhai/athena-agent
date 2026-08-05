---
id: g2_s3
title: "G2.S3: 知识接入层 + Pi 检索路由"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "athena 后端有 kb/ 服务层封装 (LightRAG + llm_wiki 客户端)"
  - "双管道摄入服务: 接收 Markdown → 投给 LightRAG + llm_wiki"
  - "pi-mcp-adapter 接两个知识源的 MCP"
  - "Pi 注册知识工具 (knowledge_search/query_graph/wiki_search/wiki_read_page)"
  - "Capabilities 路由 (AnyOf/AllOf) 生效"
  - "Pi 能通过 MCP 检索两个系统 (Agentic RAG)"
---

# G2.S3: 知识接入层 + Pi 检索路由

## Task

建立知识接入层 (athena 后端封装两个知识源) + Pi 通过 MCP 检索的路由机制。

## 关键依赖

- G2.S1 (LightRAG 服务) + G2.S2 (llm_wiki 服务) 已部署

## 实现

### 1. 后端知识服务层 (server/src/kb/)
- `kb/lightrag.ts`: LightRAG API 客户端 (摄入 + 检索 + 图谱)
- `kb/llmwiki.ts`: llm_wiki API 客户端 (摄入 + 关键词检索 + 读页面)
- `kb/ingest.ts`: 双管道摄入服务 (Markdown → LightRAG + llm_wiki)

### 2. Capabilities 声明 (knowledge-rag-design.md)
- LightRAG → ["vector", "graph"]
- llm_wiki → ["wiki", "keyword"]

### 3. Pi 工具注册 + 路由
- 用 pi-mcp-adapter 接两个知识源 MCP
- 注册工具 (knowledge_search/query_graph/wiki_search/wiki_read_page) + Capability 要求
- Pi (ReAct) 按意图 + 能力声明 + 成本做确定性路由

### 4. 验证
- 双管道摄入一篇文档 → 两个系统都有
- Pi 通过 MCP 检索 LightRAG + llm_wiki
- 意图路由正确 (流程问 wiki, 事实问 RAG, 关系问图谱)

## 参考

- Spec: `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md` (唯一参考, Capabilities 模式)
- 现有: `server/src/agents/agent.ts` (Pi 封装)

## 如何定位参考文档

- `parent: G2` → `docs/kanban/G2/Goal.md`
- Capabilities 路由: `docs/knowledge-rag-design.md`

## 说明

- Pi 工具注册用 @earendil-works/pi-coding-agent (AgentSession)
- 检索路由遵循 knowledge-rag-design.md 的意图→策略映射
- 用 **implement** + tdd + code-review

## 依赖

- G2.S1, G2.S2

## Log
