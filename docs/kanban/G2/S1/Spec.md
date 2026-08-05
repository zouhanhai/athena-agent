---
id: g2_s1
title: "G2.S1: LightRAG 知识服务部署"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "LightRAG 在 6900XT 安装并可启动"
  - "配置 DeepSeek 作为 LLM (embedding + 生成)"
  - "配置 Postgres + pgvector 作为向量存储"
  - "NetworkX 作为图谱存储 (POC)"
  - "能摄入文档 (Markdown) 并检索 (语义查询返回结果)"
  - "能产出知识图谱数据 (供前端 iframe 用)"
  - "服务绑定 0.0.0.0 供 Tailscale 访问"
---

# G2.S1: LightRAG 知识服务部署

## Task

在 6900XT 部署 LightRAG 知识服务 (向量 + 知识图谱)。

## 关键依赖

- Python 3.12 (6900XT 已有)
- DeepSeek API key (~/.pi/agent/auth.json 有)
- Postgres + pgvector (已装, weknora/qm 库)
- NetworkX 图谱 (默认)

## 实现

1. **安装**: pip install lightrag (LightRAG 核心, 含 Server 模式)
   - 可选: `pip install lightrag[api]` 获取带 UI 的 server
2. **配置**:
   - LLM: DeepSeek (deepseek-v4-flash 或 deepseek-chat) + embedding
   - vector_storage: pgvector (用已有 Postgres)
   - kv_storage + doc_status: Postgres
   - graph_storage: NetworkX (POC, 文件存储)
3. **启动**: LightRAG API server (lightrag-server) 监听端口, 绑定 0.0.0.0
   - 参考: `lightrag-server --host 0.0.0.0 --port <port>`
4. **验证**:
   - 摄入一篇 Markdown 文档
   - 语义查询返回结果
   - 图谱数据可导出 (LightRAG 自带 /graphs 或 graph_visual_with_html)
5. **服务绑定**: 0.0.0.0 (供 Tailscale 从员工电脑访问)

## 参考

- Spec: `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md`
- 6900XT: 需 SSH 操作 (用户名 hh)

## 如何定位参考文档

- `parent: G2` → `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md`

## 说明

- LightRAG 自带 UI (图谱可视化) 供前端 iframe 嵌入
- POC 用 NetworkX 图谱, 规模大再迁 Neo4j
- DeepSeek 同时做 embedding + 生成 (LightRAG 支持)
- 用 **implement** + tdd (验证脚本) + code-review

## 依赖

- 无 (G2 第一个 spec)

## Log
