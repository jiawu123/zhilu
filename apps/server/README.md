# Server

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`，此后 Plan、pending Patch 与 Commit 均从同一份本地状态读取。
