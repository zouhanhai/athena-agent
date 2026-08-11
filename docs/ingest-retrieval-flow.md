# G4 Ingest + Retrieval 流程梳理与 RAG 优化插入点

**Status**: Design blueprint (2026-08-11)
**前提**: G4.S1 (Athena refinement) + G4.S2 (Neo4j RAG) 已完成

## 当前 Ingest 流程

```
上传文档
  → docling parsing (docling.ts)
  → Athena refinement (refine-document.ts)   ← 唯一 LLM pass
       · re-level headers + type/topic + chunks + entities/relations/keywords + quality
       · 大输出落盘 (pi-docparser pattern, md_ref)
  → ingesting_neo4j (store/ingest.ts)   ← embed + index Chunk/Entity/Relation/Document
  → ingesting_llmwiki (llmwiki.ts)
  → ingesting_lightrag (已移除, T7)
```

## 当前 Retrieval 流程

```
query → HybridRetriever
  · VectorRetriever (Chunk.embedding HNSW cosine)
  · Bm25Retriever (Chunk.text fulltext)
  · EntityRetriever (Entity name+aliases fulltext → 邻居扩展)
  → RRF 融合 (reciprocal rank fusion)
  → + llmwiki BM25 (KnowledgeRetrievalService.search)
  → 返回 (无 LLM, 无 rerank, 无 compression)
```

## 优化插入点

### A 类（无 LLM，保持 S2 lean — G4.S2 retrieval 增强）

| 方法 | 插入点 | 实现 |
|------|--------|------|
| Context Enrich | Retrieval 返回前 | Chunk 有 documentId+顺序 → Cypher 返回命中块 ±N 邻居 |
| Rerank | RRF 融合后 | 本地 cross-encoder 对 RRF+graph 邻居重排 |
| Feedback Loop | Ingest 存储 + Retrieval 排序 | confidence 字段,用户反馈更新 → 排名权重 (契合 M3) |
| Chunk Header | ✅ 已有 | 加强为 section title 展示 |

### B 类（需 LLM — G4.S3 agentic RAG）

| 方法 | 插入点 | 实现 |
|------|--------|------|
| Small-to-Big | Ingest chunking + Retrieval | Athena 输出 small chunk+大块 parent;命中 small→取 big |
| Query Transformation | Retrieval 前 | LLM 回问宽泛问题 / decompose 子查询 |
| Compression | Retrieval 后输出前 | LLM 提炼召回结果 |
| Hierarchical Index | Ingest + Retrieval 前 | 每 Document summary index,先定位再细检 |

## 核心洞察：Retrieval 是最大优化空间

当前 `HybridRetriever → RRF → 返回` 太直,缺 rerank/enrich/compression。
**Context Enrich + Rerank + Compression 都落在 Retrieval 同一位置(RRF 之后)**,
应重构为**分阶段 retrieval pipeline** 而非零散加功能:

```
query
  → [Query Transform (S3)]      宽泛回问/分解
  → HybridRetriever (vector+bm25+graph)   ← 现有
  → RRF 融合
  → [Rerank (A)]                cross-encoder 重排
  → [Context Enrich (A)]        + 相邻块
  → [Compression (S3)]          LLM 提炼
  → 返回
```

## 推荐推进

1. **G4.S2 retrieval 增强**（A 类,无 LLM）: Context Enrich + Rerank + Feedback → 一次重构 retrieval pipeline
2. **G4.S3 agentic RAG**（B 类,需 LLM）: Query Transform + Compression + Hierarchical Index + Small-to-Big

## 待办
- [ ] 确认 A 类作为 G4.S2 retrieval 增强重构
- [ ] 确认 B 类进 G4.S3
