---
id: g2_s4
title: "G2.S4: 前端知识面板"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "Knowledge 面板显示 LightRAG 知识图谱 (iframe 嵌入自带 UI 或自绘)"
  - "Wiki 面板显示 llm_wiki 页面 (Vue 自绘, CALEO 风格)"
  - "知识检索框 (调后端知识接口)"
  - "图谱和 wiki 数据来自后端 kb/ 服务层"
  - "与现有侧边栏/CALEO 主题协调"
---

# G2.S4: 前端知识面板

## Task

实现门户前端的 Knowledge (图谱) 和 Wiki 面板。

## 关键依赖

- G2.S3 (知识接入层, 后端 kb/ 服务 + 检索 API)
- G2.S1/S2 (LightRAG 图谱 + llm_wiki 数据)

## 实现

### 1. Knowledge 图谱面板 (/knowledge)
- LightRAG 知识图谱可视化:
  - 首选: iframe 嵌入 LightRAG 自带图谱 UI (G2.S1 部署的 server)
  - 或: 后端 /api/kb/graph 返回图谱数据 → Vue 自绘 (CALEO 风格)
- 显示实体关系图

### 2. Wiki 面板 (/wiki)
- llm_wiki 页面浏览:
  - 后端 /api/kb/wiki 读 llm_wiki API → markdown
  - Vue 自绘 (CALEO 风格, 参考 G1.S2 布局)
- 页面列表 + 内容渲染 (markdown)

### 3. 知识检索
- 检索框: 输入 → 后端知识检索 API → 显示结果
- 调 G2.S3 的知识接口

## 参考

- Spec: `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md`
- 现有前端: `web/src/views/KnowledgeView.vue`, `WikiView.vue` (G1.S2 占位)
- 布局: G1.S2 (CALEO 主题 + 侧边栏)

## 如何定位参考文档

- `parent: G2` → `docs/kanban/G2/Goal.md`
- 现有视图: `web/src/views/`

## 说明

- 复用 G1.S2 的 API 层 + store 分层 (web/src/api/, stores/)
- 图谱优先 iframe (简单), 后续可自绘
- CALEO 风格: 橙#ff6633 + 深蓝#2d3142 + 天空蓝#69b3e7
- 用 **implement** + tdd + code-review

## 依赖

- G2.S3

## Log
