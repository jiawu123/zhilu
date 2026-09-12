# Retrieval V3 本轮验证与质量对照

2026-09-12，分支 `kylee-zhihu-agent`，基线 HEAD `5e17431da41567847a6142e8220a18f7152ee26a`。**工程实现与接口回归通过；真实质量提升尚未验证，默认保持 legacy。** 实施文件清单和 Jia 交接见 [RETRIEVAL_V3_STATUS.md](RETRIEVAL_V3_STATUS.md)。

## 实际普通测试

环境：Windows PowerShell，仓库 `.venv\Scripts\python.exe` 3.12.7、Node 24.19.0，既有依赖。所有普通自动化为 fake/离线，不使用真实凭据。表内最终命令均 exit 0，无失败、无跳过。

| 实际命令 | 工作目录 | 结果 |
|---|---|---|
| `..\..\.venv\Scripts\python.exe -B -m pytest -q` | `packages/zhihu` | **731 passed**，15.56秒 |
| `.\node_modules\.bin\vitest.cmd run` | 仓库根 | **133 passed**，13个文件；新 v3 跨语言12项 |
| `node (Join-Path $env:TEMP 'zhilu-p0-pnpm-10.30.2/package/bin/pnpm.cjs') test` | 仓库根 | **133 passed**；Server110、web7、agent-runtime10、plan-engine6；contracts没有测试文件，正常退出，不计跳过 |
| `node (Join-Path $env:TEMP 'zhilu-p0-pnpm-10.30.2/package/bin/pnpm.cjs') typecheck` | 仓库根 | 五个 workspace 检查全部通过 |
| `node (Join-Path $env:TEMP 'zhilu-p0-pnpm-10.30.2/package/bin/pnpm.cjs') build` | 仓库根 | 全仓构建通过 |
| `.\node_modules\.bin\tsc.cmd --noEmit -p apps/server/tsconfig.json` | 仓库根 | Server 类型检查通过 |
| `git diff --check` | 仓库根 | 通过；仅 Git 的 LF/CRLF 提示，无 whitespace 错误 |

两种 TypeScript 命令覆盖重叠，不能累加成266个独立测试。最后完整 Python 731 项也包含阶段性测试，不与333/78/85等中途计数累加。最后两处Python边界修复后，另运行v3跨语言/Provider/HTTP/Mock相关4个TS文件，55项再次通过，属于上述133项的子集。

TDD 与修复记录：

- 配置模块缺失：collection error → 9通过；runner新入口未实现：24失败 → 24通过。
- 原始数值坏项/选择耗尽deadline：4失败 → 新旧runner73通过。
- 提示词与CLI都有缺实现 RED，再最小实现 GREEN；实际记录在本地 `artifacts/retrieval-v3-*-report.md`。
- 第一次整套 Python：698通过、2失败。根因是既有测试 reload 了 llm_client，新测试缓存了旧异常类；测试改为引用当前模块类后整套709通过。
- 最终 live 工具审查：冻结回放时钟、保留坏项位置/原错误类型、数值校验、失败批次状态的8项失败先复现再修复，相关85项通过；最后整套728通过。
- 最终生产代码独立审查又复现可选元数据非法Unicode/NaN和source ID碰撞，新增3项RED→GREEN；坏occurrence隔离、不同tuple的ID碰撞安全失败，旧路径不变。审查者重跑原复现确认修复；最终整套731通过，0失败/0跳过。
- 普通测试不调用真实知乎/模型；CRLF/emoji/Python codepoint 与 JS UTF-16、完整 source、旧风险标签、篡改引用、重复source、无证据/部分失败/全部失败、预算、子进程超时、秘密哨兵、Plan/History/pending proposal、Mock/Baseline/apply 均在新旧回归范围内。

## 合成回归：不是线上质量结论

执行过的根目录命令：

```powershell
.\.venv\Scripts\python.exe -B packages/zhihu/scripts/evaluate_retrieval.py --case-file packages/zhihu/tests/fixtures/retrieval_v3/synthetic_cases.json --profiles legacy v3 --offline --output packages/zhihu/artifacts/retrieval-v3-synthetic.json
```

exit 0；12题、`evaluation_scope=synthetic_regression`、0搜索/0编译/0Planner。标签来自用户提供的合成 fixtures，不是独立人工评阅的真实来源。

| 消融 | 合成平均 P@3 |
|---|---:|
| legacy，第一份 variant + 旧 ranker | 0.388889 |
| v3_no_diversity | 0.416667 |
| selection_simulation | 0.416667 |

只有 `later-variant` 的 P@3 从0变为1/3，其余11题该指标相同；没有这个指标下降的合成案例。这是预设片段保留回归的结果，不代表真实检索质量提升。固定分母为3，短输出不补卡。selection_simulation 假定预选来源被接受，不能替代真实 compiler 之后的 accepted-source 多样性。

## 真实尝试与限额

本轮唯一目录：`packages/zhihu/artifacts/retrieval-v3-live-20260912/`，Git忽略。开始 `2026-09-12T11:06:37Z`，最后模型调用结束 `2026-09-12T11:10:55Z`。模型继续使用源码配置 `deepseek-v4-pro` 与现有 DeepSeek endpoint。没有替换服务商，未打印/复制密钥、完整环境、Authorization 或原始异常。

| 阶段 | 实际尝试 | 结果 | 本轮文档预算 |
|---|---:|---|---:|
| 知乎采集 | **5搜索** | 4成功；第5返回 `rate_or_quota_limit`，立即停止、不重试 | 24搜索 |
| 真实冻结候选 compiler | **4编译** | 1 validation_error、1 no_evidence、2 ok卡片输出 | 24编译总预算内 |
| 合成方法/资源/短动作真实模型对照 | **6编译** | 3 validation_error、3 ok卡片输出 | 与上项合计10/24 |
| 四目标双profile Planner | **8 Planner** | 8格式校验通过；其中3 needs_clarification，未执行生成Query | 8 Planner |
| v3真实Provider/HTTP验收 | **0** | blocked：已遇知乎配额/限流，遵守停批规则，未再触发同服务 | 另最多2搜索/3编译 |

总计 **5搜索、10编译、8 Planner**，没有自动重试。18次模型 HTTP 尝试全部记录实际发送 messages 的 SHA-256、模型标识和耗时；调用次数不是token数或计费金额。搜索约6.25秒、compiler边界累计约35.45秒、Planner边界累计约41.61秒（各次顺序尝试耗时相加）。

实际运行命令（每阶段一次）：

```powershell
.\.venv\Scripts\python.exe -B packages/zhihu/scripts/run_retrieval_live_evaluation.py --live --phase capture --output-dir packages/zhihu/artifacts/retrieval-v3-live-20260912
# exit 1：rate_or_quota_limit
.\.venv\Scripts\python.exe -B packages/zhihu/scripts/evaluate_retrieval.py --case-file packages/zhihu/artifacts/retrieval-v3-live-20260912/candidates.json --profiles legacy v3 --offline --output packages/zhihu/artifacts/retrieval-v3-live-20260912/ranking.json
# exit 0：12题均 needs_human_review，未知质量指标null
.\.venv\Scripts\python.exe -B packages/zhihu/scripts/run_retrieval_live_evaluation.py --live --phase compiler --output-dir packages/zhihu/artifacts/retrieval-v3-live-20260912
# exit 1：partial，三个领域未采集，未补搜或替换题目
.\.venv\Scripts\python.exe -B packages/zhihu/scripts/run_retrieval_live_evaluation.py --live --phase planner --output-dir packages/zhihu/artifacts/retrieval-v3-live-20260912
# exit 0：complete，8个输出通过格式校验
```

`ledger.json` 是实际联网调用依据；compiler结果中的 `search_calls_attempted=2` 是本地快照回放次数，不是新增知乎调用。`candidates.json` 保留20个原始 occurrence、排名、来源和抓取时间；不抓全文、不拼接片段。`ranking.json` 保留每个profile选中source与variant；`compiler-results.json` / `paired-prompts.json` 保留实际合法完整输出；失败只保存安全类别，不能将其解释为正常 no_evidence。`planner-results.json` 保留已验证模型输出。全部人工标签尚为空。

首次 capture/真实 compiler 在最后一次工具审查修复前执行：该快照没有后加的 `query_outcomes`，编译排序采用当时运行时钟，较抓取约晚两分钟；它不是严格冻结时钟的编译实验。已完成的离线排序使用快照 `now_ts`。后续 CLI 已固定两种 ranker 的时钟并保存完整 Query rawcount/错误类型；旧快照以 `replay_metadata_complete=false` 标示信息不足。本轮没有为了修复工具而重采集或重跑模型，原 artifacts 未改写。这是本轮比较的明确限制。

## 逐题覆盖与未标注项

| case_id | 集合 | 采集情况 | compiler覆盖 |
|---|---|---|---|
| learn-01 | development | 两Query成功，10 occurrence/10 source | legacy/v3 各2尝试 |
| learn-02 | development | 两Query成功，10 occurrence/10 source | not_run，按固定四领域方案不替补 |
| learn-03 | holdout | 首Query配额错误，未取得候选 | not_run |
| career-01 | development | not_collected | capture_not_available |
| career-02 | development | not_collected | not_run |
| career-03 | holdout | not_collected | not_run |
| team-01 | development | not_collected | capture_not_available |
| team-02 | development | not_collected | not_run |
| team-03 | holdout | not_collected | not_run |
| craft-01 | development | not_collected | capture_not_available |
| craft-02 | development | not_collected | not_run |
| craft-03 | holdout | not_collected | not_run |

12题全为 `needs_human_review`；开发8/留出4均无已人审样本，P@3、accepted-card precision、question success、unsupported/uncertain/redundancy指标均未评估（null）。没有将模型拒绝或工程失败记成质量0。

真实 `learn-01`：legacy为partial（一次compiler校验失败、一次正常no_evidence），0卡；v3为ok，2卡。两个版本共用相同原始候选快照。**两张卡不等于直接回答、支持性或事实可信度经过人工验证。** 其余三个领域因quota未能采集，不能声称四领域或12题端到端质量结论。

合成片段的真实模型对照（不算知乎真实检索质量）：

| 案例 | legacy | v3 |
|---|---|---|
| 资源宣传片段回答方法题 | validation_error | validation_error |
| 同片段回答资源题 | validation_error | ok，1卡 |
| 短动作方法正例 | ok，1卡 | ok，1卡 |

方法题预期是合法no_evidence，但本次两个profile都未通过结构/引用等现有确定性校验，不能把失败冒充正确弃答，也不能宣称此项模型判断已改善。失败原模型输出未保存，只有安全validation_error类别；不推测具体失败字段、不放宽validator、不追加调用。另有离线测试明确演示：引文匹配正确也可能掩盖claim语义越界，`semantic_support_not_checked`仍保留。

Planner单独对照：learn-01 两版均3题6Query；career-01 legacy为3题6Query，v3 needs_clarification；team-01两版均needs_clarification；craft-01两版均3题6Query。互补性、偏题、澄清是否合理均待人审，不称为召回提升。

## 人工复核与推广门槛

按各版本所选结果合并池盲审，不能只按 source 统一打分。候选快照每case的 `grades:null` 可由人工改为以下记录数组，示例不是本轮已完成标签：

```json
[{"source_id":"来自候选的真实source ID","variant_key":"来自该variant的SHA-256","task_fit_grade":2,"condition_fit":"unknown","review_status":"human_reviewed","reviewer":"实际评阅者","note":"对选中片段的判断理由"}]
```

未人审记录保持 `needs_human_review`/null；模型提议只能标 `model_proposed`。evaluator拒绝未知variant、冲突标签、bool冒充grade、重复source。空池加空标签不等于人审完成。`paired_summary`只比较所有消融共同已标注题目，避免不同分母造成虚假增益。

真实候选指标的人审尚未开展；接受卡另须审查claim+quote的直接回答、否定/主体/适用条件、supported/unsupported/uncertain及冗余分组，不能从排序分数推导。当前evaluator这些卡片指标保持null，需要完成人审再扩展汇总，不能用合成P@3替代。

拟定开发P@3绝对提升≥0.10且留出不退步的门槛**未验证**。默认继续 legacy。还需补齐知乎采集及一次真正 v3 Provider验收，非Windows环境未实测。真实Roadmap综合不在本轮范围，没有完成声明。

## 下一条可直接执行的命令与回退

根目录直接执行，仅离线，不消耗真实预算：

```powershell
.\.venv\Scripts\python.exe -B .\packages\zhihu\scripts\evaluate_retrieval.py --case-file .\packages\zhihu\tests\fixtures\retrieval_v3\synthetic_cases.json --profiles legacy v3 --offline --output .\packages\zhihu\artifacts\retrieval-v3-synthetic.json
```

切回 `$env:ZHIHU_RETRIEVAL_PROFILE='legacy'` 并从该终端重启Server；不要reset代码，不要改HTTP body或正式Plan状态。已有 `createZhihuProvider(config).researchOne(...)`、`/research/live/evidence`、Mock/Baseline/apply 全保留，不需要 Jia 新接adapter。
