# 知乎 M2 → Jia P0 对接 Implementation Plan

> 给 Codex：这是一份实施任务，不是要求你再次提供泛泛建议。先核对当前仓库，再按阶段修改、测试和交付。在下述范围内直接推进，不要每做一个小步骤都询问是否继续。遵守适用的 AGENTS.md 和工具权限；需要权限时走正常审批，不绕过限制。
>
> **For agentic workers:** 若当前环境提供 Superpowers，使用 subagent-driven-development 或 executing-plans 逐任务执行，并保留测试优先和完成前验证。不要因为插件不可用而停止开发。下文已明确设计与默认范围；不自动 commit 或 push。

**Goal:** 将 Kylee 的现有知乎 M2 接成 Jia P0 可调用、可校验的真实研究 Provider，完成单个 ResearchRequest 到共享 EvidencePack 的链路。

**Architecture:** Python 保留 pipeline 唯一入口，复用现有检索、排序和单来源证据编译。Node Server 负责启动 Python、转换 Planner 输出、复用已有证据 adapter，并提供独立的真实证据接口。正式路线综合、Roadmapper 和 Plan 写入仍由 Jia 的 runtime／engine 管理，不能把证据对接冒充为完整 Live Roadmap。

**Tech Stack:** 现有 Python 环境、pytest、TypeScript、Node.js、pnpm workspace 和 Vitest；以当前仓库的依赖声明及锁文件为准，不为此任务升级整套工具链。

**Spec:** 本文件第 1–6 节为本次内嵌接口规格，第 7–11 节为实施和验收要求。配套 `REFERENCE_SOURCE_EXCERPTS.md` 是 Jia 上传快照的参考，不替代当前源码。

## 1. 默认范围、工作区保护和来源优先级

### 1.1 这次要做到哪里

必须实现：

1. 现有 Planner 可以输出满足 Jia 首次 Baseline 校验的研究问题。
2. `pipeline --action research` 能执行一个共享 ResearchRequest；不重复规划总目标。
3. Server Provider 能运行 Python、校验响应、复用 `adaptZhihuCompilerOutput()` 并返回 EvidencePack。
4. 增加独立、默认关闭的真实证据调试接口，验证 HTTP → Node → Python → EvidencePack。
5. 提供离线测试、跨语言契约测试、Windows 配置方法、受控真实 smoke test 和给 Jia 的交接说明。

本次不默认实现新的 LLM Roadmapper，不重写前端，不替换 plan-engine，不自动应用任何正式 Baseline。若当前工作区已有 Jia 的 live 编排，可在不改变其公开合同的情况下接入这个 Provider；没有就交付可运行的证据接口，明确写出路线生成尚未接入，不能临时调用 Mock 模板冒充。

### 1.2 工作区

用户主要仓库原为 `C:\Users\Kylee\Desktop\zhilu`，常用分支 `kylee-zhihu-agent`。这是定位线索，不是强制路径或分支指令。以本次打开的工作区和 Git 状态为准。

先执行只读检查：

```powershell
git rev-parse --show-toplevel
git branch --show-current
git status --short
git diff --stat
git diff --cached --stat
```

读取根目录及本次修改目录适用的 AGENTS.md。记录开始时已存在的改动。不得覆盖用户未提交内容；不能用 ZIP 覆盖仓库或 `.git`，不能自动 `reset --hard`、`clean -fd`、切换分支、stash、merge、rebase、commit、push。

如 Jia 文件尚未出现在当前分支，可以只读检查已存在的远程引用，必要时 fetch。不要自行合并整个分支。继续完成不受阻的 Python 工作，把缺失依赖精确记录出来，不复制一份假的共享 Contracts 来掩盖缺失。

### 1.3 先定位实际文件，不假定 Python 一定有 src 目录

检查下列文件或实际承担同样职责的文件：

```text
packages/contracts/src/index.ts
packages/agent-runtime/src/index.ts
packages/agent-runtime/src/index.test.ts
apps/server/src/zhihu-adapter.ts
apps/server/src/zhihu-adapter.test.ts
apps/server/src/index.ts
apps/server/src/index.test.ts
apps/server/src/repository.ts
apps/web/src/App.tsx                         # 仅了解调用，不默认修改
packages/zhihu/README.md
packages/zhihu/**/pipeline.py
packages/zhihu/**/query_planner.py
packages/zhihu/**/plan_retrieval.py
packages/zhihu/**/evidence_compiler.py
packages/zhihu/**/zhihu_client.py
packages/zhihu/**/llm_client.py
packages/zhihu/**/config.py
packages/zhihu/**/models.py
packages/zhihu/**/ranker*.py
packages/zhihu/tests/
package.json / pnpm-workspace.yaml / pnpm-lock.yaml
Python 依赖声明、环境配置示例及现有联调脚本
```

如果同时存在两个 `zhihu_m2`，先确认解释器实际导入哪一个，不能让测试用一份代码、Server 跑另一份。

执行 `python -c "import sys; print(sys.executable)"`；在适当的包工作目录验证 `import zhihu_m2` 的实际路径。不要凭名字认定 `.venv` 已激活或全局 Python 装好了依赖。

### 1.4 已知参考快照，不要当成当前仓库的永恒事实

Jia 上传快照的参考分支是 `codex/p0-core-roadmap`，参考提交是 `daf3588c9fd85f4a1d1a9a089ef75dc2e66ef662`。其中：

- 有 `adaptZhihuCompilerOutput()`，但它仅转换数据，不启动 Python。
- 有 `validateResearchQuestionDrafts()` 和 `assembleResearchRequests()`。
- 研究 HTTP 路由仍是 `/research/mock`。
- `createMockBaselineProposal()` 与 `buildRoutePreview()` 使用 Mock 数据／路线模板。
- 正式应用使用 `/baseline/apply`。
- Python 历史入口实现了 plan，research 曾返回 `research_not_connected`。

请逐项核对实际代码。已经实现的部分优先复用，只补缺口；接口已更新时先记录差异，并同步本任务涉及的双方边界与测试，不恢复成旧快照。

## 2. 必须保留的架构边界

### 2.1 证据字段只转换一次

Python `compile_evidence()` 保留现有原始输出：

```text
compiler_version / status / reason / source / evidence_cards
```

Node 复用 `apps/server/src/zhihu-adapter.ts` 的 `adaptZhihuCompilerOutput(output)`。

不要在 Python 再实现一套 EvidenceCard camelCase 转换，不要把 ranker、cache、compiler 的内部字段全部重命名。

### 2.2 ID 各司其职

- Planner 的 `question_id` 是内部追踪 ID，不是 Controller 的请求 ID。
- Controller 继续通过 `assembleResearchRequests()` 分配外部 `ResearchRequest.id`。
- Python 研究结果的 `requestId` 必须原样等于本次 `request.id`。
- Server 必须拒绝 requestId 不匹配的响应，而不是把错误 ID 改成当前 ID。
- 不将外部 ID 直接拼成磁盘路径。研究日志用服务端生成的 run_id 和安全目录。

### 2.3 不改变正式 Plan

研究流程不得调用 `savePlan()`、`saveCommit()` 或 `baseline/apply`，不得改变项目 version、currentCommitId、nodes、relations 或 History。

研究证据接口与正式路线应用不是同一个接口。正式链路应是：EvidencePack → runtime 路线综合 → BaselineProposal → 用户确认 → engine 校验和应用。

## 3. 请求与返回协议：新增部分必须双方同时实现

本节的研究包装、状态、issues 和新 HTTP 路径是本任务要实现的约定，不是声称 Jia 当前已经有这些接口。优先保持现有 pipeline 外层协议兼容，不随意升级或重命名既有 plan 字段。

### 3.1 保留共享 ResearchRequest

以当前 `packages/contracts` 为权威；参考结构如下：

```ts
interface ResearchRequest {
  id: string;
  question: string;
  searchQueries: string[];
  relevantUserConditions: string[];
  freshness?: string;
  evidenceLimit: number;
}
```

不要为了放入 goal 而直接修改这个共享接口。

### 3.2 Python research 输入

保持 `pipeline --action plan` 原来的 `{ goal, user_context }` 输入。新增 research 输入为：

```json
{
  "goal": "8周内完成一个可运行、带基本测试的 Agent 小项目。",
  "user_context": {
    "current_situation": "Python 初学者",
    "weekly_hours": 10,
    "constraints": ["只能使用业余时间"],
    "success_criteria": ["项目可以运行，包含基本自动化测试"]
  },
  "request": {
    "id": "rq-integration-001",
    "question": "初学者怎样为 Agent 项目编写基本测试？",
    "searchQueries": ["Agent 项目 初学者 自动化测试", "Python Agent 项目 验收 调试"],
    "relevantUserConditions": ["Python 初学者", "每周可投入10小时"],
    "evidenceLimit": 4
  }
}
```

对应关系：`goal` → compiler.goal；用户背景以 `user_context` 为来源；`request.question` → compiler.research_question；只执行 `request.searchQueries`。编译输入的上下文视图还需显式保留本次 relevantUserConditions 与 freshness，标为研究请求的适用约束，不覆盖已确认的用户事实；组合后重新检查上下文长度。不得读取了这些字段却在编译时无声丢掉。

网络调用之前完成校验：

- 顶层必须是对象，字段按上述新包装校验；禁止把凭据、Python 路径或执行命令作为请求字段。
- goal、问题和 ID 必须是非空文本；沿用既有文本长度限制。
- user_context 必须是合法 JSON 对象，拒绝 NaN、Infinity、非 JSON 类型。请求总字节限制与现有入口保持一致。
- evidenceLimit 是 1–12 的真正整数；Python 中不能接受 `True` 充当整数 1。
- 本次请求允许 1–10 个 Query，必须为非空、有界的单行关键词；不接受 URL、命令选项、控制字符或规范化后的重复 Query。沿用已有更严格的搜索输入规则。
- 单请求不要求至少 6 条 Query；6–10 的限制属于首次 Baseline 全轮问题合集。
- relevantUserConditions 是字符串列表；freshness 存在时必须为有界非空字符串。
- 不猜测一个不存在的知乎日期过滤参数。若底层无法兑现 freshness，明确记录约束未落实及 unresolvedQuestions，不声称满足时效要求。

### 3.3 Python research 的 data

保留既有外层：`protocol_version / run_id / action / ok / data / error / metrics`。

本次新增的研究成功／部分成功 data：

```ts
interface ResearchIssue {
  code: string;                 // 程序白名单，不透传原始异常
  stage: "search" | "normalize" | "rank" | "compile" | "coverage";
  queryIndex?: number;          // 从 0 开始，与本次 searchQueries 对应
  sourceId?: string;
}

interface M2ResearchData {
  requestId: string;
  status: "ok" | "no_evidence" | "partial";
  compilerOutputs: ZhihuEvidenceCompilerOutput[];
  routeCandidates: RouteCandidate[];  // 本次 M2 证据阶段固定 []
  unresolvedQuestions: string[];
  issues: ResearchIssue[];
}
```

`compilerOutputs` 必须保留每次编译的完整 source／reason／evidence_cards，而不是只返回卡片数组。正常 `no_evidence` 的 compiler 输出也保留，以解释为什么没采用来源。

metrics 至少记录本次真实的 `search_calls_attempted`、`compiler_calls_attempted`、`candidate_count`、`evidence_count`。不要把尝试次数当成计费次数，不掌握 token usage 时不要编造。

### 3.4 Server 返回类型

Node 校验 compiler 输出后，逐项调用已有 adapter，稳定去重、检查卡片数量和 ID 冲突，然后组装共享 EvidencePack：

```ts
interface EvidencePack {
  requestId: string;
  evidence: EvidenceCard[];
  routeCandidates: RouteCandidate[];
  unresolvedQuestions: string[];
}

interface ResearchProviderResult {
  runId: string;
  status: "ok" | "no_evidence" | "partial";
  pack: EvidencePack;
  issues: ResearchIssue[];
  metrics: Record<string, number>;
}
```

这些执行状态不能仅因 EvidencePack 没有 status 字段就丢弃。将 ResearchProviderResult 放在 Server 的本地类型中即可，不为了本次接入强改共享 EvidencePack。

原始 compilerOutputs 只用于 Python → Server 边界；新 HTTP 接口返回校验后的 pack，不向浏览器额外发送全部原始摘要、内部路径和调试日志。

## 4. Planner 兼容策略：不破坏已有通用入口

Jia 参考校验要求 1–3 个研究问题，全部问题合计 6–10 条不重复 Query。用户原有 Planner 是最多 3 个问题、每题最多 2 条，不保证达到 6 条。

采用 opt-in 的首次 Baseline 模式，而不是让通用 Planner 所有调用突然都必须输出 3 个问题：

```text
python -X utf8 -u -m zhihu_m2.pipeline --action plan --planning-profile jia-p0-baseline
```

`--planning-profile` 是本次新增参数；默认行为仍兼容原有 plan。若当前代码已有等价模式，复用它而不新增同义配置。

实现规则：

1. Baseline 模式信息充分时要求 3 个有效研究问题，每题 2 条独立 Query，合计 6 条；同时写入提示词和输出校验。
2. 只设置 max_questions=3 和 queries_per_question=2 不算完成，因为这只是上限。
3. 保留通用模式 1–3 问题的既有能力；旧 retrieval 的整计划入口仍可用。
4. 信息不足时保留 `needs_clarification`，不凑问题；模型违反数量／结构时返回明确校验错误，不伪装成成功。
5. 每次 Planner 调用仍默认最多一次模型调用，不添加自动补问、自动修复或重试循环。
6. 不把 `human_approved`、`coverage_verified` 或 `semantic_quality_checked` 偷改成 true。
7. Server 转换且只转换：research_question → question；queries → searchQueries；why_needed → rationale。
8. 对转换结果做运行时类型检查，再调用 Jia 原有 validateResearchQuestionDrafts；合法后由 assembleResearchRequests 分配外部 ID。
9. `needs_clarification` 与传输错误分开处理，此时不组装请求、不启动研究。
10. 明确拒绝与 action 不兼容的参数组合，保持 stdout 协议和退出码一致。

## 5. 单请求执行器的行为

建议新增包内 `research_runner.py`，公开接口：

```python
def validate_research_input(payload: dict) -> dict:
    """Validate and return a defensive copy. No I/O or model calls."""


def run_research(payload: dict, *, dependencies=None, limits=None, metrics=None) -> dict:
    """Execute one validated request; return M2ResearchData or raise a typed error."""
```

上述函数为本次拟新增接口。dependencies 用于注入搜索、排序、编译和时钟边界，limits 为服务端配置，不接受前端任意扩大。可用 dataclass／Protocol 落实，不引入新的大型框架。metrics 是 pipeline 传入的本次运行计数容器，执行器只按实际尝试更新它；调用预算也从这里核对，不能通过请求 JSON 传入或覆盖计数。

### 5.1 复用链路

按顺序：校验 → 给每条 Query 建立追踪 → 现有搜索底层 → 现有 normalization／去重 → 现有 ranker → 现有 compile_evidence → 汇总。

优先复用当前安全版本的底层搜索函数。例如参考 `plan_retrieval.search_once()` 返回完整响应且保留原始换行。不要为了复用 `retrieve_plan()`，伪造 goal 范围的大计划、绕过它的哈希校验，或者让每个请求重新执行全轮搜索。

不要改写 ranker 的评分策略。需要共享原来的内部 helper 时只做小范围提取，并用回归测试保证原有行为。

### 5.2 原始来源与去重

排名可基于清洗后的文本副本，但编译器必须接收原始来源文本。不能把去标签、换标点、空白归一化后的内容当成原始 snippet。

同来源在两个 Query 中重复出现，应稳定合并召回记录；保留 query → source 的追踪关系。相同来源的不同 snippet 变体不能拼接成伪造原文；选用确定的原始变体并保留其来源、hash 和时间。

跨请求缓存编译结果时必须考虑 goal、user_context、research question、source identity、snippet hash 和 compiler version；不要只按 URL 缓存并将另一个问题的卡片直接拿来用。本次不要求重建全新缓存系统。

相同卡片 ID 与相同内容重复时可稳定去重；同 ID 不同内容必须暴露冲突，不能覆盖其中一份。

### 5.3 证据限额与调用预算

evidenceLimit 是本请求最终有效卡片的上限，不是搜索条数，也不是必须凑满的数量。

沿当前 ranker 的顺序尝试编译，遇到正常 no_evidence 可继续下一来源，直到达到卡片上限、候选耗尽或服务端预算截止。不要仅对前 evidenceLimit 个来源编译后就假定足够。

本任务建议的初始运行配置：每 Query 请求 5 条，单请求最多 8 次 compiler 调用，Python 单请求总 deadline 600 秒，Node 等待上限 630 秒。它们是本任务的可配置默认值，不是知乎或模型的官方限额；有现有更合理设置时沿用并记录。单次搜索／模型还要有自身 timeout，不能只靠外层强杀。

同一请求默认顺序执行，不新增无限并发或隐含重试。达到 evidenceLimit 是正常完成；预算耗尽且仍有未评估来源则必须提示覆盖不完整。

### 5.4 状态真值表

| 情况 | pipeline ok | data.status／error | 行为 |
|---|---|---|---|
| 正常执行，获得有效卡片，无未处理执行失败 | true | ok | 返回卡片，不宣称事实被验证 |
| 搜索正常结束，候选耗尽，无适用证据且无执行失败 | true | no_evidence | 明确原因；不补造卡片 |
| 部分 Query／来源失败，其他评估完成，或预算截止导致覆盖不完整 | true | partial | 返回已得到结果及 issues；证据可为 0 |
| 全部搜索都执行失败 | false | research_failed | 非零退出，不伪装空证据 |
| 所有实际尝试的 compiler 调用都执行失败 | false | compilation_failed | 非零退出，不伪装 no_evidence |
| 无效输入／缺依赖／不可继续的鉴权或配置失败 | false | 对应白名单错误 | 立即停止后续付费工作 |
| 出现不允许继续的内部异常、整体超时或中断 | false | 对应白名单错误 | 不返回伪成功；已完成产物只作本地诊断 |

正常 no_evidence 不是 compiler 执行失败。已成功检索但拿不到卡片，也不证明“知乎不存在答案”。未独立验证、只来自搜索摘要等证据限制，放在卡片风险中；它们不等同于进程 partial 状态。

issues 只输出白名单 code 和安全定位信息。unresolvedQuestions 使用受控说明，不拼接异常、请求头、原始上游错误 body。

### 5.5 错误、落盘和隐私

扩展 pipeline 的错误注册与对应测试；如当前 EntryError 从白名单字典取 message，新错误必须同时注册，不能在异常处理里再 KeyError。

保持一次进程一个 UTF-8 JSON 文档；库里的 print／日志隔离到 stderr。保持现有重复 JSON key、非有限数、BOM、大小限制、独立输出文件和原子写入保障。

Server 调用走 stdin/stdout，不依赖共享 `latest.json`；并发运行的文件使用唯一 run_id。失败后不得读取上一次 artifacts 文件当成本次输出。

不要在公共日志写 secrets、Authorization、完整环境、用户全部背景、原始模型响应或原始异常。原始材料如需审计只能写入明确被忽略的本地 artifacts。检查 `.gitignore`，不要静默修改用户已跟踪文件或自动从索引移除它们。

检索文本和模型输出都按不可信数据处理。原文中的“执行命令”“读取密钥”等内容不得变成工具指令。

## 6. Server Provider 与独立证据接口

### 6.1 建议的最小文件边界

```text
apps/server/src/zhihu-provider.ts             # Python 进程调用、配置、超时
apps/server/src/zhihu-provider.test.ts
apps/server/src/zhihu-boundary.ts             # unknown 的校验、Planner 映射、研究 pack 组装
apps/server/src/zhihu-boundary.test.ts
apps/server/src/zhihu-adapter.ts              # 原有卡片映射尽量不改
apps/server/src/zhihu-adapter.test.ts          # 补回归场景
apps/server/src/index.ts                      # 只接小范围 HTTP route
apps/server/src/index.test.ts
```

已有同职责文件时扩展原实现；避免出现两个 Provider 或两个 adapter。下面为本次公开给 Jia 的服务端函数约定，参数类型在 Server 本地定义并导出：

```ts
interface M2ResearchInput {
  goal: string;
  user_context: Record<string, unknown>;
  request: ResearchRequest;
}

interface BaselinePlanningResult {
  status: "ready_for_review" | "needs_clarification";
  questions: ResearchQuestionDraft[];
  clarificationQuestions: string[];
}

interface ZhihuProvider {
  planForBaseline(input: {
    goal: string;
    user_context: Record<string, unknown>;
  }): Promise<BaselinePlanningResult>;
  researchOne(input: M2ResearchInput): Promise<ResearchProviderResult>;
}
```

公开 factory 为 `createZhihuProvider(config)`。测试允许注入底层进程执行边界，但生产环境不能通过 HTTP 切换 executable、module 或 test fixture。如已有等价公开命名，保留并在交接文档列明精确签名。

### 6.2 子进程调用要求

使用 spawn 的参数数组启动明确的 Python 解释器：

```text
<python executable> -X utf8 -u -m zhihu_m2.pipeline --action plan|research
```

planForBaseline 额外加 `--planning-profile jia-p0-baseline`。action 只取程序白名单，输入 JSON 写 stdin 并关闭输入。不得用 exec 拼接字符串，不启用 shell，不将 query、密钥、解释器路径从用户 JSON 拼进命令。

明确配置 cwd、解释器和环境。`src` 布局需使用项目现有安装方式使模块可导入，不能只改 cwd 后假定可运行。不要通过在源码里硬编码 Kylee 的路径解决导入。

累计完整 stdout，等待 close 后再解析。处理中文／emoji 横跨数据 chunk；使用 Buffer 合并后解码或正确的增量解码。不要对每个 chunk 单独 JSON.parse。

处理启动失败、stdin EPIPE、非零退出、被信号结束、超时、非法 JSON、协议版本／action 不匹配、ok 字段非法及错误结构不一致。stderr 有日志不等于失败。

给 stdout 设 2 MiB 上限，stderr 设 64 KiB 上限作为本次初始配置；spawn 需要自己计数，不能假定有 exec 的 maxBuffer 行为。达到上限终止并返回可识别错误。所有完成路径都清理 timer、监听器与进程，防止 Promise 重复 settle。

Python 可能启动知乎 CLI 子进程。取消或 timeout 时检查子进程树清理，不能只认为 kill Python 就一定停止 CLI。实现与当前系统兼容的受控清理；系统命令的参数只能来自可信 PID，不拼接用户内容。若仅能验证某个平台，报告其他平台未验证，不能声称跨平台已经通过。

### 6.3 unknown → 运行时校验 → adapter

不要只写 `JSON.parse(...) as EvidencePack`。

校验顶层协议、action、ok、error、run_id、metrics，再校验 data 和每个 compiler 输出的必填字段、枚举、数组以及长度。额外要求：

- `status=no_evidence` 必须无卡片；当前单来源 `status=ok` 恰好一张。
- source/provider/url/source_scope 与卡片来源必须一致。
- HTTPS 知乎 URL 沿当前 compiler 规则校验，不扩大为任意链接；不从传来的 URL 自动抓取资源。
- 引文是原始 snippet 的精确子串，offset 范围有效。
- Python offset 是 Unicode code point 索引；Node 复核时用代码点视角，不直接把 Python 下标用于 JS 字符串 slice。测试在引文前放 emoji 和 CRLF。
- source.retrievedAt 为 null 时保留“未知”的含义，不能用当前时间伪造为已知。
- `verification_status` 不提升为 verified；保留 `search_snippet_only`、`not_independently_verified`、`semantic_support_not_checked`。
- 有效卡片去重后数量不得超过 request.evidenceLimit；异常超量应拒绝而不是静默截断，避免掩盖 Python 违约。
- requestId 必须匹配；status 和 issues 不得在 pack 组装时丢失。

### 6.4 Server 从项目取得上下文

新增内部 helper `buildM2Context(plan)`，从已确认的 `plan.goalContract` 和 `plan.userContext` 选取 goal、currentSituation、weeklyHours、constraints、successCriteria 等必要信息，映射为 Python 接受的值。

未确认目标／背景时，在网络调用前返回研究前置条件错误。不能把传入的任意新 goal 或另一项目背景当作当前项目用户事实。

沿 Planner／compiler 实际长度限制构造有界 context，不直接传整份 Plan、所有节点或最长 100,000 字符的背景材料。优先保留明确的限制与成功标准；长背景如不能在本轮安全纳入，明确发出说明，不静默丢弃关键约束或让 LLM 补猜事实。

### 6.5 本次新增的独立 HTTP 接口

新增：

```text
POST /api/projects/:projectId/research/live/evidence
```

它是“执行一个研究请求并返回证据”的接口，不是 BaselineProposal 接口，不替换 `/research/mock`。

HTTP body 为：

```json
{
  "request": {
    "id": "rq-integration-001",
    "question": "初学者怎样为 Agent 项目编写基本测试？",
    "searchQueries": ["Agent 项目 初学者 自动化测试", "Python Agent 项目 验收 调试"],
    "relevantUserConditions": ["Python 初学者", "每周可投入10小时"],
    "evidenceLimit": 4
  }
}
```

Server 验证项目、确认状态和输入，读取自身保存的 goal/context，然后调用 researchOne。单请求 body 不接受整份用户目标覆盖或服务配置覆盖。这个入口收到的是 Controller 选定的问题，校验通过不等于自动标记人类已审核。

成功、no_evidence、partial 均返回 HTTP 200 和 `{ "ok": true, "result": ResearchProviderResult }`，调用方必须读取 result.status。配置关闭返回 503；无效输入返回 400；未确认上下文或同项目研究忙返回 409；上游协议／执行失败返回 502；整体 timeout 返回 504。若现有 Server 有统一错误约定，复用其外层形状并保持这些可区分语义。不存在的项目沿现有 404 行为。

本接口同步等待本轮受控研究，不返回一个没有 worker 支撑的“已接受后台任务”。不要在此任务引入队列服务。

默认 `ZHIHU_LIVE_ENABLED=false`。启用仅用于明确配置的本地／受控 Server；沿用现有权限和跨域限制，不暴露不受控的公网付费接口。同项目只允许一个执行中的 live 请求，重复触发返回 busy，不新增无限并行工作。

无论成功、no_evidence、partial、异常或超时，都不写正式 Plan／Commit，不移除已有 pending proposal。失败时也不能回退到 Mock。

### 6.6 配置和 .env

优先沿用项目已有命名和 dotenv loader。没有等价字段时新增以下非密钥配置并在 `.env.example` 说明作用域：

```text
ZHIHU_PYTHON_BIN
ZHIHU_PYTHON_CWD
ZHIHU_LIVE_ENABLED
ZHIHU_TIMEOUT_MS
```

Python 和 Node 是不同进程：不能假定 Python 的 dotenv 已经替 Node 加载解释器路径。明确 Node 配置从何加载，Python 的 config.load_local_env 从何加载；现有环境变量优先于文件，路径不依赖启动时偶然的 cwd。

模型继续使用当前 llm_client 的配置；用户此前选定模型为 `deepseek-v4-pro`。不得自行换模型，也不得从模型名猜官方／第三方 endpoint。凭据来源与 API base URL 以本地真实配置为准。

使用当前知乎授权路径及安全初始化工具，不假定复制 `.env` 就完成 CLI keychain 授权。没有确认当前 CLI 支持某个参数前不要发明该参数。不得在命令参数里放 secret。

`.env`、真实 artifacts、个人路径、密钥不得写入 Git；不把任何 secret 放到 `VITE_*`、React 或前端请求 body。不可将整份 process.env 或 .env 内容打印到终端。配置诊断只显示是否存在以及安全的非秘密设置。

## 7. 分任务实施和测试优先顺序

每个任务都按“先增加失败测试 → 实际观察失败 → 最小实现 → 实际观察通过 → 回归”的顺序执行。不要跳过失败阶段，也不要把旧有失败算成本次引入而随意删测试。

### Task 0：建立基线和定位结果

**文件：**只读工作区、现有测试、Contracts；创建 `packages/zhihu/docs/P0_INTEGRATION_STATUS.md`。

- [ ] 记录 HEAD、分支、原有改动、真实 Python 包路径、解释器、Node/pnpm 版本和实际测试命令。
- [ ] 运行当前 Python 测试与相关 TS 测试；缺环境时区分收集失败、依赖缺失与逻辑失败。
- [ ] 记录 adapter、研究入口、live 路由的实际有无，不引用旧报告当成本次结果。
- [ ] 把当前文件到下列任务的映射写到报告中，继续实施。

### Task 1：冻结新研究边界与 fixtures

**文件：**包内 `research_runner.py`、`tests/test_research_runner.py`、共享的离线 JSON fixtures、Server 的 `zhihu-boundary.ts` 与测试。

- [ ] 先写有效输入保留和非法输入零调用测试。
- [ ] 实现 validate_research_input，以及 Server unknown 校验的必要基础。
- [ ] 保存与生产形状一致但明确标记为 synthetic/offline 的 fixtures。
- [ ] 验证坏输入在搜索、LLM、写盘之前被拒绝。

最低测试代码语义如下；配套输入 fixture 由测试复制，不原地修改：

```python
import copy
import pytest
from zhihu_m2.research_runner import validate_research_input


def test_valid_input_is_preserved(research_input):
    before = copy.deepcopy(research_input)
    checked = validate_research_input(research_input)
    assert checked == before
    assert research_input == before
    assert checked is not research_input


@pytest.mark.parametrize("bad_limit", [0, 13, True, 1.5, "4", None])
def test_invalid_evidence_limit(research_input, bad_limit):
    payload = copy.deepcopy(research_input)
    payload["request"]["evidenceLimit"] = bad_limit
    with pytest.raises(ValueError):
        validate_research_input(payload)
```

若项目使用专用 ValueError 子类，保持测试能精确匹配允许的校验异常，不能 `except Exception` 视作测试通过。

### Task 2：新增 Baseline Planner profile

**文件：**query_planner.py、pipeline.py 及其现有测试；Server `zhihu-boundary` 的 Planner 映射测试。

- [ ] 新 profile：2×2 的模型输出必须失败；3×2 通过；跨问题重复 Query 失败；澄清正常返回且研究调用数为 0。
- [ ] 原通用模式保留现有较少问题测试；不是删除旧测试来满足新 profile。
- [ ] 对新 profile 修改提示词并增加强校验，不自动第二次调用模型。
- [ ] 同一规划 fixture 转成 Draft 后实际调用原始 validateResearchQuestionDrafts 与 assembleResearchRequests。

### Task 3：单请求研究与错误分类

**文件：**research_runner.py、必要的已有底层 helper、小范围 normalization 复用、测试。

- [ ] 写测试证明只使用本次请求的 Query，且 Planner 调用数严格为 0。
- [ ] 实现来源去重、原文保护、排序和有界编译循环。
- [ ] 覆盖正常有证据、正常无证据、部分失败、全失败、全部编译失败、预算截止及停止条件。
- [ ] 测试重复来源不会无理由反复编译；同 URL 不同请求不会误用不相关缓存。
- [ ] 验证请求 ID、引文原文、真实时间、风险标签和 evidenceLimit 全部保留。

### Task 4：接通 pipeline research

**文件：**pipeline.py、入口 CLI 测试。

- [ ] research_not_connected 的旧占位测试改为有效研究、边界失败和异常脱敏测试；不是取消 research 的测试覆盖。
- [ ] 有效 stdin、--input、--output 与现有协议兼容；`--help` 不需要密钥，不触发研究。
- [ ] stdout 噪声、非零退出、中文、重复 key、非法非有限数、过大输入、输出写失败等测试保留。
- [ ] 输出文件失败时明确“可能已发生调用”，不自动重试；旧文件不能被认作本轮成功。

### Task 5：Node Provider 和跨语言验证

**文件：**zhihu-provider、zhihu-boundary、adapter 测试、测试专用子进程 fixture。

- [ ] 先用真实小型测试子进程模拟 split stdout、stderr 日志、非零退出、EPIPE、挂起和超量输出。
- [ ] 实现生产 spawn 调用、限制、超时清理、校验及 pack 汇总。
- [ ] malformed JSON、action/version 错误、requestId 错误、缺字段、invalid enum、伪造 quote 和卡片超限均被拒绝。
- [ ] 测试 emoji 在 quote 之前、CRLF 原文、null retrieval time、ID 冲突和风险标签保留。
- [ ] 至少一个跨语言测试由真实 Python validator／compiler 逻辑在离线模型边界下生成输出，再交给真实 TS boundary 和 adapter；不能两边各手写一份永不碰面的假 schema。

### Task 6：HTTP 单请求证据接口

**文件：**Server index.ts、index.test.ts；不改用户正式数据。

- [ ] 功能关闭、项目不存在、未确认上下文、非法 request、busy、成功、no_evidence、partial、错误与 timeout 均有测试。
- [ ] 验证 Server 用保存的项目上下文，不接受 body 覆盖 goal 或配置。
- [ ] 调用前后比较 Plan、version、currentCommitId、History、pending proposals；所有情况都不变化。
- [ ] 网络调用失败后 busy 锁释放，且不隐式回退 Mock。
- [ ] 既有 mock research、用户确认 baseline/apply、计划修改和导出回归仍通过。

### Task 7：配置、真实 smoke 与交接

**文件：**README、`.env.example`、`examples/entry_research_request.json`、`scripts/smoke_zhihu_provider.ts`、状态与交接文档。

- [ ] 脚本默认不会在普通测试启动时自动联网；真实调用采用显式命令。
- [ ] 在可用的已配置环境执行一次受控真实 smoke，优先通过 Server Provider 或独立 HTTP route，验证实际 Python 解释器与授权链。
- [ ] 当前任务已允许使用现有知乎／模型凭据进行范围内真实调用，不因 token 成本反复询问，也不强制先反复 dry-run。平台权限照常遵守。
- [ ] 初次 smoke 最多 1 次 Planner（如需要）、1 个研究请求、2 次 Query 搜索、3 次 compiler 调用；可以单独降低 smoke 的结果上限与调用预算。不是要求必须花完预算。
- [ ] 不因“没有拿到卡片”盲目重跑。正常 no_evidence 应如实记录，排查是否有真实执行而非伪造成功。
- [ ] 缺凭据、CLI、模型配置、网络或平台能力时，继续完成离线工作，精确记录真实 smoke 被哪一步阻塞；不要求用户把 key 粘到聊天。
- [ ] 不对用户现有正式项目自动调用 baseline/apply；测试数据使用临时存储或明确的新测试项目。

## 8. 离线测试矩阵：完成时逐项打勾

### Python

- [ ] 只执行 request.searchQueries，Planner 0 次。
- [ ] requestId 原样透传，无输入原地修改。
- [ ] 1–12 evidenceLimit；bool／小数／字符串被拒绝。
- [ ] 正常 no_evidence 与失败严格区分。
- [ ] partial 带 issues；全失败非零退出。
- [ ] 卡片上限与调用预算分别生效。
- [ ] 原始 snippet、quote 和 offsets 不被改写。
- [ ] 去重稳定，snippet 变体不拼接，ID 冲突可见。
- [ ] 无效输入零网络调用；无隐藏重试。
- [ ] stdout 单文档、stderr 可有日志、异常脱敏。
- [ ] 普通 pytest 不读取真实凭据、不意外联网。

### TypeScript／进程

- [ ] 完整 stdout 解析、中文跨 chunk、close 后处理。
- [ ] stderr 非空成功；启动失败、超时、EPIPE、缓冲上限可分类。
- [ ] requestId/action/version 不匹配被拒绝。
- [ ] adapter 的来源、风险、适用条件和作者字段保留。
- [ ] Python 代码点 offsets 与 JS Unicode 正确衔接。
- [ ] no_evidence、partial、issues 未在 pack 层丢弃。
- [ ] 同一离线 Python 输出通过真实 TS 校验，坏 fixture 被拒绝。
- [ ] 子进程清理及支持的平台得到实际验证；不支持的环境明确标注。

### Server／回归

- [ ] 独立证据接口真实调用 Provider，而不是只返回 fixture。
- [ ] live 默认关闭，错误不回退 Mock。
- [ ] 上下文取自项目；重复触发受控。
- [ ] 研究不会改变正式 Plan／History／pending proposal。
- [ ] 原 mock 与 baseline/apply 流程仍能运行。

## 9. 实际测试命令与 Windows 使用说明

先查看当前 package.json 的 scripts，然后执行真实存在的命令。Jia 参考快照中的命令是：

```powershell
# 从 zhilu 根目录
pnpm --filter @zhilu/contracts typecheck
pnpm --filter @zhilu/agent-runtime test
pnpm --filter @zhilu/server test
pnpm typecheck
pnpm test
pnpm build
```

Python 使用已确认的解释器，在实际包工作目录执行：

```powershell
python -m pytest -q
python -X utf8 -u -m zhihu_m2.pipeline --help
```

若原来的 pytest 会在默认收集范围里触发付费请求，先按项目现有方式隔离 live tests，不能仅为跑全绿而意外使用真实凭据。

README 需要给出可复现的本机步骤，而不是留一句“配置好环境即可”。必须说明：工作目录、解释器路径选择、依赖安装入口、Python .env 与 Server 环境的差别、CLI 授权检查方式、启用 live 的配置、启动 Server、发送一个请求及检查返回状态的方法。

`python -m pip install -e .` 只有在当前包确实支持 editable install 时才提供；否则沿现有依赖与导入方案，不凭空生成迁移。

Python research 示例命令在实现后应类似：

```powershell
python -X utf8 -u -m zhihu_m2.pipeline `
    --action research `
    --input .\examples\entry_research_request.json `
    --output .\artifacts\entry_research_smoke.json

if ($LASTEXITCODE -ne 0) {
    throw "研究入口失败。不要把旧 artifacts 文件当成本次成功结果。"
}
```

运行后还必须检查新响应的 ok、data.status、requestId 和调用次数，不只看退出码。

提供直接经过 Node Provider 的 smoke 命令；若脚本新增在 Server scripts 下，可在确认 tsx 可用后通过该 workspace 的 package script 启动。交付最终真实的命令与路径，不要求用户自行猜 npm script 名称。

## 10. 给 Jia 的交接内容与完整 Live Roadmap 的边界

新增 `packages/zhihu/docs/P0_JIA_HANDOFF.md`，内容至少包含：

- 实际 Provider 导出签名、请求样例、返回样例和状态／错误语义。
- planForBaseline → Draft → assembleResearchRequests → researchOne 的调用次序。
- 从已确认项目读取的背景映射、ID 对应、卡片上限和已有 adapter 的使用方法。
- 新证据接口路径、开关、超时与环境需求。
- routes 固定为空是本阶段的职责边界，不是已经生成正式 Baseline。
- 真实运行是否验证、运行了多少次、未覆盖什么。

给 Jia 的调用示意仅展示数据流，实际版本使用当前源码签名：

```text
从已确认 Plan 取得 goal/context
→ provider.planForBaseline(...)
→ 若 needs_clarification，展示问题并停止本轮研究
→ 验证 Draft，用 assembleResearchRequests 分配 ID
→ 对选定的每个 request 调用 provider.researchOne(...)
→ 保留 status、issues 和每个 EvidencePack
→ runtime 综合 RouteCandidate 与 BaselineProposal
→ engine 校验预览
→ 保存 pending proposal，等待用户 baseline/apply
```

最后几步若当前没有真实实现，不得在本次接入里调用 createMockBaselineProposal 并把 mode 改成 live，也不得按 route-outcome／route-foundation 这样的固定 ID 选择模板。

未来完整 live 路线必须检查：每个 route/task 的 evidenceIds 存在、推断明确标注、不强凑两条路线、不把 `unverified` 变 `verified`、预览不直接写正式 Plan、用户确认时再次检查 baseVersion。新的 live proposal 生成失败时，不应提前删除已有待确认提案。

用户的 M2 对接代码与 Jia 未来的路线综合修改应能独立评审，不要把未实现的路线能力藏在“全部完成”的报告里。

## 11. 最终交付格式与停止规则

完成后中文汇报，必须含：

1. 改了哪些文件，每个文件解决什么问题；区分本次新增与用户原有改动。
2. 新增／保留的接口、完整输入输出示例、状态真值表和配置说明。
3. 实际运行的测试命令、退出状态、passed／failed／skipped 数量；与原有失败区分。
4. 真实 smoke 的调用次数、成功／无证据／失败结果，是否验证 Windows／Node／CLI／LLM。
5. 用户下一条可直接执行的 PowerShell 或 pnpm 命令。
6. Jia 下一步具体调用哪个导出函数、还有哪些 runtime／UI 工作不在本次完成范围。
7. 结束时的 git status；确认未自动 commit、push 或覆盖用户数据。

可提交的 synthetic fixtures 与代码可以列入建议文件清单；包含用户背景、真实搜索全文或本地信息的 artifacts 不自动加入 Git。

若遇到阻塞，报告“在哪个文件／函数／测试、期望和实际分别是什么、已验证到哪一层”，继续其他独立工作。不因为任务较大就只写方案，也不为给出绿色结果而删除测试、放宽 shared validator 或伪造线上响应。

最终验收分两层明确写：

- **本次目标：M2／Server 单请求真实证据接入。** 必须有对应执行证据，缺少 live 条件时写“离线完成，真实联调未验证”。
- **完整产品：真实证据驱动路线 → 预览 → 用户确认 → 正式版本。** 本次没有实现与验证就明确写“尚未完成”，不要混淆。

## 12. 参考资料

项目事实参考用户上传的 Jia P0 源码，详见配套 `REFERENCE_SOURCE_EXCERPTS.md`；Python 细节最终以当前工作区 pipeline、query_planner、plan_retrieval、evidence_compiler 和测试为准。配套 JSON 只用于离线契约样例，不是线上响应。

实施时按当前运行版本核对子进程语义。官方参考：

```text
https://nodejs.org/api/child_process.html
https://openai.com/index/unrolling-the-codex-agent-loop/
```

这份文件是实施指令，不是已修改代码或已通过测试的证明。
