# 检索质量评测说明

本文件定义的是拟采用的评测规则，不是已经取得的质量分数。`snapshot_probe_results.json` 是旧函数的合成诊断；`fixtures/synthetic_cases.json` 是合成回归；`fixtures/evaluation_questions.json` 是尚未采集的真实研究任务表。

## 1. 三种验证不要混在一起

| 验证 | 能说明什么 | 不能说明什么 |
|---|---|---|
| 合成单元/跨语言测试 | 原文不变、规则边界、错误与接口兼容 | 真实模型一定理解问题 |
| 固定候选池人工标注 | 这批数据上某profile的相关性与支持性 | 全知乎召回率、总体统计显著性 |
| 真实Provider/HTTP联调 | 当前环境实际可以调用并返回结果 | 质量优于旧版、前端路线已用证据 |

## 2. 最小数据规模与分组

12个问题，4类需求各3题；先锁定8题开发集和4题留出集。开发集中调规则与提示词，不凭留出集结果反复改权重后继续叫它留出集。只有12题时，必须展示逐题表现和失败案例，不把均值当总体保证。

每题最多两次搜索，每Query count=5，保留全部合法occurrences（包括同source不同片段）。只有来源使用和本地保存被允许时才保存真实快照；所有真实快照放忽略目录，不进公共Git。合成资料中所有URL均是假数据，不得fetch。

实际模型评审预算首轮只覆盖4题，两个版本各每题最多3次编译。这四题必须覆盖多个领域，不能只挑最容易进步的题。其它8题只报告排序指标，不把缺少模型结果填0。

## 3. 按“source + 选中variant”标注，不只按文章ID

重要：同一source的第一份片段可能只有资源介绍，第二份有具体步骤。只给文章一个统一“3分”会让选错片段的旧策略也得到满分。

真实标签应采用：

```json
{
  "case_id": "learn-01",
  "source_id": "zhihu:Article:example",
  "variant_key": "hash-of-the-specific-normalized-result",
  "task_fit_grade": 2,
  "condition_fit": "unknown",
  "review_status": "human_reviewed",
  "reviewer": "reviewer-1",
  "note": "直接提供参数比较步骤，但没有初学者背景说明。"
}
```

上面是格式示例，不是完成的标签。未评审使用null及needs_human_review，不能由Codex填“human_reviewed”。模型可以提议标签，但必须标model_proposed，不能与独立人工标注混合。

对所有版本返回结果取pooling集合，隐藏版本顺序后人工评阅。最终质量指标的结果键使用 `source_id@variant_key`。相同source只占一个检索位置；evaluator在计分前验证source唯一性。[R5][R6]

## 4. 候选相关性分级

- 0：不回答问题，或只是不相关术语/纯引流。
- 1：主题相关，但所选片段没有问题需要的具体依据。方法题下仅“有教程/有框架”通常属于这里。
- 2：直接回答一个明确子问题，有动作、判据、条件、定义或资源范围，依问题类型判断；未必全面。
- 3：直接回答且包含足以理解其适用范围的具体步骤/判据/限制。不是“事实可信度3分”。

同一片段对资源题可为2，对方法题可为1。短、低赞、批判立场不自动减分；未知用户适用性不自动判0。

另外标condition_fit：compatible / incompatible / unknown。必须有文本和用户显式条件支持，不能用推测经历、受保护特征或作者身份来打分。

## 5. 核心指标的精确定义

### 5.1 Direct-answer Precision@3（排序阶段）

对实际选中variant的人工grade≥2计1，前三个唯一source命中数除以3。输出不足3时空位计0。不知道某variant标签时该题是unjudged，而不是默认不相关。按题等权平均，同时报告题数和逐题值。

这是“这批候选的直接回答相关性”，不是全文真伪，也不是全部知乎的Recall。

### 5.2 Accepted-card direct-answer precision（编译阶段）

对模型实际输出的claim+quote独立标注：是否直接回答本问题、是否保留主体/否定/条件/时间。不能因为source里的另一段有用就替不相关claim加分。直接回答卡数/已评审接受卡数；没有接受卡时指标为null，不是1。

### 5.3 Question success@2

在有至少一条人工判定适用候选的测试问题中，最多两张接受卡里是否至少有一张“直接回答且未含已发现的越界结论”；以题为分母。所有返回no_evidence的版本在正例题上记失败，避免通过全拒绝得到高精度。

对候选池本来就没有可用证据的问题，另报正确弃答率；不要强求产卡，也不混进正例success分母。

### 5.4 Unsupported-claim rate

评阅实际claim相对supporting_quote的支持性：supported / unsupported / uncertain。unsupported/已评审接受卡数；uncertain单独给比例，并算作尚未充分验证的项。指标不是外部事实核实率，即使supported，来源观点也可能不准确。

外部来源检验尚未做，保留verificationStatus=unverified。禁止用compiler自报理由或reranker自评分充当人工支持性标签。

### 5.5 Redundancy与覆盖

人工将已接受卡按“主张+条件”分组，记录同组后续卡数/接受卡数；0卡时null。观点相反或限制不同不能当重复。记录每题仍未覆盖的明确子问题，不要求每题同时有方法、风险、资源三种卡。

不同URL、作者名或相同source的不同片段都不证明独立观点。source命中多Query只提供排序信号。

### 5.6 工程指标

分别记录raw_item_count、valid_occurrence_count、variant_count、candidate_count、search_calls_attempted、compiler_calls_attempted、evidence_count、阶段耗时、typed failures。若后续有reranker，再独立计数。

未执行时间/次数填null或not_run，不填推测值。所有API尝试计数与token/计费分开。

## 6. 评测实验拆分

先跑三个ablation：

1. 相同检索快照 + 旧选择/旧ranker。
2. 相同快照 + 变体保留/RRF/V3任务排序，先不启用多样性。
3. 相同快照 + 上述V3 + 基于accepted source的多样性。

如果evaluator只做排序、没有编译，则第3项可用“前三名预选择”的替代展示，但必须命名selection_simulation，不能说它等价于真实runner根据接受卡动态选择。真实路径应另外使用fake与真实compiler验证。

Query提示词改写与compiler提示词改写分别比较，避免一次改变三处后把所有提升归给ranker。搜索快照冻结后比较的是重排；不能把这种结果称为Query召回改进。

真实模型可能有随机波动；记录模型配置和prompt hash，给出原始逐题结果。没有重复试验时如实说明，不凭一次结果报统计显著。

## 7. 拟定发布门槛

硬门槛：原文/引用/来源变造为0，凭据泄露为0，接口违规为0，原有回归通过，预算与截止时间可验证。受当前确定性validator覆盖的结构错误必须全部捕获。

质量门槛：开发集Direct-answer P@3平均相对legacy提升至少0.10的绝对值（10个百分点），留出集不下降；基线≥0.90时要求不下降且至少两例人工认可的直接性或非冗余改进。真实模型已评审接受卡若发现捏造来源或明显夸大引文，阻止推广；小样本未见错误不代表总体错误率为0。

这些是拟定的工程决策阈值，不是论文结论。未达到时保持legacy，分析退步原因，不增加伪造卡或放宽安全约束来凑指标。

## 8. 报告表头

每题至少有：case_id、split、candidate_capture_id/time、legacy_selected_source_and_variant、v3_selected_source_and_variant、human_label_status、P@3、accepted_card_precision、question_success、unsupported_count、uncertain_count、redundancy、search/compile attempts、latency、safe_errors、notes。

单独附调用预算表和未完成项。报告结论只覆盖实际已评审的数据。
