# Wiki 用 llm_wiki 服务 + 前端自绘

Wiki 面板用 nashsu/llm_wiki 作为服务（:19828 HTTP API + MCP），门户后端调其 API 拿 wiki 数据，前端用 Vue 自绘（CALEO 风格）。

**背景**: 需要"Wiki 沉淀"能力（Karpathy 模式：LLM 增量生成互联 markdown wiki）。候选有 nashsu/llm_wiki 桌面应用、nvk/llm-wiki CLI、WeKnora 内置 agent。

**决策**: 用 nashsu/llm_wiki。它虽是 Tauri 桌面应用，但有独立 HTTP API（tiny_http，:19828）+ MCP server，数据能力完整（混合检索 keyword+vector+graph）。其前端是桌面不能 Web iframe，故前端自绘。

**后果**: 需验证 llm_wiki 能 headless 跑（6900XT 有 Xvfb 虚拟显示）；需装 Rust 编译；前端要自绘 Wiki 浏览 UI（CALEO 风格）。
