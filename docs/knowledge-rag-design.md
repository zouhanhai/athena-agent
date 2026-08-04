# athena-agent — 知识库与 RAG 路由设计

> 核心：llm_wiki + LightRAG 双系统，通过 Capabilities 声明 + Pi(ReAct) 确定性路由，实现 Agentic RAG。
> 参考 WeKnora 的 Capabilities 机制（详见下文分析）。
> 本文档是后续实现知识库、检索、Pi 查询路由时的唯一参考。

## 一、总体架构

```
知识源（两个独立系统，共享原始文件目录）:
  llm_wiki  → capabilities: ["wiki", "keyword"]
  LightRAG  → capabilities: ["vector", "graph"]

Pi (AgentSession) → pi-mcp-adapter → 各知识源 MCP
  └─ 按 user 意图 + 工具描述 + 能力声明，决定查询策略
```

## 二、文件摄入（方案 C：共享原始文件，双管道处理）

```
上传一份文档到共享 input-dir:
  ├─ llm_wiki: 读文件 → 生成 wiki 页面 (md) + 关键词索引
  └─ LightRAG: 读同一份文件 → chunk → 向量库(pgvector) + 知识图谱(NetworkX)

原始文件只存一份，各自处理产物独立。
```

## 三、Capabilities 模式（核心路由机制，参考 WeKnora）

### 1. 每个知识源声明自己的能力面

```
llm_wiki  → ["wiki", "keyword"]   (有 wiki 页面 + 关键词/BM25 索引)
LightRAG  → ["vector", "graph"]   (有向量索引 + 知识图谱)
```

**能力是"知识源级别"的确定性声明**（不是探测）。Pi 看到就知道能干什么。

### 2. 每个 Pi 工具声明自己需要什么能力（ToolRequirement）

```typescript
// 在 athena 后端注册 Pi 的工具
const tools = [
  // RAG 类工具: 需要 vector 或 keyword
  { name: 'knowledge_search',  requireCapability: { anyOf: ['vector', 'keyword'] } },
  { name: 'query_graph',       requireCapability: { anyOf: ['vector', 'graph'] } },
  // Wiki 类工具: 必须都有 wiki
  { name: 'wiki_search',       requireCapability: { allOf: ['wiki'] } },
  { name: 'wiki_read_page',    requireCapability: { allOf: ['wiki'] } },
]
```

**两个操作符**：
- **AnyOf**：满足任意一个即可（如 vector OR keyword）
- **AllOf**：必须全部满足（如 wiki 工具要 wiki 能力）

### 3. Pi 的路由逻辑（Agentic RAG）

```
user 查询 → Pi (ReAct agent):
  1. 看每个知识源的能力声明 + 工具描述
  2. 判断 user 意图:
     ├─ "流程文档怎么说"        → wiki_search (llm_wiki)
     ├─ "哪些实体和 X 相关"     → query_graph (LightRAG)
     ├─ "关于 Y 的资料"         → knowledge_search (LightRAG)
     ├─ "对比 A 和 B 实现"      → 多个都查（wiki + RAG）
     └─ 简单问题/闲聊           → 不查，直接答
  3. 收集结果 → 总结 → 回答
```

**决策因素**（Pi 综合考量）：
| 因素 | 影响 |
|------|------|
| user 问题意图 | 决定查哪个（wiki vs vector vs graph）|
| 工具描述 | 帮 Pi 判断何时用哪个工具 |
| 知识源能力声明 | 确定性：哪个工具可用 |
| 成本/效率 | 简单问题只查一个，复杂问题多查 |

## 四、意图 → 查询策略映射

| user 意图 | 查询策略 | 知识源 |
|-----------|---------|--------|
| 流程/规范/概念定义 | wiki_search | llm_wiki |
| 具体事实/模糊语义/资料 | knowledge_search | LightRAG |
| 实体关系/依赖 | query_graph | LightRAG |
| 综合对比/复杂推理 | 多源混合 | 都查 |
| 简单/闲聊 | 不检索 | - |

## 五、工具描述（帮 Pi 判断）

```
wiki_search: "查项目沉淀的 wiki 页面（适合：流程、规范、概念定义）"
knowledge_search: "语义检索原始文档块（适合：具体事实、模糊语义、资料查找）"
query_graph: "查实体关系图谱（适合：谁和谁相关、依赖关系）"
```

## 六、对比 WeKnora 的差异

| 维度 | WeKnora | 我们的方案 |
|------|---------|-----------|
| 能力面分布 | 一个 KB 多能力面 | 两个系统各一能力面 |
| 路由依据 | 看 KB.Capabilities() | 看知识源 capabilities 声明 |
| 工具 | 内置 agent 调多个 | Pi 调多个 MCP 工具 |
| wiki 存储 | DB 行 (Postgres) | md 文件 (llm_wiki, Karpathy 模式) |
| 图谱 | 内置 | LightRAG NetworkX |

**殊途同归**：共享原始文件 + 分层处理产物 + 能力声明路由。

## 七、落地要点

1. 上传文档 → 共享 input-dir → 双管道处理
2. Pi 通过 pi-mcp-adapter 接 llm_wiki + LightRAG 的 MCP
3. 每个工具注册能力要求（AnyOf/AllOf）
4. Pi 按意图 + 能力 + 成本做确定性路由
5. 简单问题先走单一知识源，复杂问题才多源

## 八、后续待验证

- llm_wiki 的 MCP 是否暴露检索工具（wiki_search 等价物）
- LightRAG 的 MCP/API 检索能力确认
- Pi 的 ReAct 路由在实际查询中的表现
