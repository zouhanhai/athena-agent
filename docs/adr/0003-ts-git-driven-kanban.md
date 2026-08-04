# Kanban 用 TS 重写，Pi 驱动（git-driven）

不用现有 Python Kanban，门户内用 TypeScript 重新实现，由 Pi 驱动任务流转。

**背景**: 现有 Kanban 是 Python 写的（hermes-opencode-template），单机 SQLite。但 athena 需要 3 员工 + 3 Pi 跨机器协作，通过 GitHub md 状态协调。

**决策**: 完全重写为 git-driven kanban（`docs/kanban/*.md` 为真相源），TS 实现。结合 pi-task / pi-goal-list-loop-audit / pi-dynamic-workflows 让 Pi 自动拆解/审计/并行执行。

**后果**: 需重新实现 Kanban（工作量大），但换来 Pi 驱动的自动化 + 天然跨机器多用户协作。
