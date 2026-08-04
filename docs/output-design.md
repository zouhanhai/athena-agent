# athena-agent — Output 页面设计（NotebookLM 式内容合成）

> 状态：**已规划，待核心功能（对话/Kanban/知识库）跑通后实施**
> 目标：从知识库文件 + Web 来源，生成 txt / blog / 图表 / pptx / html 展示文件。
> 类似 NotebookLM 的"生成笔记本/报告/演示文稿"能力。

## 一、功能定位

用户在前端 Output 页面：
1. 选择知识库文件（llm_wiki 检索到的 wiki 页面 / 文档）
2. 添加 Web 来源（URL，可选）
3. 选择输出格式：txt / blog / 图表 / pptx / html
4. 生成 → Pi 检索 + 合成 → 调工具 → 文件预览/下载

## 二、生成工具矩阵

| 输出格式 | 生成方式 | 工具 | 状态 |
|---------|---------|------|------|
| txt | Pi 直接生成纯文本 | Pi 能力 | ✅ 可用 |
| blog | Pi 生成 markdown/HTML 博客 | Pi 能力 | ✅ 可用 |
| 图表 | AI 数据可视化 | microsoft/data-formulator (16k) | ⚠️ 需验证 |
| pptx | 原生 PPTX（形状/动画/图表）| ppt-master（已装 v4.3.0）| ⚠️ 需验证 Pi 运行 |
| html | 高保真 HTML 展示 | huashu-design (22k) | ⚠️ 需验证 |

## 三、架构：Pi 作为输出调度器

```
Output 页面:
  用户选: 知识库文件 + Web URL + 输出格式
    ↓
  门户后端 → Pi (AgentSession):
    ├─ 检索知识库 (llm_wiki/LightRAG)
    ├─ 拉取 Web URL
    ├─ 合成内容
    └─ 按格式调用生成工具:
        ├─ txt/blog → Pi 直接写
        ├─ 图表     → data-formulator
        ├─ pptx     → ppt-master
        └─ html     → huashu-design
    ↓
  生成文件 → 前端预览/下载
```

## 四、候选工具调研

| Repo | Stars | 类型 | 说明 |
|------|-------|------|------|
| hugohe3/ppt-master | 43k | Claude Code skill | 原生 PPTX（形状/动画/图表/模板/旁白），最强 |
| alchaincyf/huashu-design | 22.2k | HTML skill | 高保真原型/幻灯片/动画 + MP4 导出 |
| Anionex/banana-slides | 15.4k | 完整应用 | "Vibe PPT"，一句话生成，可编辑 pptx |
| addsumtech/slides_maker | 324 | Codex/Claude skill | 论文/代码→PPTX，原生图表/方程 |
| microsoft/data-formulator | 16k | Python 系统 | AI 交互式数据可视化 |

**关键事实**：
- 本地已装 **ppt-master v4.3.0**（含完整 workflows，就是 hugohe3/ppt-master）
- huashu-design 是 HTML 原生，匹配"html 展示文件"需求
- data-formulator 是微软 AI 可视化系统

## 五、实施策略（分层）

### POC 阶段（核心跑通后先做）
- txt / blog：Pi 直接生成（能力最成熟）
- 图表：Pi 生成数据 + 基础图表库（ECharts / matplotlib）
- html：Pi 生成 HTML 模板（CALEO 风格）
- pptx：Pi + python-pptx 基础生成

### 增强阶段（验证 skill 可行性后）
- 图表 → 接入 data-formulator（如能 API 化）
- pptx → 接入 ppt-master
- html → 接入 huashu-design

## 六、关键待验证

- ppt-master / huashu-design 是 Claude Code/Codex skill，**能否在 Pi 中运行**需验证
- data-formulator 能否作为无头 API 被 Pi 调用
- Pi 的 ReAct 能否可靠调度多格式生成

## 七、里程碑

- **核心功能**（M1-M4）：对话 / Kanban / 知识库
- **Output 页面**：核心跑通后实施（M5）
  - 先做 txt / blog / 图表（Pi 能力）
  - 后做 pptx / html 增强（接入 skill）

## 八、落地要点

1. Output 页面在 Vue 前端侧边栏新增入口
2. 门户后端加 /output 路由，调度 Pi + 工具
3. Pi 用 pi-mcp-adapter 接知识库检索
4. 生成文件存 6900XT，前端预览 + 下载
5. 复用的 skill：ppt-master（已装）、huashu-design、data-formulator
