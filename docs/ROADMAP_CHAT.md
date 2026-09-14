# Roadmap 对话与直接编辑

Plan Bundle 是计划的数据文件：目标、任务、日期、状态、关系和来源；Roadmapper 是生成或调整这些数据的逻辑，Roadmap 是这些数据的可操作视图。

## 当前交互

- 地图底部悬浮的“和知路聊聊”支持多轮提问、执行反馈和计划调整，发送 Enter，换行 Shift+Enter。展开只增加面板高度，地图保持完整画布；模型进度仅在对话内显示。
- 名称、日期和状态等细微调整，继续在图上直接编辑，服务端立即保存计划与修改记录。拖动换算与当前地图的日期比例一致（包括缩放）；节点直接显示保存的日期，拖动时预览新日期。
- 讨论目标、策略或工作量时，DeepSeek 判断是否需要检索；需要外部知识时只把简短研究问题交给知乎 `zhida-agent`，再依据回答提出修改方案。
- 每次聊天从最新保存的计划读取版本、日期、状态和手工字段，补充与图中一致的显示编号和本周未完成任务；已完成任务不计入待办。本周临时预算不会改写长期每周预算。
- “未修改 / 已生成方案 / 已保存”由服务端根据真实执行结果标注；模型无修改却声称“已调整”的回答会被纠正或拒绝。旧聊天内容不作为已执行记录。
- AI 方案先展示逐项前后差异；“确认更新路线图”后保存 Plan Bundle 并重绘。讨论和生成阶段不修改正式计划。
- 方案可以放弃，也可以继续对话修改。页面刷新会恢复会话。直接编辑之后，旧版本方案不能应用。
- AI 不覆盖已完成任务或手工保护字段；必要时在图上修改。新任务保留已有节点 ID 和进度，不通过清空重建整张图来调整。
- 移除固定每周复盘入口、“现实有变化”和节点“这里有变化”按钮。新计划不再自动添加复盘节点或扣除复盘工时。具体任务中正常的结果分析/验收不受影响。

## 存储和接口

会话与最近方案存于项目 `.plan/chat.json`。正式计划仍为 `.plan/plan.json`，确认修改生成 `.plan/commits/` 记录。账号隔离沿用原有 Repository。

- `GET /api/projects/:id/chat`：恢复对话和最近方案。
- `POST /api/projects/:id/chat`：`{ message, baseVersion }`，返回回答及可选方案。
- `POST /api/projects/:id/chat/apply`：`{ proposalId }`，确认最新且未过期的方案。
- `POST /api/projects/:id/chat/discard`：`{ proposalId }`，放弃方案，保留对话。

复用 `ROADMAP_*` 模型配置、`ZHIHU_LIVE_ENABLED=true` 和 `ZHIHU_CLI_BIN`。模型等待期间提供步骤与耗时反馈。检索/连接失败不会自动重试付费请求；方案格式或排期校验失败最多纠正一次，不再次检索。

旧项目的复盘节点可通过以下显式迁移移除；会保存新版本，保留历史快照：

```bash
node --env-file=apps/server/.env.local --import tsx apps/server/scripts/remove-review-nodes.ts <projectId>
```

真实调用验收使用临时项目，完成后清理，不修改用户项目。会调用已配置的模型与知乎直答：

```bash
NODE_ENV=test node --env-file=apps/server/.env.local --import tsx apps/server/scripts/verify-roadmap-chat.ts
```
