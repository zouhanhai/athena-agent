---
id: g2_s2
title: "G2.S2: llm_wiki 服务部署"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "llm_wiki (nashsu/llm_wiki) 在 6900XT headless 运行"
  - "提供 HTTP API (127.0.0.1:19828)"
  - "能读共享 input-dir 的 Markdown 生成 wiki 页面"
  - "有混合检索 (keyword + vector) 能力"
  - "服务绑定 0.0.0.0 供 Tailscale 访问"
  - "Rust/Cargo 已装并成功编译"
---

# G2.S2: llm_wiki 服务部署

## Task

在 6900XT 部署 llm_wiki 服务 (Karpathy 模式 wiki 知识库)。

## 关键依赖

- Rust/Cargo (需装, 6900XT 暂无)
- Xvfb (headless 显示, 6900XT 已有)
- DeepSeek API (wiki 页面生成用)

## 实现

1. **装 Rust**: rustup 装 stable (Rust/Cargo)
2. **克隆编译**: nashsu/llm_wiki (Tauri 应用)
   - 编译 Rust backend (含 tiny_http :19828 + MCP server)
3. **headless 运行**: 用 Xvfb (xvfb-run) 启动, 提供 :19828 API
   - 即使无 GUI, 后台跑 Rust backend 提供 HTTP API
4. **配置**:
   - 数据目录 (wiki md 文件 + 索引)
   - 读共享 input-dir 的 Markdown 生成 wiki 页面
   - DeepSeek LLM 配置
5. **验证**:
   - :19828 API 可访问 (健康检查)
   - 摄入 Markdown → 生成 wiki 页面
   - 关键词检索 (wiki_search 等价物) 可用
   - MCP server 是否暴露检索工具 (确认)
6. **服务绑定**: 0.0.0.0 (供 Tailscale)

## 参考

- Spec: `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md`
- ADR: `docs/adr/0004-llm-wiki-service.md`
- 6900XT: 需 SSH 操作

## 如何定位参考文档

- `parent: G2` → `docs/kanban/G2/Goal.md`
- ADR-0004: `docs/adr/0004-llm-wiki-service.md`

## 说明

- llm_wiki 是 Tauri 桌面应用, 前端不能 Web iframe → 后端调 API, 前端自绘
- 核心价值: 混合检索 (keyword+vector+graph) + 增量生成互联 wiki
- **风险**: headless 运行 + Rust 编译是主要验证点
- 用 **implement** + tdd (验证脚本) + code-review

## 依赖

- 无 (可与 G2.S1 并行)

## Log
