# 本地 Ranker 泛化与验证（2026-09-12）

本次将 `ranker.py` 从技术词表驱动的 V2.1 更新为 `m2-ranker-v4`。目标是让本地排序适用于评委自行输入的问题，而不默认“成为 Agent 工程师”。工作分支 `kylee-zhihu-agent`，开始时 HEAD 为 `3bccb4a605fcc2f7d5756f38bb508f9f1d039c98`，工作区干净；未发现适用的 AGENTS.md。本次未切换分支、提交或推送。

## 作用范围和接口

- `rank_results(results, query, now_ts=None)` 返回原始对象的完整排列，并列保留输入顺序；一次排序冻结一次时间。
- `evidence_score(result, query, now_ts=None)` 返回 0–1 的本地优先级。
- 新增 `ranking_breakdown(result, query, now_ts=None)`，返回 `ranker_version`、`score_kind`、`intents`、`weights`、`signals`、`gates` 和 `score`。
- Jia 继续调用已有 `createZhihuProvider(config).researchOne({goal,user_context,request})`。`ResearchRequest → EvidencePack` 与既有 adapter 不变；legacy runner 传入 `request.question`，研究期间不调用 Planner，也不追加查询。
- 生产默认仍为 **`batch-v1`**，继续由模型批量筛选。修改的 V4 作用于 **legacy 和直接调用 ranker 的本地入口**。`v3` 复用新 `question_signals.py`，原 RRF、组合权重、原始 variant 与接受证据后的多样性选择公式不变，但共享信号变化可能改变其排序结果。
- 不改前端、Controller、Roadmapper、Plan Engine、History、来源字段、风险标签或证据协议。这不是完整真实 Roadmap 的交付。

## 权重与信号

按问题需要选择权重，多种需要取对应策略的平均值；不识别或猜测职业。

| 问题需要 | 相关性 | 所需结构 | 具体细节 | 点赞评论 |
| --- | ---: | ---: | ---: | ---: |
| 方法 / 验证 / 风险 | .60 | .25 | .12 | .03 |
| 资源 | .65 | .15 | .17 | .03 |
| 概念 / 原因 | .65 | .20 | .12 | .03 |
| 经验 | .60 | .20 | .17 | .03 |
| 未识别 | .70 | .10 | .17 | .03 |

“最新、目前、今年、latest”等明确时效措辞，将 .08 从相关性移给更新时间；其余问题时间权重为 0。未知时间和未来时间取中性值。编辑时间不证明内容新鲜，点赞不证明内容可靠。

相关性使用英文词和中文二元字组，去除通用问句词。正文词面覆盖率达到 .5 后饱和，相关性由 .35 标题覆盖和 .65 饱和后的正文覆盖组成。完整照抄问题的评分单位被排除；与陈述性标题相同的有效短答仍保留。这些操作只影响临时评分文本。

所需结构包括动作与对象、编号或先后步骤、同句检验依据、条件与后果、资源用途、解释与对比。具体细节来自带上下文和单位的数量、例子、资源适用范围、条件或检验信息、步骤。纯数字列表或 API/JSON/Python 等术语本身没有细节奖励。

加权和再乘三项折扣：正文覆盖 `0.2 + 0.8 × 饱和覆盖率`；明确问题类型的结构匹配 `0.35 + 0.65 × 所需结构分`（未知类型不折扣）；沿用原推广信号 `1 − 0.5 × 推广分`。`signals.body_alignment` 保留未饱和的原始覆盖率，`gates` 给出实际折扣。

这些权重和阈值是可解释的工程设定，**没有经过真实标注集校准**。输出明确标注 `heuristic_priority_not_fact_confidence`；分数不是置信概率、事实可信度或用户适用性结论。

## 可执行验证

使用仓库已有 `.venv` 和 Node 依赖；评测脚本不加载 `.env`、不访问模型或知乎。服务运行时仍沿用已有 Python/Node 环境配置，无新凭据、新服务商或前端配置。

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
# 固定时间、相同来源元数据、相同案例；报告覆盖之前的本地输出。
.\.venv\Scripts\python.exe -B .\packages\zhihu\scripts\evaluate_ranker.py
if ($LASTEXITCODE -ne 0) { throw 'Ranker 评测执行失败' }

# 完整离线后端回归，不触碰现有项目数据。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
if ($LASTEXITCODE -ne 0) { throw '后端验证失败' }
```

自定义合成问题可以复制 fixture 的格式，通过 `--case-file <路径> --output <路径>` 执行。JSON 顶层必须是 `dataset_kind: "synthetic_engineering_regression"`、`review_status: "needs_human_review"` 和 `cases`；每个案例包含 `id/domain/question/preferred/distractor`，两候选各含 `title/content_text`。不应把未经标注的真实材料伪装为合成案例；真实质量评测继续使用现有 `evaluate_retrieval.py` 及其标注协议。

输出默认 `packages/zhihu/artifacts/ranker-cross-domain.json`，包含所有案例、领域计数、两候选的权重和信号。默认 `now_ts=1800000000`，并列不计为偏好满足；CLI 退出 0 只代表成功运行，偏好未满足会保留警告。

## 已运行结果和质量边界

先补失败测试再实现，复现了技术词加分、无关高赞内容胜出、问题重复、短答误删、英文后句能力描述抹掉前句动作等问题。新增测试还覆盖 NaN/Infinity/bool 元数据、稳定排序、时间冻结、CRLF/emoji 原文保留，以及真实 legacy runner 在演讲、写作、产品问题下仅执行指定 Query、不调用 Planner。

实际运行记录：

| 命令 / 检查 | 结果 |
| --- | --- |
| 根目录 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1` | 当时 Python 997 passed；后端 TS 186 passed；类型检查通过；HTTP 36/36；批量 Provider→Python→adapter 两领域通过 |
| 补充 3 个 runner 集成案例后，在 `packages/zhihu` 执行 `..\..\.venv\Scripts\python.exe -B -m pytest -q` | 最终 Python **1000 passed，0 failed，0 skipped** |
| 根目录 `.\.venv\Scripts\python.exe -B packages/zhihu/scripts/evaluate_ranker.py` | 成功执行 16 对合成案例，偏好结果见下表 |
| `git diff --check` | 通过；Git 提示工作区 LF 将按现有配置转 CRLF，无空白错误 |

新增 112 项 Python 测试。全套后端结果记录于本地 `artifacts/local-backend-20260912T153910Z-1f20c260/checks.json`，评测与基线对照分别在 `artifacts/ranker-cross-domain.json`、`artifacts/ranker-cross-domain-baseline.json`（均相对于 Python 包目录，未纳入 Git）。

本次新 16 个合成对照与原 12 个检索合成案例都只是工程回归。固定同一案例、同一元数据和时间，对比基线提交中的实际旧代码与 V4：

| 实现 | 满足合成偏好 | 并列 | 未满足 |
| --- | ---: | ---: | ---: |
| 基线 V2.1（`3bccb4a`） | 1 | 1 | 14 |
| V4 | 10 | 1 | 5 |

V4 分领域：编程 2/2、写作 2/3、演讲 2/2、产品验证 2/2、语言学习 1/2、时间安排 0/2、摄影 1/3。对照经过开发期查看，不是独立留出集；不据此宣称真实排序质量提升。

尚未满足：`writing_resources_en`、`language_resources_en`、`time_budget_zh`、`photography_concept_en`、`photography_risk_zh`；`time_budget_en` 并列。词面与结构规则不能可靠识别语义矛盾、时间预算是否可行、同义改写或资源的实际用途，仍可能把无用但结构完整的段落排在前面。真实评测问题尚未采集和人工标注，状态保持 **`needs_human_review`**。

真实 Planner / 搜索 / 模型调用均为 **0**。没有使用现有密钥，也没有新增阶段 B 的额外 LLM 重排。

实际改动：`zhihu_m2/ranker.py`（权重和解释接口）、`zhihu_m2/question_signals.py`（共享结构信号）、`zhihu_m2/ranker_v3.py`（复用共享信号）；`scripts/evaluate_ranker.py` 和 `tests/fixtures/ranker_cross_domain.json`（可重复离线对照）；`tests/test_ranker_general.py`、`tests/test_question_signals.py`、`tests/test_ranker_evaluation.py`（新增回归）；本目录文档、包 README 与根目录 `docs/LOCAL_BACKEND_TESTING.md`（使用和真实作用范围）。

## 回退与 Jia 后续

生产默认 `batch-v1` 不受 V4 权重影响。显式选择 legacy 会使用更新后的 V4，不能用该配置名称复现旧 V2.1 分数；切换 profile 后需重启 Server。历史评测报告不改写。

若需要精确复现旧算法，可在新目录单独检出已知基线，不覆盖当前未提交修改：

```powershell
git worktree add --detach ..\zhilu-ranker-baseline 3bccb4a605fcc2f7d5756f38bb508f9f1d039c98
```

该命令会创建独立目录，应在需要回退时手动执行；本次没有执行。提交本次改动后，也可以按常规流程撤销该提交，先审查差异。Jia 不需要更换调用函数；下一步应在最终部署环境运行已有 Provider 联调，采集并人工标注跨领域真实问题，特别补足上面的资源、时间约束和解释/风险缺口。
