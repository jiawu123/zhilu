# 知乎 M2 Retrieval V3 Implementation Plan

> **For agentic workers:** 逐任务执行；有 Superpowers 时使用 executing-plans 或 subagent-driven-development，并按 TDD 和 verification-before-completion 验收。执行器仍须阅读工作区 AGENTS.md。没有相应工具时使用同等的顺序执行、测试和人工检查，不要伪称调用了不存在的工具。

**Goal:** 在不破坏现有 `ResearchRequest → EvidencePack` 的前提下，提高固定预算内直接回答研究问题的证据比例。

**Architecture:** 保留原始 source、旧 ranker、compiler、pipeline 和 TypeScript adapter。新增内部候选池、RRF/任务线索排序和基于已接受证据的软多样性选择；由本地 profile 开关 opt-in，旧路径可回退。

**Tech Stack:** 当前仓库的 Python、pytest、TypeScript、Vitest、Windows PowerShell；阶段 A 不新增第三方生产依赖或新模型服务。

**Spec:** 同目录 `ZHIHU_RETRIEVAL_OPTIMIZATION.md`。同时阅读 `SOURCE_AUDIT.md`、`EVALUATION_RUBRIC.md`、`fixtures/` 和 `SOURCES.md`。

## 执行授权与默认范围

这是给 Codex 的实施规格，不是让你再输出一份泛泛计划。用户把本文件交给你并要求实施时，执行 **Task 0–8（阶段 A）**；阶段 B 是后续设计，不默认写进本轮。先简述当前源码核对结果和拟改文件，再开展已授权范围内工作；涉及共享协议、其他成员未提交修改或范围扩张时才停下确认。

本文件中的新模块、profile、测试与 evaluator 均是待实现内容；不假装它们已经存在。路径以当前实际源码为准。本会话快照的包布局是 `packages/zhihu/zhihu_m2/`，**不是 `packages/zhihu/src/zhihu_m2/`**。

## Global Constraints

- 保留用户已有修改；不自动 merge、switch、stash、reset、clean、commit、push。阶段结束给出建议提交范围，由用户决定提交。
- 不读出、打印、复制或提交 `.env`、Authorization、API Key、Cookie、Keychain 内容。不要扫描整个用户目录。配置只从现有可信环境读取。
- 不修改 `apps/web`、Plan Engine、History、多请求 Controller、路线综合或 BaselineProposal。`apps/server/src` 原则上只新增边界回归测试；如确有生产兼容变更，先说明理由并协调 Jia。
- `pipeline --action research` 仍只接受 `{goal,user_context,request}`，执行器不调用 Planner、不改写或追加 request.searchQueries。
- `ResearchRequest` 不增加 evidence_need/profile 等字段。当前 TS 请求校验会拒绝多余字段；内部需求类型从 request.question 保守识别。
- 保留协议 `m2-entry-v0.1`、编译输出 schema `m2-evidence-v0.1.2`、source_scope=search_snippet；不新增未经配套校验的 data/card 字段。
- 保留 `unverified`、`search_snippet_only`、`not_independently_verified`、`semantic_support_not_checked`。排名高不是事实核实。
- 保留 quotes 连续原文、code-point 索引、CRLF/emoji 原样、原 URL、实际检索时间；清洗与截断仅用于评分视图。
- 保留状态：ok / no_evidence / partial / typed failure；异常、认证失败、限流、总超时不得伪装为 no_evidence。
- 保留单次搜索无自动重试、编译子进程终止、总截止时间、退出码和 stdout/stderr 协议。
- 保留 search_count 1–10、evidenceLimit 1–12、当前编译预算配置及默认值。阶段 A 不增加搜索和 LLM 调用；同一 source 在同一请求至多编译一次。
- 普通 pytest/Vitest 不联网；真实调用使用明确的 live 工具/评测命令。已有授权允许有预算的真实联调，不必为 token 成本反复询问，仍遵守工具权限审批。
- 不声称读取搜索片段等于阅读全文，不绕过授权/反爬/付费限制，不虚构 CLI 功能。
- 默认 profile 仍为 legacy。只有用户决定启用或明确通过本规格质量门槛后，才建议切 V3；不要悄悄改变默认生产行为。

---

## 一、实施前对照：不要重复修已经存在的功能

实际快照已包含：

```text
packages/zhihu/zhihu_m2/research_runner.py   单请求执行、原文保护、deadline、安全错误
packages/zhihu/zhihu_m2/ranker.py            V2.1 确定性评分
packages/zhihu/zhihu_m2/evidence_compiler.py  LLM 主张编译 + 精确引用校验
packages/zhihu/zhihu_m2/query_planner.py      问题拆分、evidence_need、baseline 3×2
packages/zhihu/zhihu_m2/plan_retrieval.py     安全 search_once、已保存 run 的检索能力
apps/server/src/zhihu-boundary.ts            运行时校验
apps/server/src/zhihu-adapter.ts             Python 卡片 → EvidenceCard
apps/server/src/zhihu-provider.ts            Server → Python 进程
```

几个会导致错误实施的细节：

1. `rank_results()` 目前必须返回输入 source 的完整排列；runner 检查集合和数量。不能让新排序偷偷只返回 Top 5，而保留旧断言。
2. `candidate_count` 当前指有效唯一 source 数，不是原始条数，也不是 LLM 返回数量；保持定义。
3. 旧版 `candidates.setdefault(sid, ...)` 选第一份合法片段，并有对应回归测试。新策略只能在 V3 下改变；不能删除 legacy 测试来“修通过”。
4. Query Planner 已输出 evidence_need，但 TS 的 draft 映射未向 ResearchRequest 传递。别在 runner 直接读取不存在的字段。
5. `author_signature` 未证实是稳定作者 ID，不把旧 `limit_per_author()` 直接接入 live。
6. compiler 已有“方法题不应以资源介绍凑数”的提示词；要加入可验证的对比例子，不是只再次写一句相同要求。
7. Node 的数字 metrics 可扩展，但 data/card/issue code 是严格校验。新 debug 字段不能随手塞进 data。
8. Node 对失败响应会筛选 metrics 白名单；阶段 A 不新增模型调用计数，无需为了报告改这块。

## 二、目标内部接口（均为本轮新增）

以下接口锁定职责，不锁死无关实现细节。若当前分支已有等价模块，复用并在报告中给出映射，禁止并存两个候选池。

### 2.1 `candidate_pool.py`

```python
from dataclasses import dataclass
from typing import Sequence
from zhihu_m2.models import ZhihuResult

@dataclass(frozen=True)
class SearchOccurrence:
    query_index: int
    result_rank: int  # Provider 原返回列表中的 1-based 名次
    retrieved_at: str
    result: ZhihuResult  # 必须持有防御性副本

@dataclass(frozen=True)
class SourceCandidate:
    source_id: str
    occurrences: tuple[SearchOccurrence, ...]

# 纯函数；输入须是 runner 已验证的合法来源。
def build_candidate_pool(
    occurrences: Sequence[SearchOccurrence],
) -> list[SourceCandidate]: ...

# 只由不可变内容字段计算，不用模型分数；不包含本次 query/rank。
# 用规范 JSON 的完整 ZhihuResult 字段计算 hash，避免同文字但 URL/作者不同被混同。
def variant_key(occurrence: SearchOccurrence) -> str: ...
```

`...` 仅是签名占位，交付实现不得保留。一个 source 的所有 occurrence 都保留；独立 variant 数按 variant_key 去重，retrieved_at 保留在 occurrence 上。相同文字不同元信息仍须可追踪。

### 2.2 `ranker_v3.py`

```python
from dataclasses import dataclass
from typing import Mapping, Sequence
from zhihu_m2.models import ZhihuResult
from zhihu_m2.candidate_pool import SourceCandidate

@dataclass(frozen=True)
class RankingContext:
    question: str
    queries: tuple[str, ...]
    freshness_requested: bool
    now_ts: float

@dataclass(frozen=True)
class RankedSource:
    source_id: str
    representative_index: int  # 索引对应原 pool[source_id].occurrences
    priority: float
    components: Mapping[str, float]

# method/verification/risk/resource/concept/experience 可多选；无明确线索返回 ("unknown",)。
def detect_intents(question: str) -> tuple[str, ...]: ...

def intent_surface_score(result: ZhihuResult, intents: tuple[str, ...]) -> float: ...

def rrf_scores(
    candidates: Sequence[SourceCandidate],
    successful_query_indexes: set[int],
    *, k: int = 60,
) -> dict[str, float]: ...

# 返回所有 source 的完整排列；模型与 source 内容均不可生成或修改。
def rank_candidates(
    candidates: Sequence[SourceCandidate],
    context: RankingContext,
    successful_query_indexes: set[int],
) -> list[RankedSource]: ...

# accepted_ids 只包括已经产出被接受证据卡的 source。
def select_next_source(
    ranked: Sequence[RankedSource],
    pool: Mapping[str, SourceCandidate],
    attempted_ids: set[str],
    accepted_ids: set[str],
    *, diversity_weight: float = 0.15,
    score_band: float = 0.10,
) -> RankedSource | None: ...
```

`RankedSource` 只返回原文索引，不返回“清洗后的新 source”；runner 用索引取自己保存的原始内容。检查完整 ID 排列、代表索引范围、每项分数有限且在 [0,1]。非法排序产物沿用 execution_error，不默默吞错。

### 2.3 `retrieval_options.py`

```python
from dataclasses import dataclass
from typing import Mapping

@dataclass(frozen=True)
class RetrievalOptions:
    profile: str = "legacy"  # 仅 legacy / v3

# 不在 import 时读取 .env。默认由已有 load_local_env 在可信执行边界调用。
def options_from_env(env: Mapping[str, str]) -> RetrievalOptions: ...
```

使用一个新增的本地开关 `ZHIHU_RETRIEVAL_PROFILE=legacy|v3`，不接受 HTTP body 配置。未知值触发安全 configuration_error，不自动降级。测试中显式注入 options，避免机器上的 .env 改变离线结果。

允许 `run_research(..., options=None)` 增加 keyword-only Python 内部参数，现有调用不受影响；外部 JSON 形状不变。新增 `ResearchDependencies.rank_v3`/`select_v3` 时放在现有字段末尾，保留旧 `rank` seam。

---

## Task 0 — 工作区与基线

**Read:** AGENTS.md、package.json、现有代码与 tests、config.py。
**Deliver:** `packages/zhihu/docs/RETRIEVAL_V3_STATUS.md` 的基线段落，不修改生产行为。

- [ ] 执行 `git status --short`、`git branch --show-current`、`git diff --stat`，记录 HEAD，不自动改分支。
- [ ] 确认 Python 路径、Node 可用、pnpm 版本遵守仓库配置；不要因为新终端 PATH 问题重装项目。
- [ ] 阅读涉及函数全文，确认 SOURCE_AUDIT 的观察是否仍成立，特别是 first-variant、source ID 与严校验。
- [ ] 在专用测试进程关闭 dotenv，并清除/隔离真实客户端调用；先跑当前相关离线测试。
- [ ] 记录已有失败与原因，不能把已有错误说成新优化造成，不能把环境缺少 CLI 说成业务测试已通过。

建议 Python 基线命令（在 `packages/zhihu`，使用当前仓库解释器）：

```powershell
& $py -m pytest tests/test_ranker.py tests/test_deduplicator.py tests/test_research_runner.py tests/test_query_planner.py tests/test_evidence_compiler.py tests/test_pipeline_entry.py -q
```

已有用户真实 HTTP runId 只作为历史验证记录，不冒充本轮 V3 的验证。

## Task 1 — 固定评测数据与纯指标

**Create:**
- `packages/zhihu/zhihu_m2/retrieval_evaluation.py`
- `packages/zhihu/tests/test_retrieval_evaluation.py`
- `packages/zhihu/tests/fixtures/retrieval_v3/`（从本资料包导入合成 fixtures，保留 synthetic 标签）

**Interfaces:**

```python
def precision_at_k(result_keys: list[str], grades: dict[str, int], k: int = 3) -> float: ...
def pairwise_preference_pass(order: list[str], preferred: str, other: str) -> bool: ...
```

grades 仅允许整数 0–3，排除 bool；grade≥2 才算直接回答。真实评测 result_key = source_id@variant_key，按实际选中片段标注，不能用同一文章其他片段的好标签代替。未标注 result_key 必须抛错，不默认算 0；固定分母 k，少于 k 的输出按空位计 0；k 必须为正整数、排除 bool。重复 result_keys 是错误；evaluator在调用前还须验证source唯一性，防止同一source的多个variant占多个位置。

- [ ] 先写以下测试，运行确认因缺实现失败：

```python
import pytest
from zhihu_m2.retrieval_evaluation import precision_at_k

def test_precision_does_not_reward_short_output():
    assert precision_at_k(["a"], {"a": 3}, k=3) == pytest.approx(1 / 3)

def test_unknown_label_is_not_treated_as_irrelevant():
    with pytest.raises(ValueError):
        precision_at_k(["missing"], {}, k=3)

def test_duplicate_result_is_rejected():
    with pytest.raises(ValueError):
        precision_at_k(["a", "a"], {"a": 3}, k=3)
```

- [ ] 实现纯函数；禁止导入 API 客户端或读取真实 artifacts。
- [ ] 加入 bool、负值、空结果、k大于结果数、分数边界测试；重跑通过。
- [ ] 使用 `fixtures/evaluation_questions.json` 作为待采集任务表，标签初始 null/needs_human_review；不要让 Codex 假称已有人审。

## Task 2 — source 去重与原始变体池

**Create:** `candidate_pool.py`、`tests/test_candidate_pool.py`。
**Consumes:** 已通过现有 normalize + _source_record 校验的 SearchOccurrence。
**Produces:** 原始 source/occurrence 池；无 API、无排序副作用。

建议测试 helper（只放在测试模块，不放进生产模块）：

```python
from zhihu_m2.models import ZhihuResult

def make_result(content_id, text, *, title="合成检索样例", signature=""):
    return ZhihuResult(
        title=title, content_type="Article", content_id=content_id,
        author_name="合成作者", author_signature=signature, author_badge_text="",
        content_text=text, url=f"https://zhuanlan.zhihu.com/p/synthetic-{content_id}",
        vote_up_count=0, comment_count=0, authority_level="", ranking_score=0.0,
        edit_time=0,
    )
```

这些 URL 是离线合成数据，不得用于真实网络请求或展示为实际来源。

- [ ] 先写并运行以下测试：

```python
from zhihu_m2.candidate_pool import SearchOccurrence, build_candidate_pool

def test_keep_two_raw_variants_of_one_source():
    t = "2026-09-12T00:00:00+00:00"
    first = make_result("a", "第一版\r\n先介绍一个教程。")
    later = make_result("a", "第二版🙂\r\n把实际输出与预先记录的期望值逐项比较。")
    pool = build_candidate_pool([
        SearchOccurrence(0, 1, t, first), SearchOccurrence(1, 2, t, later)
    ])
    assert len(pool) == 1
    assert len(pool[0].occurrences) == 2
    assert pool[0].occurrences[1].result.content_text == later.content_text
    first.content_text = "外部修改"
    assert pool[0].occurrences[0].result.content_text != "外部修改"
```

- [ ] 用 `(content_type, content_id)` 建池并防御性复制；不按 URL、标题、作者签名、正文相似度跨 source 硬合并。
- [ ] 用规范化字段 JSON 的 hash 实现 variant_key，不改原始 snippet；检索时间每次观察保留。
- [ ] 加入不同 answer ID、同签名不同作者、匿名作者、完全重复 occurrence、同snippet不同URL的测试。
- [ ] 验证输入对象未改动，RRF之前没有删去合法 source；空/非法 ID 由原 runner 校验拒绝，别改成“所有空 ID 为同一 source”。

## Task 3 — RRF + 任务线索基础排序

**Create:** `ranker_v3.py`、`tests/test_ranker_v3.py`。
**Read/reuse:** `ranker.py` 的 tokenizer、保守 clean_content、promotion_score、engagement_score 和 recency_score；允许提取纯 helper，但必须让原测试与旧分数不变。

### RRF 精确规则

每 query 每 source 仅使用最小 result_rank；缺失 query 贡献 0。分母为 `len(successful_query_indexes)/(k+1)`。successful indexes 为空时返回所有 source 的 0 分（实际 live 全失败仍由 runner 提前抛错）；k 严格正整数、排除 bool。

- [ ] 先加数值测试：

```python
import pytest
from zhihu_m2.candidate_pool import SearchOccurrence, build_candidate_pool
from zhihu_m2.ranker_v3 import rrf_scores

def test_rrf_one_contribution_per_query():
    t = "2026-09-12T00:00:00+00:00"
    a, b = make_result("a", "固定样例逐项检查。"), make_result("b", "其他相关资料。")
    pool = build_candidate_pool([
        SearchOccurrence(0, 1, t, a), SearchOccurrence(0, 3, t, a),
        SearchOccurrence(1, 2, t, a), SearchOccurrence(0, 2, t, b),
    ])
    scores = rrf_scores(pool, {0, 1})
    assert scores["zhihu:Article:a"] == pytest.approx((1/61 + 1/62)/(2/61))
    assert scores["zhihu:Article:b"] == pytest.approx((1/62)/(2/61))
```

### intent_surface_score 规则

只在清洗评分视图上计算；属于启发式而非自动语义验证。检测器大小写归一化仅对临时视图，使用配置化短词/模式表，不加入某个知乎作者或具体工具的黑名单。

必须覆盖的启动模式：
- method：有具体动作动词（如记录、比较、替换、检查、测量、拆分、列出、收集、访谈、复盘）与非空对象；一个动作+对象只给中等分，多个可执行动作再上调。
- verification：对比/检查/断言/测量等动作，与期望/标准/样例/误差/失败/结果等对象同一评分单元出现；只有“验证/测试”名词不足以给高分。
- risk：条件（如果/当/除非/取决于）与限制/失败后果同一单元；只有“坑”字不足。
- resource：资源名称或类型与用途范围同现；“最好/五分钟”不额外加分。
- concept：明确界定或组成/区别；术语堆砌不加成。
- experience：第一人称实践动作与结果/限制同现；“我整理了教程”不得自动得到高经历分。
- unknown：0.5；多个明确需求取各项平均，不用 max 掩盖遗漏。

实现无需 NLP 新依赖，但必须把具体词表、单元规则和模式判定写进源码并测试。“有动词”不是证明“可执行”。含糊表达留给 compiler，不能仅凭这个特征将来源标为不可用。

### 分数与代表变体

按主方案公式计算；每个 occurrence 的 RRF source分相同，其他分数从自身原始内容的评分视图计算。选择最高分 occurrence，平局按 query_index、result_rank、variant_key 稳定排序。source 排序平局按 source_id。

component keys 固定为 `lexical`、`rrf`、`intent`、`recency`、`engagement`、`promotion`。priority 取 [0,1]。所有分数是有限实数，拒绝 NaN/inf。

- [ ] 测试：同 source 后一个变体含真实操作，前一个只有介绍，V3 选后一个且索引对应原始 pool。
- [ ] 测试：相同基准下具体动作高于纯编码术语堆砌；木桌检查和访谈检查不因缺 API/Python 等术语受罚。
- [ ] 测试：unknown、短但有用、低赞、高赞无关、广告警示、只有资源介绍、否定意见、缺失/未来编辑时间。
- [ ] relevance 使用 `0.8*question_score+0.2*max(query_score)`；无显式时效要求 recency=0.5，提出要求才调用旧编辑时间函数。请求时效风险标签仍由 runner 保留。
- [ ] 不设置“没有用户所有条件就淘汰”的硬阈值，不设置全文长度排名加成。

## Task 4 — 基于已接受卡的多样性选择

**Modify:** `ranker_v3.py` 的 `select_next_source()`。
**Test:** `tests/test_ranker_v3.py`。

先排除 attempted_ids；remaining为空返回 None。取剩余最高基础 priority，只有 priority≥best-0.10 的候选可竞争本次选择。其余候选不是被删除，仍可在后续循环进入候选带。

accepted_ids 为空时按基础 priority 稳定排序；否则计算与已接受 source 的代表评分视图的最大 token Jaccard，再计算 `0.85*priority-0.15*similarity`。空集合相似度0；平局按基础 priority、source_id。绝不对接受卡正文做改写。

- [ ] 构造三个来源：A与B近似重复，C提供同问题另一项检验。A已接受、三者基础分接近时，C优先于B。
- [ ] A已编译但no_evidence时，A不进入accepted_ids，不能降低B的优先级。
- [ ] 很低相关的C不得仅因新颖超过明显较高相关的B。
- [ ] 相似的正反意见始终都留在pool；任何 soft penalty 都不能让source永久消失。
- [ ] 合成样例同签名、同作者名称不得触发硬配额；不使用 `limit_per_author()`。

## Task 5 — opt-in 接入 research_runner，保持旧路径

**Create:** `retrieval_options.py`、`tests/test_retrieval_options.py`。
**Modify:** `research_runner.py`；必要时对 `pipeline.py` 做最小注入，但不改JSON。
**Test:** 新增 `tests/test_research_runner_v3.py`；原 `test_research_runner.py` 不删。

- [ ] profile 默认legacy，v3显式开启，未知值在I/O前安全失败；注入 options 时不读取环境。
- [ ] 搜索循环仍逐项执行原 request.searchQueries；计数、错误分类和搜索超时不变。
- [ ] 枚举响应 Items 时在过滤非法项之前记录 result_rank（1-based），收集所有合法 occurrences，并记录成功 query indexes（包含成功空结果）。
- [ ] legacy 使用原 first-valid source + dep.rank 流程；V3 使用candidate_pool + rank_v3，必须验证完整source排列和representative_index。
- [ ] runner持有原始pool，传给ranker的是防御副本；ranker只允许指定索引，不能换原文。
- [ ] 每次调用前选择 next source；更新attempted_ids；只有输出卡被接受后才更新accepted_ids；一个source只尝试一次，不循环重编不同variant。
- [ ] 通过代表occurrence取 original ZhihuResult 和 retrieved_at，复用 `_compile_with_deadline`。不在新排序层直接调用模型。
- [ ] 到 evidenceLimit停止；达到编译预算且仍有未尝试source时沿用compiler_budget_exhausted；正常全部no_evidence仍是no_evidence；全部执行失败仍typed failure。
- [ ] `compilerOutputs` 包含所有本次正常编译的完整输出（包括no_evidence的source和reason），原格式不变。
- [ ] 旧trace保留为 occurrence明细；新增结构化诊断放新的内部 `ResearchDependencies.diagnostics` 字段，不往旧trace混入不兼容记录；需要脱敏时仅输出hash、sourceId、索引、数值分数和计数，不输出私密context。
- [ ] 不默认把trace/诊断写磁盘，不放HTTP data。evaluator可显式接收并保存到忽略的artifact目录，保留退避和最小化原则。

V3可在顶层数字metrics增加：

```text
raw_item_count          所有Code=0响应Items长度之和（含随后无效项）
valid_occurrence_count  通过现有source校验的出现次数
variant_count           按(source_id, variant_key)去重的个数
```

旧计数定义保持：candidate_count=unique source；compiler_calls_attempted=实际边界尝试；evidence_count=最终唯一卡。legacy不新增数字字段，以保留已有精确断言；新的数值字段需Node成功响应测试。

必要的行为测试：

```python
import copy
import pytest
from zhihu_m2 import research_runner as rr
from zhihu_m2 import query_planner as qp
from zhihu_m2 import evidence_compiler as ec
from zhihu_m2.retrieval_options import RetrievalOptions

def test_v3_uses_only_requested_queries_and_never_plans(monkeypatch):
    seen_queries, seen_sources = [], []
    text = "先记录工具收到的参数，再与事先写好的预期参数逐项比较。"
    request = {
        "goal": "构建一个有基本测试的Agent练习项目。", "user_context": {},
        "request": {
            "id": "rq-v3-offline", "question": "怎样检查工具实际收到的参数？",
            "searchQueries": ["工具 参数 检查", "智能体 固定样例 验证"],
            "relevantUserConditions": [], "evidenceLimit": 2,
        },
    }
    frozen = copy.deepcopy(request)
    def forbidden_planner(*args, **kwargs):
        pytest.fail("research不得重新调用Planner")
    monkeypatch.setattr(qp, "plan_research", forbidden_planner)
    def fake_search(query, **kwargs):
        seen_queries.append(query)
        return {"Code": 0, "Data": {"Items": [
            {"ContentType": "Article", "ContentID": cid,
             "Title": "合成工具参数检查", "ContentText": text,
             "Url": f"https://zhuanlan.zhihu.com/p/synthetic-{cid}"}
            for cid in ("offline-a", "offline-b")
        ]}}
    def fake_compile(result, **kwargs):
        seen_sources.append(result.content_id)
        return ec.validate_evidence_response({
            "status": "ok", "reason": "直接给出参数比较方法。",
            "evidence_cards": [{
                "source_id": f"zhihu:{result.content_type}:{result.content_id}",
                "supporting_quote": text,
                "claim": "作者建议记录实际参数，再与预期参数逐项比较。",
                "claim_type": "advice", "applies_when": "有预先写好的预期参数时。",
                "caveats": [],
            }],
        }, result, retrieved_at=kwargs["retrieved_at"])
    metrics = {}
    data = rr.run_research(
        request,
        dependencies=rr.ResearchDependencies(
            search=fake_search, compile=fake_compile,
            now=lambda: "2026-09-12T00:00:00+00:00",
        ),
        options=RetrievalOptions(profile="v3"), metrics=metrics,
    )
    assert request == frozen
    assert seen_queries == frozen["request"]["searchQueries"]
    assert len(seen_sources) == len(set(seen_sources)) == 2
    assert data["requestId"] == "rq-v3-offline"
    assert data["status"] == "ok" and data["issues"] == []
    assert metrics["search_calls_attempted"] == 2
    assert metrics["compiler_calls_attempted"] == 2
    assert metrics["candidate_count"] == 2
    assert metrics["evidence_count"] == 2
    for output in data["compilerOutputs"]:
        assert output["source"]["snippet"] == text
        card = output["evidence_cards"][0]
        assert card["quote_start"] == 0 and card["quote_end"] == len(text)
        assert card["verification_status"] == "unverified"
```

这是拟新增测试，不是已经在当前未改源码上通过的测试；新增options参数之前应失败。不要把fake compiler通过声称为真实模型质量提升。

## Task 6 — Query 与 Compiler 的内容优化，格式不变

**Modify:** `query_planner.py`、`evidence_compiler.py`（只新增V3内容profile与必要的keyword-only内部参数）。
**Test:** 扩展 `test_query_planner.py`、`test_evidence_compiler.py`，并新增真人评审fixture。

同一个 `ZHIHU_RETRIEVAL_PROFILE` 控制内容策略：legacy完整保留旧提示词；v3加入互补Query和方法/资源成对示例。不要偷偷让legacy使用新prompt，避免A/B不可解释。

实现建议：planner `_system_prompt` 增加keyword-only `retrieval_profile="legacy"` 参数；plan_research在可信调用边界读取本地profile，不把它写入ResearchRequest。保持baseline planning_profile=jia-p0-baseline独立且优先控制数量。compiler增加keyword-only `retrieval_profile="legacy"` 参数，由runner显式传入，仍把原始上下文传给模型，不往用户背景添加假事实。

必须使用的V3补充要求：

```text
查询：同题两条Query保持同一核心问题；优先让一条覆盖具体方法，另一条覆盖
检验、失败、限制或另一种用户会使用的自然说法。不要机械追加"踩坑"。
不以工具名称或预想答案为起点寻求确认，不推断用户未提供的属性。

编译：先判断question需要方法、检验、风险、经历、概念还是资源。
"支持测试/回归测试首选/五分钟上手"只表明资源的作者声称，不能单独回答
"如何判断调用参数正确"。没有直接动作或判据时返回no_evidence。
同样的资料在"有什么资源"问题下可以归因转述；不要按工具名称黑名单过滤。
确有具体操作的短片段可以形成证据，不靠长度、点赞或术语数量决定采纳。
```

- [ ] 验证legacy输出prompt与行为不变，v3实际传给LLM的prompt包含这些内容。
- [ ] 验证baseline仍恰好3题每题2Query，全局不重复，needs_clarification不被改成强凑问题；通用模式保留1..max的上限语义。
- [ ] 既有 schema/COMPILER_VERSION 不改；报告中的prompt hash取实际发送的完整prompt，不用旧SYSTEM_PROMPT常量代替。
- [ ] 两个题目使用同一资源片段，编写单独的真实模型评审case：方法题应不凑卡，资源题可归因转述。输出只可作为实际待人工复核结果。
- [ ] 测试exact quote但claim多出“保证两周学会”的情况：当前确定性校验可能仍通过，测试必须如实说明其边界，不通过伪造validator能力掩盖；质量评审应判unsupported。

## Task 7 — 可重复 evaluator 与跨语言兼容

**Create:**
- `packages/zhihu/scripts/evaluate_retrieval.py`
- `packages/zhihu/tests/test_retrieval_evaluation_cli.py`
- `apps/server/src/zhihu-retrieval-v3.test.ts`
- 合成跨语言JSON fixture，放测试目录并标明不是真实API结果。

CLI 最低接口（待实现）：

```powershell
& $py .\packages\zhihu\scripts\evaluate_retrieval.py --help
& $py .\packages\zhihu\scripts\evaluate_retrieval.py --case-file .\packages\zhihu\tests\fixtures\retrieval_v3\synthetic_cases.json --profiles legacy v3 --offline --output .\packages\zhihu\artifacts\retrieval-v3-synthetic.json
```

要求：从根目录运行也能正确解析package；不要通过猜测cwd读另一份.env。此evaluator离线模式只排序/计算已标注指标，不调用真实compiler、planner、CLI，不写正式Plan，不调用main示例。

合成fixtures里的source级grades是简单案例的默认标签；若有 `checks.grade_by_occurrence`，必须按实际选中的occurrence索引覆盖，再映射为source_id@variant_key。真实数据只接受variant级标签。相同variant收到冲突标签时拒绝计分，不能任选其一。

若只加载合成fixtures，输出必须为 `evaluation_scope="synthetic_regression"`，不能打印“真实质量提升”。真实快照缺少人工标签时输出 `quality_status="needs_human_review"`，指标为null或明确未评估，不能以0代替未知。

- [ ] 用新V3runner+fake合法编译器生成完整Python响应，交给真正的TS `parseResearchResponse`，不是手写另一个parser。
- [ ] 验证 requestId、evidenceLimit、全部旧风险标记、CRLF/emoji、quote索引与完整source匹配。
- [ ] 测试新增合法数值metrics可透传，非法NaN/负值被拒绝；没有把诊断dict塞进metrics/data。
- [ ] 测试清理原文、删除risk标记、乱添data字段、错requestId都会被TS拒绝。
- [ ] 模拟搜索全部失败、部分失败、编译预算、总超时、全部编译失败和正常无证据，不把这些当质量差但成功。
- [ ] 重跑现有Provider、HTTP、Mock和baseline/apply测试，确保正式Plan/History/pending proposal未变。

## Task 8 — 有界真实评测、报告与交接

**Create/update:**
- `packages/zhihu/docs/RETRIEVAL_V3_STATUS.md`
- `packages/zhihu/docs/RETRIEVAL_V3_EVALUATION.md`
- `packages/zhihu/README.md` 的profile与评测章节

- [ ] 先跑普通离线单元/跨语言/回归，保存实际命令、退出码、通过/失败/跳过数，不把fixture通过说成模型判断通过。
- [ ] 对12题建立固定候选快照，来源经过允许的CLI检索，不抓全文；搜索最多2/query question，每Query最多5条：总24次搜索尝试，无重试。已有合规完整快照可复用，注明原抓取时间。
- [ ] 对同一快照运行legacy和v3确定性排序，不再为两版本分别重复搜索。
- [ ] 首轮真实compiler评测最多挑4题，两个profile各每题最多3个来源、最多2张卡：总24次编译尝试上限。剩余8题先做排序评测；不要声称12题都有端到端编译质量结论。
- [ ] Query prompt质量另行用4个目标做legacy/v3各一次：最多8次Planner调用；不自动执行其查询。只让人工评估互补性、主题偏移、格式，不能宣称检索召回提升。
- [ ] 最后对v3执行一次真实Provider或HTTP验收，最多2次搜索、3次编译。不是重复此前legacy成功记录；没有环境凭据时准确记录blocked。
- [ ] 每次记录请求数、实际调用尝试数、模型配置标识（无key）、prompt hash、候选抓取时间、耗时、source ID和片段hash；不得保存环境变量全集或原始异常。
- [ ] 检查所有人工标签来源；没有人审不宣告推广门槛通过。用户可先试用V3，但默认值保持legacy，直到用户明确选择。
- [ ] 最终给出git status与逐文件变更说明；不自动commit/push。交接Jia时明确这是检索质量优化，不是完整live roadmap交付。

本阶段全部上限合计：最多26次搜索尝试、27次编译尝试、8次Planner尝试。不是必须用满。认证/配额错误立即停止相关live批次；网络/超时结果按原状态记录，不循环重试。原始快照缺授权保存依据则改用允许的脱敏/最小片段或合成回放，明确无法完成真实对照。

---

## 三、Windows 命令模板（实施后按实际文件名更新）

以下新增profile/evaluator只有Task实现后才可用。已有API入口本来就会执行真实调用，最后一组不要反复运行。

### 1. 验证环境、选择解释器

```powershell
Set-Location "C:\Users\Kylee\Desktop\zhilu"
$py = (Resolve-Path .\.venv\Scripts\python.exe -ErrorAction Stop).Path
$nodeDir = Join-Path $env:ProgramFiles "nodejs"
if (Test-Path (Join-Path $nodeDir "node.exe")) {
    $env:Path = "$nodeDir;$env:Path"
}
& $py --version
node --version
```

### 2. 离线回归（避免dotenv影响；finally恢复原设置）

```powershell
$oldDotenv = $env:PYTHON_DOTENV_DISABLED
$oldProfile = $env:ZHIHU_RETRIEVAL_PROFILE
try {
    $env:PYTHON_DOTENV_DISABLED = "1"
    $env:ZHIHU_RETRIEVAL_PROFILE = "legacy"
    Push-Location .\packages\zhihu
    try {
        & $py -m pytest tests/test_ranker.py tests/test_candidate_pool.py tests/test_ranker_v3.py tests/test_research_runner.py tests/test_research_runner_v3.py tests/test_retrieval_options.py tests/test_retrieval_evaluation.py tests/test_retrieval_evaluation_cli.py tests/test_query_planner.py tests/test_evidence_compiler.py tests/test_pipeline_entry.py -q
        if ($LASTEXITCODE -ne 0) { throw "离线测试失败。先检查本次报告。" }
    } finally { Pop-Location }
} finally {
    if ($null -eq $oldDotenv) { Remove-Item Env:PYTHON_DOTENV_DISABLED -ErrorAction SilentlyContinue }
    else { $env:PYTHON_DOTENV_DISABLED = $oldDotenv }
    if ($null -eq $oldProfile) { Remove-Item Env:ZHIHU_RETRIEVAL_PROFILE -ErrorAction SilentlyContinue }
    else { $env:ZHIHU_RETRIEVAL_PROFILE = $oldProfile }
}
```

假客户端必须禁止网络，即便测试环境已有其他凭据。清除dotenv开关不等于卸载凭据，不能据此断言“绝不联网”。

### 3. TypeScript测试与全仓回归

```powershell
# 使用仓库已配置的pnpm；若当前终端没有pnpm，不擅自升级项目依赖。
pnpm.cmd --filter @zhilu/server test
if ($LASTEXITCODE -ne 0) { throw "Server测试失败。" }
pnpm.cmd typecheck
if ($LASTEXITCODE -ne 0) { throw "类型检查失败。" }
pnpm.cmd test
if ($LASTEXITCODE -ne 0) { throw "全仓测试失败。" }
```

### 4. 一次真实V3 Provider验收

```powershell
$oldProfile = $env:ZHIHU_RETRIEVAL_PROFILE
try {
    $env:ZHIHU_RETRIEVAL_PROFILE = "v3"
    $env:ZHIHU_PYTHON_BIN = $py
    $env:ZHIHU_PYTHON_CWD = (Resolve-Path .\packages\zhihu -ErrorAction Stop).Path
    .\node_modules\.bin\tsx.cmd .\apps\server\scripts\smoke_zhihu_provider.ts --live
    if ($LASTEXITCODE -ne 0) { throw "V3真实联调失败，请检查安全错误码，不要自动重复。" }
} finally {
    if ($null -eq $oldProfile) { Remove-Item Env:ZHIHU_RETRIEVAL_PROFILE -ErrorAction SilentlyContinue }
    else { $env:ZHIHU_RETRIEVAL_PROFILE = $oldProfile }
}
```

配置在Node启动时继承。要让已运行的HTTP Server使用新profile，需要修改启动环境并重启Server；在发HTTP请求的另一个终端设置profile不会改变它。

### 5. 回退

```powershell
$env:ZHIHU_RETRIEVAL_PROFILE = "legacy"
```

之后用该终端重启Server，或明确从本地.env改回legacy后重启。不要用git reset来撤回profile；验证日志/本地诊断确实显示legacy，不只看两张卡数量。

---

## 四、阶段 B 的边界（本轮不默认实施）

新增一次批量LLM重排，最多8个unique sources，每个source只使用选定的原始variant。每个来源给至多1600个Unicode code points的评分窗口，最多两个连续原文窗口，每个窗口独立给出start/end、truncated=true/false；不得把不相邻窗口拼接后假称连续引文。总JSON输入字节和输出字节须先检验，沿用64KB/进程输出限制。

建议输出：`{ordered_source_ids: [...], decisions: [{source_id, task_fit: 0..3, use: method|verification|risk|experience|concept|resource|unclear}]}`。只用于排序；IDs必须是输入集合完整排列，数量、类型、枚举、重复项全验证。判断不确定时标unclear，不造新证据。

单请求最多1次reranker调用，必须受可终止子进程和现有剩余deadline控制。不要直接在主runner调用无限等待的generate_json；也不要删掉已存在的compiler终止测试。

重排失败可回确定性结果，但必须记录现有 `rank_failed`、stage=rank、partial。新增 `reranker_calls_attempted`，同步评估Node失败metrics白名单与回归。保持semantic_support_not_checked，因为重排不是已输出claim的支持性校验。

实施前先产出单独的小设计和预算，并得到用户批准。通过固定候选池、人审和调用耗时对照再决定是否启用；不要把LLM自评分当效果证明。

## 五、Codex最终报告格式

1. 基于哪个HEAD/分支，哪些源码观察发生了变化。
2. 实际修改文件、旧能力如何保留、各profile含义。
3. Task逐项状态：done / blocked / not_started，不用“基本完成”隐藏缺口。
4. 实际执行命令和测试数；未运行的Windows/CLI/网络步骤明确列出。
5. 固定候选池指标、人审标签来源、开发/留出分组、退步例子与不确定性。
6. 本轮搜索/编译/Planner次数、是否触达预算；不混同attempts与token费用。
7. 是否达到拟定质量门槛；未达到继续保留legacy，不用重复调参覆盖失败记录。
8. 下一条用户可直接执行的命令、回退办法、Jia无需改动的接口与剩余工作。
9. 最终git status；不自动commit、push或改main。

完成声明必须区分：代码与接口兼容 / 合成回归通过 / 固定数据人审提升 / 真实单次联调成功。四者不能互相替代。
