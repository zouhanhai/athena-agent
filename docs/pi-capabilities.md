# athena-agent — Pi 能力与 Package 映射

> 核心：athena 以 **Pi 为主体**（对话/知识图谱维护/RAG/Output 都用 Pi 底层）。
> 本文档调研 Pi SDK + Pi Packages 生态，明确"哪些功能用现成 package，哪些要自建"，避免重复造轮子。
> 参考: https://pi.dev/packages · https://pi.dev/docs/latest

## 一、Pi SDK（backend 核心引擎）

**Pi 通过 SDK 内嵌**（`@earendil-works/pi-coding-agent`），这是 athena backend 的主体：
- `createAgentSession()` — 每员工一个 AgentSession（天然隔离）
- `prompt()/steer()/followUp()` — 对话控制
- `subscribe()` — 流式事件（前端实时显示）
- `setModel()/cycleModel()` — 模型切换（DeepSeek/Qwythos）
- `compact()` — 上下文压缩
- 支持图片（base64）
- `SessionManager` — 会话持久化
- `createCodingTools/createReadOnlyTools` — 工具工厂
- `runRpcMode()` / `runPrintMode()` — 其他接入方式

**架构**: Fastify 只是 HTTP 薄壳，核心逻辑全在 Pi SDK。

## 二、Package 映射（按 athena 功能）

### 对话 / 会话
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| Pi SDK createAgentSession | 对话+多员工隔离 | 个人/团队对话主体 | ✅ 核心 |
| pi-intercom | Pi 会话间 1:1 消息 | 团队对话/多 Pi 协作 | ✅ 已装 |
| @juicesharp/rpiv-todo | 实时任务清单面板 | Ticket 进度追踪 | 建议装 |
| @narumitw/pi-plan-mode | 只读 plan 模式 | Eng Director 规划 | 考虑 |
| @plannotator/pi-extension | 计划/代码/PR 审查 | Review 阶段 | 考虑 |

### 知识 / 检索
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| pi-mcp-adapter | MCP 接入 | 接 LightRAG/llm_wiki/CodeGraph | ✅ 已装 |
| pi-web-access | 网络/PDF/URL | 检索工具 | ✅ 已装 |
| pi-deepseek-search | DeepSeek 搜索 | 网络搜索 | 可选 |
| pi-agent-browser-native | 浏览器自动化 | 网页抓取 | 可选 |

### 记忆 / 状态
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| pi-hermes-memory | 持久记忆+搜索 | 记忆层 | ✅ 已装 |
| pi-memory | qmd 语义搜索 | 记忆备选 | 可选 |
| open-zk-kb | 持久记忆 | 记忆备选 | 可选 |

### 团队 / 协作 / 编排
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| pi-crew | AI 团队/工作流编排 | 团队协作 | 建议装 |
| pi-subagents | 子 agent 委派 | 复杂任务分解 | 考虑 |
| @quintinshaw/pi-dynamic-workflows | 并行执行 | 大规模任务 | ✅ 已装 |
| pi-task | 任务拆解管线 | Kanban 任务拆 | ✅ 已装 |
| pi-goal-list-loop-audit | 目标审计验收 | 验收/Review | ✅ 已装 |
| pi-fabric | 可编程工具/agent 运行时 | 复杂工作流编排 | 考虑 |

### 开发流程
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| gentle-pi | SDD/OpenSpec+审查护栏 | 规范开发 | 考虑 |
| pi-lens | LSP/lint 实时反馈 | 代码质量 | 可选 |
| pi-simplify | 代码简化审查 | 代码清理 | 可选 |
| @plannotator/pi-extension | 代码/PR 审查 | Review | 考虑 |

### 其他工具
| Package | 能力 | 对应功能 | 状态 |
|---------|------|---------|------|
| pi-landstrip | 沙箱 Bash | 安全执行 | 考虑 |
| @llblab/pi-telegram | Telegram 适配 | 移动端对话 | 可选 |
| pi-vault-mind | Obsidian 集成 | 笔记库 | 可选 |

## 三、已装 vs 待评估

### 已装（10 个）
pi-mcp-adapter, pi-intercom, @mjasnikovs/pi-task, pi-goal-list-loop-audit,
@quintinshaw/pi-dynamic-workflows, @juicesharp/rpiv-ask-user-question,
pi-hermes-memory, pi-web-access, pi-crew, @juicesharp/rpiv-todo

### 建议装（核心协作）
无（核心协作已装齐）

### 考虑（按需评估，避免重复）
- 计划/审查: @narumitw/pi-plan-mode, @plannotator/pi-extension, gentle-pi（三选一评估）
- 编排进阶: pi-fabric（与 pi-crew/pi-task 有重叠，需评估）
- 子 agent: pi-subagents（与 pi-dynamic-workflows 有重叠）
- 沙箱: pi-landstrip（需要时再看）

## 四、athena 功能 → 实现方式（关键结论）

| athena 功能 | 用现成还是自建 | 方案 |
|------------|--------------|------|
| 个人/团队对话 | ✅ Pi SDK + pi-intercom | createAgentSession 主体 |
| 知识库接入 | ✅ pi-mcp-adapter | 接 LightRAG/llm_wiki |
| 记忆 | ✅ pi-hermes-memory | 复用 Hermes 移植 |
| 任务拆解/验收 | ✅ pi-task + glla | 复用 |
| 并行执行 | ✅ pi-dynamic-workflows | 复用 |
| 代码审查 Review | ⚠️ 评估 plannotator/gentle-pi | 或自建 git-driven review |
| Kanban 协作 | 🛠️ 自建 | git-driven kanban（我们的设计）|
| 前端门户 | 🛠️ 自建 | Vue3 + TDesign |
| Output 生成 | ⚠️ 评估 + 自建 | Pi + ppt-master 等 |

**结论**：Pi 生态已覆盖大部分"agent 能力"（对话/记忆/协作/任务），自建的主要是：
1. **门户前端**（Vue，展示层）
2. **git-driven Kanban**（协作机制，我们的核心设计）
3. **Fastify HTTP 壳**（薄层，转调 Pi SDK）
4. **知识库编排**（接 LightRAG/llm_wiki + Capabilities 路由）
