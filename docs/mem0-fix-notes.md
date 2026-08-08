# Mem0 修复记录 (2026-08-08)

## 问题
`mem0_add` / `mem0_search` 报: "Mem0 backend not initialized: No module named 'mem0'"

## 根因
- Hermes TUI 进程 (`~/.local/bin/hermes` → `/usr/bin/python3`) 用**系统 python** 启动
- 系统 python `/usr/bin/python3` **没有装 mem0ai**（只有 `~/.hermes/hermes-agent/venv` 里有 2.0.10）
- 两天前的端到端测试是**手动用 venv python** 跑的，Hermes 进程本身从没真正用过 mem0

## 修复
已把 mem0ai 2.0.17 装到系统 python（user site）:
```
/usr/bin/python3 -m pip install --user --break-system-packages mem0ai
```
- 系统 python 现在能 `import mem0` (2.0.17) ✓

## 生效条件
**重启 Hermes 进程**（当前 PID 565 是装 mem0 前启动的，缓存了 import 失败）。
重启后 `mem0_add`/`mem0_search` 应可用。

## mem0.json (OSS 本地, ~/.hermes/mem0.json)
- mode: oss, user_id: hermes-user
- llm: openrouter deepseek/deepseek-v4-flash
- embedder: openrouter qwen/qwen3-embedding-8b, embedding_dims 768
- vector_store: qdrant QdrantLocal (path ~/.hermes/mem0_qdrant, collection mem0, embedding_model_dims 768)

## 待办
- Hermes 重启后验证 mem0_add/search 可用
- 若仍失败, 看 plugins/memory/mem0/_backend.py OSSBackend 初始化 (它会自动重建维度不符的集合)
