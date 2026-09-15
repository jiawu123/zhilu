# GitHub 最新开发版本与本地 UI 集成

日期：2026-09-15。仅本地提交，未 push、未部署。

## 来源与备份

- 工作分支：`codex/frontend-visual-copy`。
- UI 快照：`f8bc20f`；备份分支：`backup/ui-before-upstream-20260915`。
- 合并上游：`origin/codex/p0-core-roadmap`，`1f62c623a1ef3a512bd56aebcdf49825d9cb5a81`，`docs: add teammate frontend redeployment handoff`。
- 抓取时 `origin/main` 仍为较早的 `3633006`，因此采用最新开发分支及其前端交接说明。
- GitHub 直连超时；使用实际运行的本地代理 7897，以单次 Git 参数完成 fetch，未更改持久代理配置。

## 集成结果

保留蓝白品牌、修订后的 Logo、扁平任务卡片、同一天归组的滚动看板、连接线、底部时间轴、详情统一保存和未保存修改保护。

接入上游账号入口、账号历史、访谈草稿保存与恢复、请求进度、流式响应解析及计划调整对话。全局、任务和阶段三个入口统一使用上游 `/chat` 接口；历史时间约束预览与确认流程保留在“时间约束”入口。

关联信息通过现有 `message` 字段传递，无新增接口字段。对话仅显示范围和用户说明，内部任务编号与系统提示保留在请求中。关联信息是模型评估参考，并非服务端强制限制修改范围；实际修改仍需预览确认。

按上游变化移除执行阶段研究证据与复盘入口，计划确认阶段仍保留研究依据。新增账号、历史页面采用本地样式及正式文案。

修复合并后的日期拖动尺度冲突：根据显示日期列计算位移，仍按周调整，不再把等距日期列错误地当成固定周宽。

App、Onboarding、ResearchEvidence、研究证据测试及 styles 共五处文本冲突已人工集成。

## 变更边界

`apps/server`、`packages`、`deploy`、`Dockerfile`、`.dockerignore`、`pnpm-lock.yaml` 均与上述上游提交一致。后端、数据库、LLM API、知乎 API 的变化全部来自上游，本次未额外定制。未修改生产数据、账号配置或部署环境。

## 验证结果

- 前端 15 个测试文件、97 项测试通过。
- `pnpm -r typecheck`、`pnpm -r build` 全部通过。
- 浏览器窗口：1280×800、1280×600、768×1024、390×844。页面无横向溢出，同日列表受可用高度约束，折叠输入框不覆盖时间轴，展开对话不越过顶部导航。
- 三个变更入口请求通过；未确认不改任务，确认后刷新计划，过期方案禁用确认。
- 模拟 503：保留输入，仅发送一次，无自动重复请求。
- 账号登录门禁、登录链接、历史弹窗及 Escape 关闭通过。
- 访谈回答自动保存，刷新后恢复；切换模拟账号后不恢复其他账号的访谈。
- 实际鼠标向左拖动一周列间距：起止日期均提前七天，任务重新归入同日看板。
- Computer Use 点击验证：卡片入口、任务详情、输入框聚焦、计划菜单及账号历史入口。
- 浏览器主回归未捕获应用运行异常；结构化结果保存在 evidence JSON。

## 验证范围与复现

浏览器使用隔离样本和请求拦截，未调用真实登录、数据库、模型或知乎服务。上述结果验证前端交互和请求契约，不代表线上 OAuth、模型质量或云端部署已验收。当前 5178 预览为隔离 UI 样本。

两个 evidence JS 文件是 Playwright CLI `run-code` 函数，使用合成数据，依赖本地静态预览样本服务。复现需先启动相同样本服务并调整输出路径。所有写请求由拦截器处理，不应移除拦截器后在真实项目运行。

## 截图

- [任务流程](integration-evidence/desktop.png)
- [方案确认](integration-evidence/proposal.png)
- [移动端对话](integration-evidence/expanded-390x844.png)
- [账号历史](integration-evidence/history.png)
- [登录页面](integration-evidence/login-mobile.png)
- [恢复访谈草稿](integration-evidence/interview-restored.png)
- [拖动后的同日归组](integration-evidence/drag-regrouped.png)
