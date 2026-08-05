---
id: g2_s5
title: "G2.S5: 数据/文档输入接口 (docling 解析 + 进度条)"
layer: S
parent: G2
owner: eng-director
status: active
milestone: M2
acceptance_criteria:
  - "前端 Knowledge 面板有'添加数据'区: 文件上传 + URL 输入"
  - "支持所有 docling 格式 (pdf/docx/xlsx/pptx/图像/HTML/URL 等)"
  - "docling 统一解析原始文件/URL → Markdown → 双管道摄入"
  - "每个来源有处理进度条 (pending/parsing/ingesting/done/failed)"
  - "后端有 /api/kb/ingest (文件) + /api/kb/ingest-url (URL)"
  - "任务状态可轮询 (进度条)"
---

# G2.S5: 数据/文档输入接口 (docling 解析 + 进度条)

## Task

实现知识库的数据/文档输入接口 —— 前端上传/URL + docling 统一解析 + 双管道摄入 + 进度条。

## 关键依赖

- G2.S3 (双管道摄入服务)
- G2.S4 (前端 Knowledge 面板)

## 架构

```
前端'添加数据'区 (文件拖拽/选择 + URL)
  → 后端 /api/kb/ingest (文件) / /api/kb/ingest-url (URL)
    → docling 统一解析 (pdf/docx/xlsx/pptx/图像/HTML/URL → Markdown)
      → 存共享 input-dir (markdown)
      → 双管道: LightRAG (S1) + llm_wiki (S2)
    → 任务状态跟踪 (pending/parsing/ingesting/done/failed)
  → 前端进度条轮询 /api/kb/task/:id
```

## 实现

### 1. docling 统一解析层 (6900XT Python)
- 安装 docling (pip install docling, Python 3.10+)
- 支持格式: PDF/DOCX/XLSX/PPTX/图像(PNG/JPEG/TIFF/BMP/WEBP)/HTML/EPUB/CSV/Markdown/LaTeX 等
- URL: docling 直接抓取网页 → Markdown
- (可选) 旧版 DOC/XLS/PPT 需 LibreOffice
- 解析结果 → Markdown → 共享 input-dir

### 2. 后端摄入接口 (server/src/routes/kb.ts)
- `POST /api/kb/ingest` (multipart 文件上传) → docling 解析 → 双管道
- `POST /api/kb/ingest-url` (URL) → docling 抓取 → 双管道
- 任务队列: 维护每个来源状态 (id, source, status, progress)
- `GET /api/kb/task/:id` (轮询进度)

### 3. 前端 (Knowledge 面板)
- '添加数据'区: 文件拖拽/选择 + URL 输入框 + 支持格式提示
- 每个来源显示进度条 (pending/parsing/ingesting/done/failed)
- 轮询后端任务状态

## 参考

- Spec: `docs/kanban/G2/Goal.md`
- 设计: `docs/knowledge-rag-design.md` (双管道方案 C)
- docling: https://github.com/docling-project/docling (支持格式)

## 如何定位参考文档

- `parent: G2` → `docs/kanban/G2/Goal.md`
- 双管道: `docs/knowledge-rag-design.md` 方案 C

## 说明

- docling 统一解析, 避免为每种格式装解析库
- 任务状态内存队列即可 (POC), 后续可持久化
- 进度条: parsing(docling) + ingesting(双管道) 两阶段
- 用 **implement** + tdd + code-review

## 依赖

- G2.S3 (双管道), G2.S4 (前端面板)

## Log
