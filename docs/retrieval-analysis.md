# G4 Retrieval 深入分析（2026-08-11）

## 当前 Retrieval 实现（Neo4jRetrievalService.search）

```
query
  → Promise.allSettled:
      · VectorRetriever (Chunk.embedding HNSW)   → Chunk hits
      · Bm25Retriever (Chunk.text fulltext)      → Chunk hits
      · Text2CypherRetriever (Entity name+aliases → 图邻居) → Entity hits
  → rrfFuse([vector, bm25], topK)   ← 只融合 vector + bm25 (都是 Chunk)
  → hits = [...fused, ...graphHits]  ← graph (Entity) 直接 append
  → 返回
```

## 关键问题

### 1. Graph 检索返回 Entity，不是 Chunk —— 无法 RRF 融合

- `Text2CypherRetriever` 返回 **Entity**（`{id: 实体名, text: 描述, related: []}`），source="graph"
- vector/bm25 返回 **Chunk**（`{id: "doc:c1", text, ...}`），source="vector"/"bm25"
- 两者是**不同实体类型**，`rrfFuse` 按 id 去重但 Entity id ≠ Chunk id → **不重叠**，
  所以 graph 结果只能 append 到尾部，**无法参与统一融合排序**

### 2. Graph 检索没引导到实际 chunk（答案来源）

- 用户搜到相关实体，但**看不到"该实体在哪些 chunk 里出现"**
- Entity 与 Chunk **无关系**（entity 只连 entity，chunk 连 document）
- 浪费图检索价值（图能发现 vector/bm25 找不到的关联，但没落到 chunk）

### 3. 无 rerank / context enrich / compression

- 仅 RRF（无学习统计融合），无 cross-encoder 重排
- 无 context enrich（不返回同 section / 相邻 chunk）
- 无 compression（不提炼）

## 优化方向

### A. 建 Entity → Chunk 关系（核心，让图检索落到 chunk）

- ingest 时：Athena relation/entity → 关联到提到它的 chunk（`Entity -[:MENTIONED_IN]-> Chunk`）
- 或通过 Document 间接：Entity → Document → Chunk
- 效果：graph 检索返回**包含实体的 chunk** → 与 vector/bm25 统一 RRF 融合

### B. Graph 参与 RRF 融合

- 一旦 graph 返回 chunk，`rrrFuse([vector, bm25, graph])` 三源统一排序
- 图发现的强相关不垫底

### C. Context Enrich（T11 已含）

- 命中 chunk → 返回同 section 邻居

### D. Rerank（A 类）

- 本地 cross-encoder 对 RRF 结果重排

### E. B 类（G4.S3，需 LLM）

- Query Transformation / Compression / Agentic picker / Multi-hop 图推理

## 建议优先级

1. **Entity→Chunk 关联 + graph 参与 RRF**（核心，让图检索真正落地到 chunk）
2. Context Enrich（T11 已规划）
3. Rerank
4. G4.S3 agentic（query transform / compression）
