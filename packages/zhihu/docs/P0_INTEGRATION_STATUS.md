# P0 接入执行记录

2026-09-12 后续分工的实现、最新测试和真实 Planner／知乎配额阻塞见 [M2 新分工实施与交接](../../../docs/M2_FOLLOWUP_STATUS_2026-09-12.md)。以下保留为历史运行记录，不代表本轮再次执行或新批量路径已经完成真实验收。

实施规格：`docs/CODEX_M2_P0_INTEGRATION.md`（用户指定的子目录不存在，资料实际在 docs）。

## 工作区基线

- 分支 `kylee-zhihu-agent`，HEAD `3b3870772a7add42389b56381ec05f3ff1c4f34c`。
- 开始时已跟踪文件无暂存/未暂存修改；未跟踪用户资料为 `docs/CODEX_M2_P0_INTEGRATION.md`、`docs/REFERENCE_SOURCE_EXCERPTS.md`、`docs/START_HERE.md`、`docs/fixtures/`，全部保留。
- 仓库及父目录未发现适用的 AGENTS.md。
- Python 为根目录 `.venv/Scripts/python.exe`（3.12.7 / pytest 9.1.1），实际导入 `packages/zhihu/zhihu_m2/__init__.py`，无 src 布局。系统 Python 3.10 缺少 pytest，不能用于本次验证。
- Node v24.19.0；使用 packageManager 指定的 pnpm 10.30.2，锁文件冻结安装。
- 已有 Contracts、adapter、runtime validator/assembler、mock research 与 baseline/apply；research pipeline 原为明确的未接通错误。
- `.gitignore` 已跟踪内容含旧合并标记；仅修复标记并补忽略本地研究产物，不移除已跟踪产物。

## 执行与边界

采用用户已批准的设计及任务列表，直接实施，不生成重复设计、不切换分支、不 commit/push。

| 阶段 | 实际文件边界 | 状态 |
| --- | --- | --- |
| 基线与环境 | 本记录、pytest 默认隔离、冻结 Node 依赖 | 完成 |
| 请求与单请求执行 | research_runner.py / test_research_runner.py | 完成，硬 deadline 与回收通过最终审查 |
| 首次 Baseline 与入口 | query_planner.py / pipeline.py 与测试 | 完成 |
| 运行时校验与跨语言 | zhihu-boundary.ts 与测试 | 完成 |
| 子进程 Provider | zhihu-provider.ts 与测试 | 完成 |
| 独立 HTTP | index.ts / live evidence tests | 完成 |
| 联调和交接 | smoke script / README / P0_JIA_HANDOFF.md | 已成功一次真实 Provider smoke |

各并行单元拥有不重叠文件，按共同协议集成；Python compiler 输出仅由现有 TS adapter 转换。路线综合、用户确认和正式 Plan 写入保持原边界。

初次 Python 基线：`..\..\.venv\Scripts\python.exe -m pytest -q`（cwd packages/zhihu），487 passed、1 failed：缺密钥测试被个人 dotenv 补配置，HTTP 为 fake transport，无真实网络。以此失败复现新增 tests/conftest.py，统一禁用个人 dotenv 并清除测试进程凭据。

## 实际实现文件

- `zhihu_m2/query_planner.py`、`pipeline.py`：opt-in Baseline 3×2，严格校验、澄清保留、一次模型调用；research新包装、白名单错误与真实计数。
- `zhihu_m2/research_runner.py`：校验、限定Query、现有搜索/normalizer/ranker/compiler复用、原文变体/时间追踪、卡片限额/预算、状态区分。没有新的共享卡片映射或跨请求缓存。
- `apps/server/src/zhihu-boundary.ts`：unknown运行时校验、Draft三字段映射、调用原validator、代码点引文复核、调用原adapter组装pack、去重/ID冲突/限额。
- `apps/server/src/zhihu-provider.ts`：显式spawn参数、stdin关闭、close后完整UTF-8解码、stderr计数而不转发、输出大小/超时/进程树清理、失败envelope校验与安全错误。
- `apps/server/src/m2-context.ts`、`index.ts`、`repository.ts`：只读已确认背景、独立live证据路由、默认关闭、同项目busy；新增getExistingPlan避免demo惰性初始化写盘。
- 各自pytest/Vitest测试、离线Python compiler fixture、进程fixture：只在测试边界替代网络，使用真实生产校验与adapter。
- `apps/server/scripts/smoke_zhihu_provider.ts`、package script、tsconfig、双端`.env.example`、research输入示例、中文README与交接文档：可运行配置/诊断/交接。
- `.gitignore`只修旧冲突标记并忽略本地产物；两个测试产生的已跟踪pyc已精确恢复至开始时字节，未删除用户跟踪文件。

未改共享 Contracts、原有 zhihu-adapter、排序算法、Plan Engine、Mock 模板或前端。用户的根docs资料全部原样保留。参考fixtures compiler_version为旧`m2-evidence-v0.1.1`，当前源码为`m2-evidence-v0.1.2`；新测试采用当前真实compiler，不倒退版本或把旧样例当线上证据。

## 测试优先与环境记录

- Planner RED 8 failed / 88 passed → GREEN 96 passed；入口接入 RED 7 failed / 47 passed / 13 errors → 与Planner共同GREEN 171 passed。
- runner初始缺模块收集失败（1 error）→ 初版27 passed，扩展34 passed；其余原有入口/检索/compiler回归通过。
- 边界最初受Node依赖缺失阻塞，随后确认缺新模块；新增错误码/context限制/失败metrics测试实际RED→GREEN，49项含真实跨语言compiler与adapter通过。
- Provider初始缺模块RED；deadline失败envelope与非法UTF-8出现2 failed / 16 passed → 修复通过；最终增加真实进程树、信号、流边界EPIPE与安全失败计数。
- HTTP RED 14 failed / 13 passed → GREEN；cleanup信息透传新增RED 1 failed / 16 passed → GREEN17 passed。
- 总Python回归又发现2 failed / 555 passed，原dotenv测试reload了llm_client而新测试保存旧异常类。只改测试为运行时读取`llm_client.LLMError`，生产catch不放宽，随后557 passed。
- 最终审查发现同步compiler仅事后检查deadline，已改成私有spawn worker＋IPC，生产编译按剩余wall-clock截止、超时terminate/kill并回收，额外清理最多2秒。新增11项实际worker/安全错误测试，原P2复审关闭；跨语言fixture也走同一worker及真实compiler，仅替代LLM网络边界。
- Windows实际超时测试确认父进程及后代PID均退出；EPIPE使用真实子进程的stdin流边界注入，避免不同系统pipe缓冲的竞态。Windows taskkill失败/自行退出竞态不能确认树清理时，保留受控cleanupError，不声称清理成功。
- Node工具未在PATH提供可用pnpm；获取项目指定10.30.2至本机临时工具目录。冻结安装有两个esbuild二进制包下载停滞，用相同版本的官方npm tar包恢复本地virtualstore后，`pnpm install --offline --frozen-lockfile` exit0。锁文件无修改，无依赖升级。

实际命令中的 `pnpm` 为 `node "$env:TEMP\zhilu-p0-pnpm-10.30.2\package\bin\pnpm.cjs"`。当前已安装工作区也可直接使用 `.\node_modules\.bin\vitest.cmd` / `tsx.cmd`，README给出了不依赖该临时路径的命令。

## 真实 smoke（仅一次）

执行：仓库根配置绝对 `ZHIHU_PYTHON_BIN`、`ZHIHU_PYTHON_CWD` 后，`pnpm --filter @zhilu/server smoke:zhihu --live`，exit0。

- 运行ID：`entry_1e6386d136744029ac6e43ffea880f87`。
- 请求ID：`rq-integration-001`，原样返回。
- 研究请求1；Planner尝试0；搜索尝试2；compiler尝试2；候选10；有效卡片2。
- `status=ok`、`issues=[]`、`routeCandidates=[]`。
- 两张卡均保留真实retrievedAt、unverified及3个必须的风险标签；通过真实TypeScript边界与adapter。
- 模型沿用现有 `deepseek-v4-pro` / `https://api.deepseek.com/chat/completions`。只检查凭据是否存在和CLI可用，没有打印密钥、完整环境、Authorization或上游原始异常，没有重写授权。
- 本地产物：`packages/zhihu/artifacts/p0-provider-smoke-76e6be0b-b81a-4c5d-a0f8-f9562d5bd09d.json`；`git check-ignore`确认忽略。不自动提交真实来源或个人信息。
- 普通测试真实检索/模型调用均为0。以上次数是调用尝试，不代表计费次数，未报告未知token usage。

本轮真实联调覆盖Windows Server Provider→Python→知乎→compiler→adapter；未再额外付费调用HTTP或Planner。最终Python可终止deadline收尾采用离线验证，未重复付费smoke。

## 交付边界

M2／Server单请求真实证据链路已取得真实运行证据。真实证据驱动完整Roadmap尚未完成；Jia下一步调用`createZhihuProvider(config).planForBaseline()`和`.researchOne()`，Controller继续用原`assembleResearchRequests()`分配ID，之后补真实runtime路线综合与用户确认UI。

未验证Linux/macOS进程树清理、长期并发负载、真实Planner输出质量、真实HTTP付费链路；Windows HTTP以离线Provider边界测试覆盖。固定本地Server权限/CORS沿用当前项目，不新增公网部署。

## 最终验证结果

| 实际命令 | 工作目录 | 通过 | 失败 | 跳过 | 退出码 |
| --- | --- | ---: | ---: | ---: | ---: |
| `..\..\.venv\Scripts\python.exe -B -m pytest -q` | packages/zhihu | 568 | 0 | 0 | 0 |
| `pnpm test` | 仓库根 | 121 | 0 | 0 | 0 |
| `pnpm typecheck` | 仓库根 | 全部5个workspace | 0 | 0 | 0 |
| `pnpm build` | 仓库根 | 全部5个workspace | 0 | 0 | 0 |
| `pnpm --filter @zhilu/server smoke:zhihu --help` | 仓库根 | 帮助，不联网 | 0 | 0 | 0 |
| `pnpm --filter @zhilu/server smoke:zhihu --live` | 仓库根 | 一次真实结果ok | 0 | 0 | 0 |
| `git -c core.safecrlf=false diff --check` | 仓库根 | 无空白错误 | 0 | 0 | 0 |

TypeScript分项：Server98、agent-runtime10、plan-engine6、web7；contracts无测试文件，按原脚本exit0（不计作跳过）。Server测试覆盖原Mock/baseline/apply、导出和Plan修改；没有删旧测试以获得通过。

下一条可从仓库根直接运行（离线）：

```powershell
.\node_modules\.bin\vitest.cmd run apps/server/src/zhihu-provider.test.ts apps/server/src/zhihu-boundary.test.ts apps/server/src/zhihu-cross-language.test.ts apps/server/src/live-evidence.test.ts
```

启用并启动真实证据Server的完整命令已写在模块README。新增/保留接口、完整请求及成功/无证据/部分失败/错误样例见`P0_JIA_HANDOFF.md`。没有未完成的代码阻塞；真实路线综合与未验证平台按上述边界交给后续任务。

## 最终 git status

分支与HEAD保持原值；无暂存修改，12项已跟踪文件修改、23项未跟踪文件/目录记录。其中根docs的4项为用户原有资料。没有commit、push、切换/合并分支、stash、reset或clean。真实artifacts与个人配置保持忽略。

```text
 M .gitignore
 M README.md
 M apps/server/README.md
 M apps/server/package.json
 M apps/server/src/index.ts
 M apps/server/src/repository.ts
 M apps/server/tsconfig.json
 M packages/zhihu/README.md
 M packages/zhihu/tests/test_pipeline_entry.py
 M packages/zhihu/tests/test_query_planner.py
 M packages/zhihu/zhihu_m2/pipeline.py
 M packages/zhihu/zhihu_m2/query_planner.py
?? apps/server/.env.example
?? apps/server/scripts/
?? apps/server/src/fixtures/
?? apps/server/src/live-evidence.test.ts
?? apps/server/src/m2-context.test.ts
?? apps/server/src/m2-context.ts
?? apps/server/src/zhihu-boundary.test.ts
?? apps/server/src/zhihu-boundary.ts
?? apps/server/src/zhihu-cross-language.test.ts
?? apps/server/src/zhihu-provider.test.ts
?? apps/server/src/zhihu-provider.ts
?? docs/CODEX_M2_P0_INTEGRATION.md
?? docs/REFERENCE_SOURCE_EXCERPTS.md
?? docs/START_HERE.md
?? docs/fixtures/
?? packages/zhihu/.env.example
?? packages/zhihu/docs/P0_INTEGRATION_STATUS.md
?? packages/zhihu/docs/P0_JIA_HANDOFF.md
?? packages/zhihu/examples/entry_research_request.json
?? packages/zhihu/tests/conftest.py
?? packages/zhihu/tests/fixtures/
?? packages/zhihu/tests/test_research_runner.py
?? packages/zhihu/zhihu_m2/research_runner.py
```
## 补充验证：Windows 本地真实 HTTP 研究接口

通过 PowerShell 调用：

POST /api/projects/project-04455d19/research/live/evidence

运行结果：
- ok: true
- status: ok
- runId: entry_da287ab20338488b96570ebc807c2f55
- requestId: rq-http-83fd573719cf4ef4884d1c70607d0829
- Planner 调用尝试：0
- 搜索调用尝试：2
- 编译调用尝试：2
- 候选内容：10
- 最终证据卡：2

已验证：
真实 HTTP 路由 → Server Provider → Python →
知乎检索 → 证据编译 → 共享 EvidencePack → HTTP 响应。

两张证据均保留来源链接、unverified 状态和风险标签。

本次使用已有研究问题与 Query，没有调用真实 Planner，
没有验证多个请求的研究编排、真实路线综合或前端路线展示。
本次输出也不用于证明并发、超时等其他场景已经通过。
