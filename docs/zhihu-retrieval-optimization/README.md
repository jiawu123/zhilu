# 使用这份资料包

这是检索优化的设计、实施说明、合成回归数据和评测规则，不是已经改好的代码。没有修改用户仓库、没有执行新的知乎或模型请求。

## 文件

- `ZHIHU_RETRIEVAL_OPTIMIZATION.md`：方案与取舍，先读这个。
- `CODEX_RETRIEVAL_OPTIMIZATION.md`：给Codex的Task 0–8、接口、测试、预算和回退要求。
- `EVALUATION_RUBRIC.md`：如何判断质量是否真的变好，包含variant级标注。
- `SOURCE_AUDIT.md`：上传源码快照的逐段核对，不是远端当前HEAD。
- `SOURCES.md`：算法与评测的一手参考资料。
- `fixtures/synthetic_cases.json`：12个合成回归场景，来源/URL都是假的，禁止用于网络。
- `fixtures/evaluation_questions.json`：12个待采集的评测问题，8开发/4留出，没有真实结果或人审标签。
- `snapshot_probe_results.json`：已执行的旧ranker合成诊断，不是V3质量成绩。
- `DOCUMENT_CHECKS.json`：本资料包的格式验证结果，不是新代码的测试报告。

## 放进项目

把整个文件夹放进现有仓库：

```text
zhilu/docs/zhihu-retrieval-optimization/
```

不要覆盖 `.git`、`packages/zhihu` 或已有文件；本资料包没有需要覆盖的生产代码。不要提交真实凭据或本地采集的原始研究产物。

## 发给Codex的启动指令

```text
请阅读 docs/zhihu-retrieval-optimization/ 中的方案、实施文档和评测规则。
以 CODEX_RETRIEVAL_OPTIMIZATION.md 的Task 0–8为本次默认范围，实际修改代码、
编写测试并运行验证，而不是只总结文档。

先核对当前AGENTS.md、Git状态和真实包路径，以当前源码为准。
保留已通过的ResearchRequest → EvidencePack链路，不改Jia的前端、
Controller、Roadmapper、Plan Engine或History，不自动merge/commit/push。

重点实现：完整保留同source不同snippet，使用Query列表名次做RRF，
按问题需求而不是编程术语数量排序，基于已接受卡做软多样性选择。
已有compiler继续负责主张选择与精确引用；加入方法题与资源题的对照测试。
不要偷偷追加搜索、重跑Planner、拼接原文、删除风险标签或再造字段adapter。

新增可回退的本地profile，legacy保持默认；普通测试不联网。
按文档预算允许真实评测和一次V3联调，不必为token成本再次征询，
仍按工具权限审批。缺少凭据/CLI/网络时如实记录，不要求我贴密钥。

12个合成case只是工程回归；真实任务尚未采集或人工标注。
没有人审时标needs_human_review，不宣称相关性已经提高。
阶段B的LLM语义重排先不实现，报告是否值得下一轮做。

完成后用中文报告：实际文件改动、测试命令和结果、质量对照与未标注项、
真实调用次数、回退方式、最终git status，以及我下一条可执行的命令。
```

## 当前最重要的成功边界

真实HTTP成功已经确认的是单请求执行可用。V3优化要另做质量对照和回归；即使V3通过，也不代表真实Roadmap生成或前端展示已经完成。
