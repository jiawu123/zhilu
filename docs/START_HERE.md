# 使用方法

将本目录保存在现有 zhilu 工作区中的一个单独文档目录，例如 `docs/codex-m2-p0-integration/`，不要把它当成源码补丁覆盖项目。目录中没有 .git、密钥或生产代码。

把下面的文字发给 Codex：

```text
请读取 docs/codex-m2-p0-integration/CODEX_M2_P0_INTEGRATION.md，并把它作为本次实施任务。先读取适用的 AGENTS.md，核对当前分支、已有修改、实际 Python 包路径以及 Jia 的 Contracts 和 adapter，再按文档逐阶段实施和测试。

这次必须完成我负责的 M2 单请求研究执行、Server Python Provider、独立真实证据接口和交接文档。不要停留在重新写计划，也不要重复实现已有证据 adapter、改写 ranker 或用 Mock 路线冒充 live。正式 Roadmapper／前端不默认扩入本次范围；已经存在的真实编排优先兼容。

保留未提交修改和现有 Mock 流程，不自动合并分支、不 commit、不 push、不应用正式 Baseline。既有凭据可用于文档规定范围内的真实 smoke；密钥缺失时继续离线工作并明确记录阻塞，不索要我把密钥粘贴到聊天。平台权限按正常流程处理。

请直接开始，最终用中文报告文件改动、实际测试命令和结果、真实调用次数、未验证范围，以及我下一条可以执行的命令。
```
