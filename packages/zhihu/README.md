# Zhihu Knowledge

## 2026-09-12 新分工：首轮预算、批量证据、缓存

生产默认已更新为 `ZHIHU_RETRIEVAL_PROFILE=batch-v1`；Server Planner 默认 `m2-initial`，全轮总计 2–3 条查询。研究仅执行本次请求，用一次模型批量分级/编译替换固定权重与逐篇调用，继续重用原 compiler 校验和 TS adapter。新增覆盖报告、带引用的研究假设、本地缓存与显式补充规划；不生成或批准正式 Roadmap。

完整接口、Jia 调用方式、预算、回退、真实配额阻塞记录见 [新分工实施与交接](../../docs/M2_FOLLOWUP_STATUS_2026-09-12.md)。现有 HTTP 接口保持不变且默认关闭。真实批量质量和来源分歧仍为 `needs_human_review`。

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
# 仅验证编程／写作的 Provider → Python 批量 → adapter，完全离线
node .\node_modules\tsx\dist\cli.mjs .\apps\server\scripts\test_m2_followup.ts
```

## Retrieval V3：保留的本地实验与回退

旧 `legacy` / `v3` 通过本地配置显式选择，已不是生产默认。`v3` 保留同一来源的各 Query 原始片段，以原始结果名次计算 RRF，按问题需要选择一个原始 variant，再根据**已经产出卡片**的来源做软多样性选择；不会追加搜索或调用研究 Planner。分数只用于优先级，不是事实可信度。旧阶段 B 的额外第二次 LLM 重排未实现；新生产路径用一次批量调用替换逐篇编译。

两种模式共用 `run_research`、compiler、Server Provider 和原 adapter；请求和 EvidencePack 不变。`planning_profile=baseline` 控制首次 Baseline 数量，`ZHIHU_RETRIEVAL_PROFILE` 控制本地检索/提示词策略，两者独立。配置无效会安全失败，HTTP body 不能选择 profile。Python 从进程环境或固定的本目录 `.env` 读取；Node 启动时继承环境，重启后才作用于新子进程。不得将此配置或密钥写进 `VITE_*`。

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
$py = (Resolve-Path .\.venv\Scripts\python.exe).Path
# 下一条可直接执行的离线对照：0 次搜索、0 次模型调用
& $py -B .\packages\zhihu\scripts\evaluate_retrieval.py `
  --case-file .\packages\zhihu\tests\fixtures\retrieval_v3\synthetic_cases.json `
  --profiles legacy v3 --offline `
  --output .\packages\zhihu\artifacts\retrieval-v3-synthetic.json
if ($LASTEXITCODE -ne 0) { throw '离线评测失败' }
```

输出含 `legacy`、`v3_no_diversity`、`selection_simulation` 三组。最后一组只是排序模拟，不能冒充实际编译后接受卡片的选择。12 个合成案例仅是工程回归。真实数据必须按 `source_id@variant_key` 人工标注，未标注指标为 null、状态为 `needs_human_review`；共同已标注题目的比较见 `paired_summary`。运行证据与标注格式见 [RETRIEVAL_V3_EVALUATION.md](docs/RETRIEVAL_V3_EVALUATION.md)，实施与交接见 [RETRIEVAL_V3_STATUS.md](docs/RETRIEVAL_V3_STATUS.md)。

普通回归不联网，pytest 禁用个人 dotenv/凭据并固定 legacy；测试中显式注入 v3：

```powershell
Push-Location .\packages\zhihu
try {
    & $py -B -m pytest -q
    if ($LASTEXITCODE -ne 0) { throw 'Python 测试失败' }
} finally { Pop-Location }
.\node_modules\.bin\vitest.cmd run
if ($LASTEXITCODE -ne 0) { throw 'TypeScript 测试失败' }
# 使用已有 pnpm 10.30.2；不要因当前 PATH 指向其他版本而重装依赖
pnpm.cmd typecheck
pnpm.cmd build
```

显式真实评测以固定 12 题（8 开发、4 留出）采集一次候选池，两个 profile 复用快照。以下命令会使用现有凭据：同一个目录每阶段只能启动一次，锁和 ledger 阻止重跑或并行重置预算。错误不重试；不要删除 ledger/started 文件来绕过预算。目录不存在时可创建，禁止覆盖本次已运行结果：

```powershell
$run = '.\packages\zhihu\artifacts\retrieval-v3-new-run'
if (Test-Path $run) { throw '此目录已存在，请先阅读既有结果，不要重复调用' }
& $py -B .\packages\zhihu\scripts\run_retrieval_live_evaluation.py --live --phase capture --output-dir $run
if ($LASTEXITCODE -ne 0) { throw '采集失败，查看安全错误码，不自动重试' }
& $py -B .\packages\zhihu\scripts\evaluate_retrieval.py --case-file "$run\candidates.json" --profiles legacy v3 --offline --output "$run\ranking.json"
& $py -B .\packages\zhihu\scripts\run_retrieval_live_evaluation.py --live --phase compiler --output-dir $run
if ($LASTEXITCODE -ne 0) { throw '编译批次失败，停止并检查 ledger' }
& $py -B .\packages\zhihu\scripts\run_retrieval_live_evaluation.py --live --phase planner --output-dir $run
if ($LASTEXITCODE -ne 0) { throw 'Planner 批次失败，停止并检查 ledger' }
```

上限：采集 24 搜索（每题两 Query、每 Query count=5）；四个跨领域开发题的两个 profile 各最多 2 次编译/2 张卡，加三组合成提示词案例的双 profile 对照，合计最多 22 次编译（文档上限24）；Planner 四目标双 profile 最多8次，不执行其生成查询。实际发送的模型 messages 哈希在受控子进程内取得，不记录凭据或原始异常。`compiler-results.json` 中回放搜索计数是本地回放次数，真实付费/联网尝试以 ledger 为准。

V3 Provider 验收复用下文既有 smoke，只需在启动它的终端明确设置 profile；单次另加最多2搜索/3编译。切回 legacy 同样重启 Server，不能在另一个发 HTTP 的终端改变量后误认为服务已切换：

```powershell
$env:ZHIHU_RETRIEVAL_PROFILE = 'v3'
$env:ZHIHU_PYTHON_BIN = $py
$env:ZHIHU_PYTHON_CWD = (Resolve-Path .\packages\zhihu).Path
.\node_modules\.bin\tsx.cmd .\apps\server\scripts\smoke_zhihu_provider.ts --live
# 回退：从这个终端重新启动 Server。无需撤销代码或改正式项目状态。
$env:ZHIHU_RETRIEVAL_PROFILE = 'legacy'
```

现有 `POST /api/projects/:projectId/research/live/evidence`、`/research/mock`、Baseline/apply 接口保留。Jia 继续调用 `createZhihuProvider(config).researchOne(...)`，无需接新 adapter。真实证据接入、检索工程回归、人工质量提升、完整真实 Roadmap 是不同验收项；没有人审时不宣称质量门槛通过。

## P0 Server 真实证据接入

已实现 `createZhihuProvider(config).researchOne({goal,user_context,request})`，通过真实 Python pipeline 搜索、排序、编译，再由 Server 原有 adapter 产生共享 EvidencePack。`planForBaseline()` 使用首次 Baseline 专用 profile；通用 Planner 保留原行为。研究不会修改正式 Plan、History 或 pending proposal。完整真实 Roadmap 综合仍待 Jia 接入。

接口为 `POST /api/projects/:projectId/research/live/evidence`，默认关闭，body 只能包含 `request`；目标和背景从 Server 已确认项目读取。状态和完整样例见 [P0_JIA_HANDOFF.md](docs/P0_JIA_HANDOFF.md)，本次真实调用和测试证据见 [P0_INTEGRATION_STATUS.md](docs/P0_INTEGRATION_STATUS.md)。

### Windows PowerShell：当前工作区直接运行

以下命令从仓库根目录执行，不依赖激活状态。这里是普通包布局，没有 `src/` 或 editable install。

```powershell
$repo = (Get-Location).Path
$python = (Resolve-Path .venv/Scripts/python.exe).Path
& $python -B -c "import sys; print(sys.executable)"
Push-Location packages/zhihu
& $python -B -c "import zhihu_m2; print(zhihu_m2.__file__)"
& $python -B -m pytest -q
& $python -X utf8 -u -m zhihu_m2.pipeline --help
Pop-Location
.\node_modules\.bin\vitest.cmd run
.\node_modules\.bin\tsc.cmd --noEmit -p apps/server/tsconfig.json
```

新机器需先安装 Python、Node（本轮 Node 24）、pnpm 10.30.2，再执行 `pnpm install --frozen-lockfile`。Python 依赖现有入口为 `requirements-dotenv.txt`，HTTP 与测试使用 httpx/pytest：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r packages/zhihu/requirements-dotenv.txt httpx pytest
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
```

普通 pytest 默认禁用个人 dotenv 并清除测试进程中的模型/知乎凭据。跨语言测试也禁用 dotenv；真实服务均由离线替身替代。

### Python 与 Node 分别配置

Python 继续调用现有 `config.load_local_env()`，固定读取 `packages/zhihu/.env`，进程环境优先，支持 UTF-8 BOM，不插值；导入模块不会加载密钥。不要覆盖已有 `.env`：仅在文件不存在时复制本目录 `.env.example`。继续使用 `llm_client` 当前的 `deepseek-v4-pro` 和源码现有 endpoint，没有改模型或服务商。

知乎 CLI 使用现有 `get_cli_path()` 和本机已保存授权；`.env` 不等于完成 keychain 授权。若确需初始化，现有 `python -m zhihu_m2.setup_zhihu_auth` 会先检查本机 CLI 是否支持 `--secret-stdin`，只在支持时通过 stdin 写入。不要将密钥贴进终端参数、请求 JSON 或 `VITE_*`。本次成功联调复用了已有授权，没有重写授权。

Node 不会自动加载 Python `.env`，也不会自动加载 `apps/server/.env.example`。本机启动使用 PowerShell 环境变量；若用 Node 24 的 `--env-file`，必须明确指向自己创建的 Server 配置文件。下面只设置非秘密配置：

```powershell
# 从仓库根目录启动，默认只监听 127.0.0.1:8787
$env:ZHIHU_PYTHON_BIN = (Resolve-Path .venv/Scripts/python.exe).Path
$env:ZHIHU_PYTHON_CWD = (Resolve-Path packages/zhihu).Path
$env:ZHIHU_LIVE_ENABLED = 'true'
$env:ZHIHU_TIMEOUT_MS = '630000'
.\node_modules\.bin\tsx.cmd apps/server/src/index.ts
```

在另一个终端发送请求。将 `$projectId` 设为已经通过项目创建接口确认的项目 ID，不能用 body 覆盖 goal/context；此调用只取证据：

```powershell
$projectId = '你的已确认项目ID'
$body = Get-Content -Raw -Encoding UTF8 docs/fixtures/07_http_request_PROPOSED.json
$response = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/projects/$projectId/research/live/evidence" `
  -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
$response.result.status
$response.result.metrics
```

成功、无证据、部分失败都返回 200，必须读取 `result.status`。关闭为 503，坏输入 400，项目不存在 404，未确认背景/繁忙 409，上游失败 502，整体超时 504。错误不会回退 Mock。

### 受控真实 smoke 与 Python 单独调试

以下显式命令调用真实 Provider，一次最多 1 请求、2 搜索、3 编译、0 Planner，最终最多 2 张卡片；运行会使用现有凭据。只运行一次并检查结果，不因无证据反复重试。结果写入被忽略的唯一 artifacts 文件，终端仅显示状态/计数。**不带 `--live` 时只显示帮助，不联网。**

```powershell
$env:ZHIHU_PYTHON_BIN = (Resolve-Path .venv/Scripts/python.exe).Path
$env:ZHIHU_PYTHON_CWD = (Resolve-Path packages/zhihu).Path
.\node_modules\.bin\tsx.cmd apps/server/scripts/smoke_zhihu_provider.ts --live
# 等价：pnpm --filter @zhilu/server smoke:zhihu --live
```

Python 单独调试采用文档新包装，且不会调用 Planner：

```powershell
Push-Location packages/zhihu
& ..\..\.venv\Scripts\python.exe -X utf8 -u -m zhihu_m2.pipeline --action research `
  --input .\examples\entry_research_request.json --output .\artifacts\entry_research_smoke.json
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '研究失败；不要把旧 artifacts 当成本轮输出，也不要盲目重试。' }
$result = Get-Content -Raw -Encoding UTF8 .\artifacts\entry_research_smoke.json | ConvertFrom-Json
$result.ok
$result.data.status
$result.data.requestId
$result.metrics
Pop-Location
```

普通预算：每 Query 搜索 5 条、最多 8 次 compiler；Python 默认600秒总预算，搜索单次最多90秒，生产编译在独立可终止进程内运行，最多等待本请求剩余wall-clock时间，超时后终止并回收（最多额外2秒清理等待）。LLM内部仍沿用60秒网络timeout，Node630秒作为外层截止。Python可配置 `ZHIHU_SEARCH_LIMIT_PER_QUERY`（1–10）、`ZHIHU_COMPILER_MAX_CALLS`（1–50）、`ZHIHU_RESEARCH_DEADLINE_SECONDS`（>0且≤600）；这些只来自Server环境或本地Python配置，不接受HTTP扩大。编译请求/返回走私有IPC，不放命令参数或磁盘。Windows进程树清理已测试，其他平台未实际验证。

卡片上限是 `evidenceLimit`（1–12，拒绝 bool），不是搜索数量或最低产量。freshness 无法由当前底层强制过滤时返回 partial 和 `freshness_not_enforced`，不宣称已落实时效。

下面保留模块原有背景和开发说明；当前接入签名以本节及交接文档为准。

# Zhilu — 知乎知识模块

`packages/zhihu` 是 Zhilu 项目中的知乎知识模块，负责从用户的研究需求出发，检索知乎内容、筛选和整理证据，并最终向主 Agent 提供结构化的 `EvidencePack`。

当前模块属于 P0 开发范围。

## 1. 模块职责

知乎知识模块负责：

* Query 规划；
* 知乎内容检索；
* 知乎回答 / 文章读取；
* 搜索结果去重；
* 内容分类；
* 风险和证据限制标注；
* 搜索结果重排；
* Evidence Card 编译；
* Evidence Cache；
* Mock Provider；
* 真实知乎 Provider；
* 为 Evidence / Source Inspector 提供来源信息；
* 最终完成：

```text
ResearchRequest
      ↓
知乎知识模块
      ↓
EvidencePack
```

知乎模块只负责提供研究证据。

它**不负责**：

* 修改正式 `PlanState`；
* 直接修改 Roadmap；
* 创建计划 Commit；
* 决定用户最终采用哪条路线。

这些工作由 `agent-runtime`、`plan-engine` 和 `apps/server` 完成。

---

# 2. 在 Monorepo 中的位置

项目采用单仓库结构：

```text
zhilu/
├── apps/
│   ├── web/
│   └── server/
│
├── packages/
│   ├── contracts/
│   ├── plan-engine/
│   ├── agent-runtime/
│   └── zhihu/              ← 本模块
│
├── examples/
├── docs/
├── pnpm-workspace.yaml
└── README.md
```

知乎模块主要开发目录：

```text
packages/zhihu/
```

Python package 位于：

```text
packages/zhihu/zhihu_m2/
```

---

# 3. 当前模块结构

当前代码大致分为以下几层：

```text
packages/zhihu/
├── .env.example
├── .env                     # 本地配置，不提交 Git
├── tests/
│
└── zhihu_m2/
    ├── config.py
    ├── zhihu_client.py
    ├── llm_client.py
    ├── query_planner.py
    ├── plan_retrieval.py
    ├── ranker.py
    ├── evidence_compiler.py
    └── ...
```

主要模块职责：

### `config.py`

负责加载本地 `.env` 配置。

默认读取：

```text
packages/zhihu/.env
```

已经存在的系统环境变量优先于 `.env`。

---

### `zhihu_client.py`

负责调用知乎 CLI。

主要职责包括：

* 查找知乎 CLI；
* 执行知乎搜索；
* 验证搜索结果数量；
* 解析知乎 CLI 返回的 JSON；
* 处理 CLI 超时和异常；
* 避免在异常信息中直接泄露凭据或原始敏感内容。

---

### `llm_client.py`

负责调用 DeepSeek 模型。

当前用途主要包括：

* 接收 system prompt；
* 接收 user prompt；
* 请求 JSON Object 输出；
* 处理 HTTP / timeout / JSON 错误。

API Key 从本地环境中读取，不写入源码。

---

### `query_planner.py`

负责把研究任务拆分成：

```text
Research Question
      ↓
Search Query
```

例如：

```text
研究问题：
Python 初学者应该怎样学习 Agent 开发？

↓

搜索词：
Python Agent 新手 学习路线
```

---

### `plan_retrieval.py`

负责根据 Query Plan 执行实际检索。

主要负责：

```text
Query Plan
    ↓
知乎 Search
    ↓
保存 Raw Response
    ↓
整理 Retrieval Results
```

---

### `ranker.py`

当前为 `m2-ranker-v4`，用于本地确定性排序和 `legacy` 路径。根据本次研究问题识别方法、验证、风险、资源、概念或经验需求，再选择权重；Python、API、JSON 等术语本身不再获得加分。点赞权重最多 3%，问题明确要求时效时才启用时间信号。

`rank_results(results, query, now_ts=None)` 与 `evidence_score(...)` 保留原接口；新增 `ranking_breakdown(...)` 可查看权重、原始词面覆盖率及最终折扣。仅对临时评分文本做处理，传给 compiler 的原文、CRLF、emoji、URL 和风险信息保持不变。

生产默认 `batch-v1` 继续走模型批量筛选，不使用这套固定权重；`v3` 复用共享问题结构信号，其 RRF 和多样性选择公式未改。这里的分数是启发式优先级，不能验证事实或判断完整用户约束是否满足。

从仓库根目录执行跨领域离线对照（0 次搜索、0 次模型调用）：

```powershell
.\.venv\Scripts\python.exe -B .\packages\zhihu\scripts\evaluate_ranker.py
```

输出位于 `packages/zhihu/artifacts/ranker-cross-domain.json`，包含逐例解释和未满足项。新增 16 个案例只用于工程回归，真实质量仍为 `needs_human_review`。权重、实际验证结果、剩余限制和回退说明见 [RANKER_GENERALIZATION.md](docs/RANKER_GENERALIZATION.md)。

---

### `evidence_compiler.py`

负责把单个知乎来源整理成结构化 Evidence Card。

Evidence Card 可以包含：

```text
source
claim
claim_type
supporting_quote
applies_when
applicability_basis
caveats
risk_flags
verification_status
```

Evidence Card 只是研究证据，不代表系统已经认可该建议。

---

# 4. 环境准备

## 4.1 进入模块目录

Windows PowerShell：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu\packages\zhihu
```

例如：

```powershell
cd C:\Users\Kylee\Desktop\zhilu\packages\zhihu
```

---

## 4.2 创建 Python 虚拟环境

第一次运行：

```powershell
python -m venv .venv
```

激活：

```powershell
.\.venv\Scripts\Activate.ps1
```

确认当前 Python：

```powershell
python -c "import sys; print(sys.executable)"
```

正常情况下应该指向：

```text
zhilu\packages\zhihu\.venv\Scripts\python.exe
```

---

# 5. 安装依赖

如果仓库已经提供：

```text
requirements.txt
```

优先运行：

```powershell
python -m pip install -r requirements.txt
```

如果当前尚未统一依赖文件，至少需要：

```powershell
python -m pip install pytest httpx python-dotenv
```

其中：

* `pytest`：测试；
* `httpx`：模型 HTTP 请求；
* `python-dotenv`：读取 `.env`。

---

# 6. 配置 `.env`

真实 API Key 和授权信息**不能提交到 Git**。

项目提供：

```text
.env.example
```

第一次配置时：

```powershell
Copy-Item .env.example .env
```

然后打开：

```powershell
code .env
```

示例：

```dotenv
# DeepSeek API
DEEPSEEK_API_KEY=

# 可选：
# 如果知乎 CLI 不在默认路径，可以手动指定。
# ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe

# 可选：
# 用于首次配置知乎 CLI 授权。
# 已经完成本机 CLI 授权时不需要长期保留。
# ZHIHU_ACCESS_SECRET=
```

填写真实值：

```dotenv
DEEPSEEK_API_KEY=你的真实APIKey
```

不要把真实 Key 填入：

```text
.env.example
README.md
Python 源码
tests/
examples/
```

---

# 7. DeepSeek 配置

代码通过：

```text
DEEPSEEK_API_KEY
```

读取模型 API Key。

可以在不输出真实 Key 的情况下检查配置：

```powershell
python -c "from zhihu_m2.config import load_local_env; import os; load_local_env(); print('DeepSeek configured:', bool(os.getenv('DEEPSEEK_API_KEY', '').strip()))"
```

输出：

```text
DeepSeek configured: True
```

只表示读取到了非空配置，并不代表 Key 一定有效。

---

## DeepSeek 真实连接测试

运行：

```powershell
python -m zhihu_m2.llm_client
```

注意：

**该命令会发送一次真实 API 请求。**

它不是离线测试。

---

# 8. 知乎 CLI 配置

知乎检索通过本机知乎 CLI 完成。

Windows 默认查找：

```text
%LOCALAPPDATA%\ZhihuCLI\current\zhihu-cli.exe
```

也可以在 `.env` 中指定：

```dotenv
ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe
```

检查 Python 是否能够找到 CLI：

```powershell
python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"
```

---

# 9. 知乎授权

知乎授权属于**本机配置**，不会随着 Git 仓库自动传给其他开发者。

因此：

```text
git clone zhilu
```

不会自动获得其他成员的知乎授权。

如果当前电脑已经完成知乎 CLI 授权，不需要因为重新 clone 或切换目录再次授权。

可以检查：

```powershell
$cli = "$env:LOCALAPPDATA\ZhihuCLI\current\zhihu-cli.exe"

& $cli auth status
```

如果使用自定义 CLI 路径：

```powershell
$cli = python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"

& $cli auth status
```

---

## 首次授权

如果项目中存在：

```text
zhihu_m2/setup_zhihu_auth.py
```

可以先在本机 `.env` 中配置：

```dotenv
ZHIHU_ACCESS_SECRET=你的AccessSecret
```

然后运行：

```powershell
python -m zhihu_m2.setup_zhihu_auth
```

该操作只用于：

* 第一次配置；
* 更换授权；
* 修复失效的本机授权。

正常搜索时不应该每次重新写入授权。

---

# 10. 测试

## dotenv / 客户端离线测试

运行：

```powershell
python -m pytest tests/test_dotenv_integration.py -q
```

该测试设计为离线运行：

* 不使用个人 API Key；
* 不访问真实 DeepSeek；
* 不执行真实知乎 CLI；
* 使用临时配置和 Mock transport。

---

## 运行整个知乎模块测试

```powershell
python -m pytest tests -q
```

提交代码前建议至少保证：

```text
pytest exit code = 0
```

---

# 11. 测试真实知乎搜索

完成 CLI 安装和授权后，可以手动运行：

```powershell
python -c "from zhihu_m2.zhihu_client import search_zhihu; print(search_zhihu('Agent Engineer 学习路线', 3))"
```

该命令会调用真实知乎服务。

如果成功，将返回知乎搜索结果列表。

---

# 12. 配置优先级

配置采用以下优先级：

```text
当前进程已经存在的环境变量
        ↓
packages/zhihu/.env
```

因此：

```text
Windows 环境变量中已有 DEEPSEEK_API_KEY
```

时，即使 `.env` 中存在另一个值，程序也可能继续使用系统环境变量。

如果发现修改 `.env` 后配置没有变化：

1. 检查 Windows 环境变量；
2. 关闭正在运行的 Python / Server；
3. 重新打开终端；
4. 再次运行检查命令。

---

# 13. `.env` 与 Git 安全

真实 `.env` 必须被 Git 忽略。

项目根目录 `.gitignore` 应包含：

```gitignore
.env
.env.*
!.env.example
```

提交前检查：

```powershell
git status
```

以及：

```powershell
git diff --cached --name-only
```

不应该出现：

```text
packages/zhihu/.env
```

可以出现：

```text
packages/zhihu/.env.example
```

因为 `.env.example` 不包含真实 Secret。

---

# 14. 数据与隐私

以下内容不能提交到 Git：

* API Key；
* Access Secret；
* `.env`；
* 私人用户档案；
* 未脱敏用户数据；
* 未脱敏的知乎缓存；
* 包含真实 Secret 的日志；
* 本地虚拟环境；
* Python Cache。

例如：

```text
.env
.venv/
__pycache__/
.pytest_cache/
data/
```

都应保留在本地。

可复现且已经脱敏的 Demo Fixture 可以提交到：

```text
examples/
```

---

# 15. 与其他模块的关系

依赖关系：

```text
apps/server
     │
     ▼
packages/zhihu
     │
     ▼
packages/contracts
```

知乎模块不应该直接修改：

```text
plan-engine
agent-runtime
Roadmap state
```

模块之间通过共享 Schema 通信。

---

# 16. 目标接口

P0 最终目标是提供统一入口：

```text
ResearchRequest
      ↓
Zhihu Provider
      ↓
EvidencePack
```

调用方不应该需要知道内部执行了：

```text
query_planner
    ↓
plan_retrieval
    ↓
zhihu_client
    ↓
ranker
    ↓
evidence_compiler
```

对 `apps/server` 来说，理想使用方式类似：

```python
evidence_pack = provider.research(request)
```

内部实现可以继续拆分成多个模块。

---

# 17. Mock Provider 与真实 Provider

P0 需要同时支持：

```text
ResearchRequest
      │
      ├── Mock Provider
      │        ↓
      │   EvidencePack
      │
      └── Real Zhihu Provider
               ↓
          EvidencePack
```

两种 Provider 应遵守相同的输入和输出 Schema。

这样其他成员可以在没有真实知乎授权或模型 API Key 的情况下，通过 Mock Provider 开发和测试完整主流程。

---

# 18. 当前开发重点

当前知乎模块的主要工作包括：

### 已建立的基础能力

* 知乎 CLI 搜索；
* Query Plan；
* 批量检索；
* Raw Response 保存；
* Retrieval Results；
* 来源去重；
* Evidence 编译；
* DeepSeek JSON Client；
* `.env` 配置；
* CLI 路径配置；
* 敏感错误信息处理；
* 离线测试。

### 下一阶段 P0 重点

主要需要继续完成：

```text
ResearchRequest
        ↓
统一 Provider
        ↓
Query Planning
        ↓
Retrieval
        ↓
Ranking
        ↓
Evidence Compilation
        ↓
EvidencePack
```

并与：

```text
packages/contracts
```

中的正式 Schema 对齐。

---

# 19. Git 开发流程

整个项目的 Git 根目录是：

```text
zhilu/
```

不是：

```text
packages/zhihu/
```

开发知乎模块时：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu
```

查看状态：

```powershell
git status
```

提交知乎模块：

```powershell
git add packages/zhihu
git status
```

提交前确认：

* `.env` 没有被提交；
* 测试通过；
* 没有意外加入 `.venv`；
* 没有真实用户数据。

Commit 示例：

```powershell
git commit -m "feat(zhihu): update knowledge provider"
```

然后：

```powershell
git push
```

如果是新 branch 第一次 push：

```powershell
git push -u origin <branch-name>
```

---

# 20. 常见问题

## `ModuleNotFoundError: No module named 'zhihu_m2'`

确认当前目录：

```powershell
cd C:\Users\<你的用户名>\Desktop\zhilu\packages\zhihu
```

然后：

```powershell
python -c "import zhihu_m2; print(zhihu_m2.__file__)"
```

---

## 找不到知乎 CLI

检查：

```powershell
python -c "from zhihu_m2.zhihu_client import get_cli_path; print(get_cli_path())"
```

如果 CLI 安装在非默认位置，在 `.env` 中设置：

```dotenv
ZHIHU_CLI_PATH=C:/path/to/zhihu-cli.exe
```

---

## DeepSeek 提示缺少 API Key

检查：

```powershell
python -c "from zhihu_m2.config import load_local_env; import os; load_local_env(); print(bool(os.getenv('DEEPSEEK_API_KEY', '').strip()))"
```

如果输出：

```text
False
```

检查：

```text
packages/zhihu/.env
```

中的：

```dotenv
DEEPSEEK_API_KEY=
```

是否已经填写。

---

## `.env` 修改后没有生效

可能存在系统环境变量覆盖 `.env`。

PowerShell：

```powershell
[bool](-not [string]::IsNullOrWhiteSpace($env:DEEPSEEK_API_KEY))
```

此检查只显示是否配置，不显示密钥。不要打印完整环境或 Authorization。

---

# 21. P0 完成标准

知乎模块的 P0 验收目标：

1. 同一个 `ResearchRequest` 可以发送给 Mock Provider 或真实 Provider；
2. 两种 Provider 都返回符合共享 Schema 的 `EvidencePack`；
3. Evidence Card 保留来源；
4. Evidence Card 包含摘要；
5. Evidence Card 包含内容类型；
6. Evidence Card 包含适用条件；
7. Evidence Card 包含风险 / 限制信息；
8. 其他模块不需要理解知乎模块内部文件结构；
9. 没有真实 API Key、Access Secret 或私人数据进入 Git；
10. 知乎模块不直接修改正式 Plan 或创建计划 Commit。

