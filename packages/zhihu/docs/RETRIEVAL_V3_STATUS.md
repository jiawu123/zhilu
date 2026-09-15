# Retrieval V3 实施与交接状态

实施日期：2026-09-12。基于分支 `kylee-zhihu-agent`、HEAD `5e17431da41567847a6142e8220a18f7152ee26a`。开始时已跟踪文件干净，只有用户提供的 `docs/zhihu-retrieval-optimization/` 未跟踪；未发现适用 AGENTS.md。没有切换/合并分支、stash、reset、clean、commit 或 push。实施以当前源码和 Task 0–8 为准。

## 范围与结果

| Task | 状态 | 实际结果 |
|---|---|---|
| 0 工作区/基线 | done | 普通包 `packages/zhihu/zhihu_m2`，根 `.venv` Python 3.12.7，Node 24.19.0；基线 Python 333、Server 90 项通过 |
| 1 评测基线 | done | 12 合成案例与12固定真实任务，8开发/4留出分组保留；未知标签不计0 |
| 2 occurrence/variant | done | 同一 type/id 聚合、全字段 variant 哈希、每个 occurrence 保留 Query、原名次、原时间、原 snippet |
| 3 问题排序/RRF | done | 完整唯一 source 排列、按成功 Query 原始名次融合、显式问题意图、旧 ranker 不变 |
| 4 软多样性 | done | 仅在近分区间内按已接受来源调整，no_evidence/失败不算 accepted，不按作者或相似 URL 硬删 |
| 5 runner/profile | done | 默认 legacy；v3 显式本地开关；输入/输出、失败语义、compiler 上限、deadline、原始 source/引用保留 |
| 6 提示词对照 | done（实现） | legacy prompt 保持原文；v3 改问题互补性与方法/资源判定；已有 compiler 确定性校验不放宽；真实结果待人审 |
| 7 工程回归 | done | 离线排序三消融、真实 TS parser/adapter 跨语言测试、新旧回归；未另写 adapter |
| 8 真实评测/推广门槛 | blocked（部分执行） | 第5次知乎搜索遇到配额/限流，立即停止。仅2题采集完整；4领域完整比较、新v3 Provider真实验收及全部人工标注尚未完成 |

阶段 B 的额外 LLM reranker **not_started，按本轮要求不实施**。代码与接口兼容、合成回归通过、固定数据人审提升、真实 Provider 联调成功是不同验收项。此前 M2/Server 真实证据接口保留；本轮不能声称“v3真实端到端已验收”或“真实证据驱动完整 Roadmap 已完成”。

## 实际文件与职责

路径均相对仓库根目录。

| 文件 | 用途 |
|---|---|
| `packages/zhihu/zhihu_m2/candidate_pool.py` | 防御性拥有原始 occurrence；按 source 分组与全字段 variant 标识 |
| `packages/zhihu/zhihu_m2/ranker_v3.py` | RRF、问题意图、代表 variant 与软多样性；仅排序，不核实事实 |
| `packages/zhihu/zhihu_m2/retrieval_options.py` | 仅本地 legacy/v3 配置；非法值安全失败，不在 import 时加载 dotenv |
| `packages/zhihu/zhihu_m2/research_runner.py` | v3 分支接线、返回值严格检查、原始副本编译、accepted/attempted 集合、新数值 metrics |
| `packages/zhihu/zhihu_m2/query_planner.py` | 本地 profile 对应提示词及可审计 builder；通用/首次 Baseline 原有数量逻辑保留 |
| `packages/zhihu/zhihu_m2/evidence_compiler.py` | v3 问题需要提示词与 builder；保留当前输出 schema/风险/引文验证 |
| `packages/zhihu/zhihu_m2/pipeline.py` | 未知本地 Planner profile 映射安全 configuration_error |
| `packages/zhihu/zhihu_m2/retrieval_evaluation.py` | 纯离线 variant 计分、缺失/冲突标签拒绝、共同人工标注题汇总 |
| `packages/zhihu/zhihu_m2/retrieval_live_evaluation.py` | 显式采集与持久调用 ledger、原始消息哈希审计、冻结候选回放 |
| `packages/zhihu/scripts/evaluate_retrieval.py` | 从根目录可执行的离线三消融 CLI |
| `packages/zhihu/scripts/run_retrieval_live_evaluation.py` | 有界真实 capture/compiler/planner 阶段、独占锁与禁止重复启动 |
| `packages/zhihu/tests/test_candidate_pool.py`, `test_ranker_v3.py` | 变体、名次、RRF、意图、浮点与多样性回归 |
| `packages/zhihu/tests/test_research_runner_v3.py`, `test_retrieval_options.py` | 单请求、0 Planner、原文/时间、集合校验、接受卡、多种失败与配置 |
| `packages/zhihu/tests/test_prompts_v3.py` | 旧 prompt 兼容、profile、方法/资源对照设计与语义验证能力限制 |
| `packages/zhihu/tests/test_retrieval_evaluation.py`, `test_retrieval_evaluation_cli.py` | 合成/真实标签隔离、未知 null、固定分母、variant 冲突、离线 CLI |
| `packages/zhihu/tests/test_retrieval_live_evaluation.py`, `test_retrieval_live_evaluation_cli.py` | 预算预留、阶段锁、错误隔离、真实消息哈希、冻结回放（均 fake） |
| `packages/zhihu/tests/fixtures/retrieval_v3/*` | 用户合成/真实任务副本、合成方法/资源待评审案例，不抓取其中合成 URL |
| `packages/zhihu/tests/fixtures/retrieval_v3_runner_offline.py` | 真 v3 runner + fake 合法 compiler 的完整跨语言输出 |
| `apps/server/src/zhihu-retrieval-v3.test.ts` | 真 parser/原 adapter 验证 UTF-8、CRLF、emoji、风险、错ID/非法metrics等 |
| `packages/zhihu/tests/conftest.py`, `test_pipeline_entry.py`, `test_query_planner.py` | 离线 profile 隔离、错误边界与现有测试兼容 |
| `packages/zhihu/.env.example`, `README.md`, `docs/RETRIEVAL_V3_*.md` | 本地配置、中文可执行命令、回退、结果与剩余工作 |

未修改 Jia 的前端、Controller、Roadmapper、Plan Engine、History、生产 Server Provider/adapter 或共享 Contracts。没有把 Mock mode 改成 live。

## Jia 的调用保持不变

Server 继续调用 `createZhihuProvider(config).researchOne({ goal, user_context, request })`。`goal` 与 `user_context` 来自已确认项目；HTTP 仍只接受 `{request: ResearchRequest}`。不增加 profile 请求字段。首次 Baseline 继续使用现有 `planForBaseline()`，研究阶段不调用它。

Python 本地显式调用可使用：

```python
from zhihu_m2.research_runner import run_research
from zhihu_m2.retrieval_options import RetrievalOptions

result = run_research({
    "goal": "检查项目的工具调用参数",
    "user_context": {},
    "request": {
        "id": "rq-example-1",
        "question": "怎样判断工具调用参数符合预期？",
        "searchQueries": ["工具调用 参数 测试", "调用参数 固定样例 比较"],
        "relevantUserConditions": [],
        "evidenceLimit": 2,
    },
}, options=RetrievalOptions("v3"))
```

此调用真实联网；普通测试注入 `ResearchDependencies`，禁止使用个人凭据。`ResearchDependencies` 原字段及 positional 顺序保留，新 `rank_v3`/`select_v3`/`diagnostics` 追加末尾。独立 `diagnostics` 只含 ID、hash、索引和排序数值，不放进 stdout/schema/metrics。

正常无证据的完整 data 示例（说明 schema，不冒充真实执行结果）：

```json
{"requestId":"rq-example-1","status":"no_evidence","compilerOutputs":[],"routeCandidates":[],"unresolvedQuestions":["No applicable evidence was obtained from the evaluated search results."],"issues":[]}
```

已有有证据返回样例和完整 EvidencePack 仍见 [P0_JIA_HANDOFF.md](P0_JIA_HANDOFF.md)。`ok`、`no_evidence`、`partial` 是正常执行状态；所有搜索失败/所有编译失败分别抛安全 `research_failed`/`compilation_failed`，不能返回成功空数组。每个成功 compiler 输出包括 source、reason、evidence_cards 原样保留。v3 只增加合法数值 metrics：`raw_item_count`、`valid_occurrence_count`、`variant_count`。

## 验证记录

所有普通测试不联网。TDD 实际经历：options 缺模块 RED→9通过；runner 缺新参数24失败→24通过；坏数值与 selection 超时4失败→通过；evaluator 空池误报人审等审查用例 RED→GREEN；提示词与 CLI 同样先测缺功能再实现。首次整套 Python 出现2项测试引用旧 LLMError 类的问题，定位为已有 importlib.reload 后测试保存旧类，改为读取模块当前类后通过。

最终完整命令、计数及真实调用详见 [RETRIEVAL_V3_EVALUATION.md](RETRIEVAL_V3_EVALUATION.md)。本机 pnpm PATH 指向另一 bundled fallback，曾拒绝隐式安装；使用此前已存在的临时目录 pnpm 10.30.2 执行 typecheck/test/build，没有重新安装或升级依赖。

## 回退与剩余工作

```powershell
$env:ZHIHU_RETRIEVAL_PROFILE = 'legacy'
# 然后从此终端重新启动 Server。不得靠另一个 HTTP 终端的变量修改已运行服务。
```

默认一直是 legacy；无须用 Git reset 回退。后续在知乎配额恢复且获得下一轮明确运行预算后，补齐未采集题目与 v3 Provider 验收；不删除本次 ledger 重试。人工按 variant 对三个消融的合并结果盲审，另审实际 claim/quote 的直接性、支持性和冗余。没有标签不计算推广门槛。非 Windows 平台本轮未实测；没有完成真实证据驱动完整 Roadmap。

## 最终 Git 状态

git status --short 原样如下；暂存为空，分支/HEAD保持上述基线，未commit/push。用户原有的实施资料目录仍未跟踪、没有覆盖。

```text
 M packages/zhihu/.env.example
 M packages/zhihu/README.md
 M packages/zhihu/tests/conftest.py
 M packages/zhihu/tests/test_pipeline_entry.py
 M packages/zhihu/tests/test_query_planner.py
 M packages/zhihu/zhihu_m2/evidence_compiler.py
 M packages/zhihu/zhihu_m2/pipeline.py
 M packages/zhihu/zhihu_m2/query_planner.py
 M packages/zhihu/zhihu_m2/research_runner.py
?? apps/server/src/zhihu-retrieval-v3.test.ts
?? docs/zhihu-retrieval-optimization/
?? packages/zhihu/docs/RETRIEVAL_V3_EVALUATION.md
?? packages/zhihu/docs/RETRIEVAL_V3_STATUS.md
?? packages/zhihu/scripts/
?? packages/zhihu/tests/fixtures/retrieval_v3/
?? packages/zhihu/tests/fixtures/retrieval_v3_runner_offline.py
?? packages/zhihu/tests/test_candidate_pool.py
?? packages/zhihu/tests/test_prompts_v3.py
?? packages/zhihu/tests/test_ranker_v3.py
?? packages/zhihu/tests/test_research_runner_v3.py
?? packages/zhihu/tests/test_retrieval_evaluation.py
?? packages/zhihu/tests/test_retrieval_evaluation_cli.py
?? packages/zhihu/tests/test_retrieval_live_evaluation.py
?? packages/zhihu/tests/test_retrieval_live_evaluation_cli.py
?? packages/zhihu/tests/test_retrieval_options.py
?? packages/zhihu/zhihu_m2/candidate_pool.py
?? packages/zhihu/zhihu_m2/ranker_v3.py
?? packages/zhihu/zhihu_m2/retrieval_evaluation.py
?? packages/zhihu/zhihu_m2/retrieval_live_evaluation.py
?? packages/zhihu/zhihu_m2/retrieval_options.py
```
