# Server

本地 API、Plan Bundle 文件存储和 P0 模块组装入口。

开发时监听 `http://127.0.0.1:8787`。第一次读取 `agent-engineer-demo` 时会从 `examples/` 初始化本地 `data/`；`POST /api/projects` 可根据用户确认的访谈输出创建新项目。Plan、Goal Contract、User Context、pending Patch、Baseline Proposal 与 Commit 均从同一份本地状态读取。Mock Research 只产生待确认提案，`POST /baseline/apply` 才写入正式 Plan。
