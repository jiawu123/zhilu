# 资料来源与使用边界

查阅日期：2026-09-12。源码依据是用户在本会话上传的 `zhilu.zip`，不是远程仓库当前 HEAD。执行时当前工作区源码优先。文档中的新模块、配置名、分数权重和目标阈值都是本方案的建议，不是已实现功能或已证实的提升。

## 工程事实

- [C1] `SOURCE_AUDIT.md`：上传代码的逐段摘录、相对路径、行号和 SHA-256。
- [C2] 用户贴出的真实 Provider / HTTP 测试：每次 2 次搜索尝试、2 次编译尝试、2 张卡；HTTP runId 为 `entry_da287ab20338488b96570ebc807c2f55`。这是连通性验证，不是检索质量基准。
- [C3] `snapshot_probe_results.json`：本次实际执行的四段合成文本的旧 ranker 评分；0 搜索、0 模型调用。只用于说明旧启发式的行为，不代表真实质量评测。

## 方法参考：只采用一手来源

[R1] Cormack, Clarke & Büttcher (2009), *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR.
- 原论文：https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
- DOI：https://doi.org/10.1145/1571941.1572114
- 本方案仅借用“按各列表名次做倒数求和”的融合思路。原论文的实验效果不能直接迁移为知乎效果保证。

[R2] PyTerrier 官方文档，*Result Fusion*.
- https://pyterrier.readthedocs.io/en/stable/ext/pyterrier-alpha/fusion.html
- 对 RRF 的公式与 k=60 默认值提供实现参照。本方案不要求安装 PyTerrier。

[R3] Carbonell & Goldstein (1998), *The Use of MMR, Diversity-Based Reranking for Reordering Documents and Producing Summaries*, SIGIR.
- DOI：https://doi.org/10.1145/290941.291025
- 作者出版物页面：https://www.cs.cmu.edu/~jade/
- 用途是兼顾相关性与非冗余性；本方案采用简化的词面相似度版本，不声称能够识别独立作者、独立观点或事实可靠性。

[R4] Sun et al., *Is ChatGPT Good at Search? Investigating Large Language Models as Re-Ranking Agents*, arXiv:2304.09542 / EMNLP 2023，已查阅 v3 摘要。
- https://arxiv.org/abs/2304.09542
- 说明 LLM 可以承担相关性重排任务；不保证用户当前模型在知乎语料上能复现论文结果。第二阶段必须独立比较效果。

[R5] Manning, Raghavan & Schütze, *Introduction to Information Retrieval*, Evaluation of ranked retrieval results.
- https://nlp.stanford.edu/IR-book/html/htmledition/evaluation-of-ranked-retrieval-results-1.html
- 用于 Precision@k 的定义及小样本波动提醒。没有完整相关文档集合，不把候选池内指标宣传成全知乎 Recall。

[R6] 同书，Assessing relevance.
- https://nlp.stanford.edu/IR-book/html/htmledition/assessing-relevance-1.html
- 用于“先定义研究需求，再人工标注固定候选池”的评测设计；模型评分不能充当独立人工金标准。

[R7] OWASP Gen AI Security Project, LLM01:2025 Prompt Injection.
- https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- 搜索片段是外部不可信数据。隔离指令与数据、校验返回结构、限制权限和加入对抗测试；提示词声明本身不能保证完全防护。
