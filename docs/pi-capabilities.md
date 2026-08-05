# athena-agent — Pi Capabilities & Package Mapping

> Core: athena uses **Pi as the primary agent** (conversation / knowledge graph maintenance / RAG / Output all use Pi at the bottom layer).
> This document surveys the Pi SDK + Pi Packages ecosystem, clarifying "which features use existing packages, which need to be built from scratch," to avoid reinventing the wheel.
> References: https://pi.dev/packages · https://pi.dev/docs/latest

## 1. Pi SDK (Backend Core Engine)

**Pi is embedded via SDK** (`@earendil-works/pi-coding-agent`), which is the main body of the athena backend:
- `createAgentSession()` — one AgentSession per employee (natural isolation)
- `prompt()/steer()/followUp()` — conversation control
- `subscribe()` — streaming events (real-time frontend display)
- `setModel()/cycleModel()` — model switching (OpenRouter unified: deepseek/deepseek-v4-flash main, qwen/qwen3.7-flash vision, qwen/qwen3-embedding-8b embedding)
- `compact()` — context compression
- Image support (base64)
- `SessionManager` — session persistence
- `createCodingTools/createReadOnlyTools` — tool factories
- `runRpcMode()` / `runPrintMode()` — other integration modes

**Architecture**: Fastify is only a thin HTTP shell; all core logic lives in the Pi SDK.

## 2. Package Mapping (by athena feature)

### Conversation / Sessions
| Package                      | Capability                        | Corresponding Feature     | Status        |
|------------------------------|-----------------------------------|---------------------------|---------------|
| Pi SDK createAgentSession    | Conversation + multi-employee isolation | Personal/team conversation core | ✅ Core    |
| pi-intercom                  | Inter-Pi-session 1:1 messaging    | Team conversation / multi-Pi collaboration | ✅ Installed |
| @juicesharp/rpiv-todo        | Real-time task list panel         | Ticket progress tracking  | Recommended   |
| @narumitw/pi-plan-mode       | Read-only plan mode               | Eng Director planning     | Consider      |
| @plannotator/pi-extension    | Plan/code/PR review               | Review phase              | Consider      |

### Knowledge / Retrieval
| Package                   | Capability                  | Corresponding Feature          | Status        |
|---------------------------|-----------------------------|--------------------------------|---------------|
| pi-mcp-adapter            | MCP integration             | Connect LightRAG/llm_wiki/CodeGraph | ✅ Installed |
| pi-web-access             | Web/PDF/URL                 | Retrieval tools                | ✅ Installed  |
| pi-deepseek-search        | DeepSeek search             | Web search                     | Optional      |
| pi-agent-browser-native   | Browser automation          | Web scraping                   | Optional      |

### Memory / State
| Package              | Capability                  | Corresponding Feature | Status        |
|----------------------|-----------------------------|-----------------------|---------------|
| pi-hermes-memory     | Persistent memory + search  | Memory layer          | ✅ Installed  |
| pi-memory            | qmd semantic search         | Memory alternative    | Optional      |
| open-zk-kb           | Persistent memory           | Memory alternative    | Optional      |

### Team / Collaboration / Orchestration
| Package                              | Capability                        | Corresponding Feature     | Status        |
|--------------------------------------|-----------------------------------|---------------------------|---------------|
| pi-crew                              | AI team / workflow orchestration  | Team collaboration        | Recommended   |
| pi-subagents                         | Sub-agent delegation              | Complex task decomposition| Consider      |
| @quintinshaw/pi-dynamic-workflows    | Parallel execution                | Large-scale tasks         | ✅ Installed  |
| pi-task                              | Task decomposition pipeline       | Kanban task splitting     | ✅ Installed  |
| pi-goal-list-loop-audit              | Goal audit & acceptance           | Acceptance / Review       | ✅ Installed  |
| pi-fabric                            | Programmable tools / agent runtime| Complex workflow orchestration | Consider  |

### Development Workflow
| Package                       | Capability                        | Corresponding Feature | Status   |
|-------------------------------|-----------------------------------|-----------------------|----------|
| gentle-pi                     | SDD/OpenSpec+ review guardrails   | Standards-based dev   | Consider |
| pi-lens                       | LSP/lint real-time feedback       | Code quality          | Optional |
| pi-simplify                   | Code simplification review        | Code cleanup          | Optional |
| @plannotator/pi-extension     | Code/PR review                    | Review                | Consider |

### Other Tools
| Package                | Capability                  | Corresponding Feature | Status   |
|------------------------|-----------------------------|-----------------------|----------|
| pi-landstrip           | Sandbox Bash                | Secure execution      | Consider |
| @llblab/pi-telegram    | Telegram adapter            | Mobile conversation   | Optional |
| pi-vault-mind          | Obsidian integration        | Note vault            | Optional |

## 3. Installed vs To-Be-Evaluated

### Installed (10)
pi-mcp-adapter, pi-intercom, @mjasnikovs/pi-task, pi-goal-list-loop-audit,
@quintinshaw/pi-dynamic-workflows, @juicesharp/rpiv-ask-user-question,
pi-hermes-memory, pi-web-access, pi-crew, @juicesharp/rpiv-todo

### Recommended (Core Collaboration)
None (core collaboration packages are already fully installed)

### Consider (evaluate on demand, avoid duplication)
- Planning/Review: @narumitw/pi-plan-mode, @plannotator/pi-extension, gentle-pi (evaluate and pick one)
- Advanced orchestration: pi-fabric (overlaps with pi-crew/pi-task, needs evaluation)
- Sub-agents: pi-subagents (overlaps with pi-dynamic-workflows)
- Sandbox: pi-landstrip (evaluate when needed)

## 4. athena Feature → Implementation Approach (Key Conclusions)

| athena Feature           | Existing or Custom | Approach                             |
|--------------------------|--------------------|--------------------------------------|
| Personal/team conversation | ✅ Existing      | Pi SDK + pi-intercom core            |
| Knowledge base integration | ✅ Existing      | pi-mcp-adapter, connect LightRAG/llm_wiki |
| Memory                   | ✅ Existing       | pi-hermes-memory, reuse Hermes port  |
| Task decomposition/audit | ✅ Existing       | pi-task + glla, reuse                |
| Parallel execution       | ✅ Existing       | pi-dynamic-workflows, reuse          |
| Code review / Review     | ⚠️ Evaluate       | plannotator/gentle-pi, or custom git-driven review |
| Kanban collaboration     | 🛠️ Custom        | git-driven kanban (our design)       |
| Frontend portal          | 🛠️ Custom        | Vue3 + TDesign                       |
| Output generation        | ⚠️ Evaluate + Custom | Pi + ppt-master etc.              |

**Conclusion**: The Pi ecosystem already covers most "agent capabilities" (conversation / memory / collaboration / tasks). What needs to be built from scratch is mainly:
1. **Portal frontend** (Vue, presentation layer)
2. **git-driven Kanban** (collaboration mechanism, our core design)
3. **Fastify HTTP shell** (thin layer, forwarding to Pi SDK)
4. **Knowledge base orchestration** (connecting LightRAG/llm_wiki + Capabilities routing)
