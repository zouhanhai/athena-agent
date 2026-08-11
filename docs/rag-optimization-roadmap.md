# G4 RAG 优化路线图（对标主流 RAG 进阶方法）

**Status**: Draft (2026-08-11)
**来源**: 用户观看的 RAG 优化视频 + 当前 G4.S2 自建 Neo4j RAG 实现对比

## 背景

G4.S2 已完成自建 Neo4j RAG（vector + BM25 + graph + topic + bilingual alias，替代 LightRAG）。
本文件对比当前实现 vs 主流 RAG 进阶方法，评估可借鉴项并按 LLM 依赖分层。

## 当前实现能力基线

- **Chunking**: Athena 单一 paragraph-semantic chunk（~1200 tokens），带 `heading_path` + `topic` + `documentId`
- **Retrieval**: VectorRetriever (HNSW cosine) + Bm25Retriever (fulltext) → HybridRetriever（RRF 融合）
- **Graph**: Entity/Relation 节点 + bilingual aliases（T1），EntityRetriever 邻居扩展
- **Filtering**: topic 过滤（SEARCH…WHERE）
- **无 LLM** 在检索路径（S2 lean 设计：纯存储+检索）

## 方法对比与借鉴

### A. 无 LLM（可进 G4.S2 增强）

| 方法 | 当前 | 价值 | 成本 | 建议 |
|------|------|------|------|------|
| **Context Enrich**（返回相邻块）| ❌ 无 | 高 | 低 | **先做**：Chunk 有 documentId+顺序，Cypher 返回命中块 ±N 邻居 |
| **Small-to-Big**（小搜大取）| ❌ 单一 chunk | 高 | 中 | Chunk 加 parent 关联，small 检索 + big 上下文 |
| **Rerank**（cross-encoder）| 仅 RRF | 高 | 中 | 本地 reranker（如 bge-reranker）对 RRF+graph 邻居重排 |
| **Feedback Loop**（点赞/点踩）| ❌ 无 | 高 | 中 | 契合 M3 的 confidence/last_reviewed，反馈更新置信权重 |

### B. 需 LLM（进 G4.S3 agentic RAG）

| 方法 | 当前 | 价值 | 成本 | 建议 |
|------|------|------|------|------|
| **Query Transformation**（回问/扩问）| ❌ | 中 | 中 | 宽泛问题回问；LLM decompose 子查询并行检索 |
| **Compression**（提炼后输出）| ❌ | 高 | 中 | 召回后 LLM 提炼再总结，控制 token |
| **Hierarchical Index**（先搜 index）| 部分(topic) | 中 | 中 | 每 Document 生成 summary index，先定位再细检 |

## 关键决策

- **B 类方法引入 LLM 到检索/生成路径**，偏离 G4.S2 的"纯存储+检索无 LLM" lean 设计。
  → 应作为 **G4.S3（KB intelligence / agentic RAG）**，而非 S2 增强。
- **A 类方法保持无 LLM**，可作为 S2 的增强 ticket（或 S2 收尾后追加）。
- Feedback Loop 与 M3 llm_wiki frontmatter（confidence/last_reviewed）天然契合，优先做。

## 推荐推进顺序

1. **Context Enrich**（低成本，立即可用）
2. **Feedback Loop**（契合 M3，用户可感知）
3. **Rerank**（本地模型，提升检索质量）
4. **Small-to-Big**（结构性改进，需设计）
5. **G4.S3**：Query Transformation + Compression + Hierarchical Index（agentic）

## 待办

- [ ] 用户确认 A/B 分层 + 优先级
- [ ] 据此拆 G4.S2 增强 tickets 或 G4.S3 spec
