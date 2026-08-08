# Mem0 迁移到 pgvector 记录 (2026-08-08)

## 问题演进
1. `mem0_add` 报 "No module named 'mem0'" → 根因: Hermes TUI 用系统 `/usr/bin/python3`, 系统 python 没装 mem0ai
2. 装 mem0ai 到系统 python 后 → 报 "QdrantLocal already accessed by another instance"
3. 根因: Hermes 的 TUI gateway 进程 + agent 进程同时初始化 mem0, QdrantLocal(嵌入式) 只能单进程持有文件锁 → 冲突

## 解决方案: 迁移到 pgvector (用户偏好, 不用 qdrant)

### 1. 本机 Postgres 配置 (sudo 密码用户提供)
```
sudo apt-get install -y postgresql-16-pgvector   # 已装 0.6.0
sudo -u postgres psql -c "CREATE ROLE mem0 WITH LOGIN PASSWORD 'mem0_pg_2026'"
sudo -u postgres createdb -O mem0 mem0
sudo -u postgres psql -d mem0 -c 'CREATE EXTENSION IF NOT EXISTS vector'
```
- 认证: pg_hba.conf 127.0.0.1/32 已是 scram-sha-256, mem0 角色用密码 TCP 连接 OK
- 验证: `psql -h 127.0.0.1 -U mem0 -d mem0` (PGPASSWORD=mem0_pg_2026) ✓

### 2. 系统 python 依赖
```
pip install --user --break-system-packages mem0ai          # 2.0.17
pip install --user --break-system-packages psycopg[binary] # mem0 pgvector 需要
pip install --user --break-system-packages psycopg-pool    # mem0 pgvector 需要
```

### 3. mem0.json 改为 pgvector (~/.hermes/mem0.json)
```json
"vector_store": {
  "provider": "pgvector",
  "config": { "host": "127.0.0.1", "port": 5432, "user": "mem0",
              "password": "mem0_pg_2026", "dbname": "mem0",
              "embedding_model_dims": 768 }
}
```

### 4. 验证 (独立 python 进程, 系统 python)
- ADD ok (id fbda50b1...) ✓
- SEARCH 返回 1 结果 ✓
- mem0 pgvector 完整闭环可用

## 关键结论
- **独立进程验证通过**, 但 **当前 Hermes 进程需重启** 才能加载新的 pgvector 配置
  (Hermes 的 `initialize()` 只在 session 启动时调一次, `_backend` 缓存; 改 mem0.json 后重启才生效)
- 之前 QdrantLocal 的 `.lock`/storage.sqlite 锁由 TUI gateway 进程持有, 是残留状态, 已不再使用

## 剩余
- 重启 Hermes 后验证 mem0_add/search 工具可用
- sudo 密码用户提供, 已用于 PG 配置 (勿写入明文文件)
