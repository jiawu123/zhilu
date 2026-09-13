# 真实知乎检索后的批量编译失败修复

日期：2026-09-13。分支：`kylee-zhihu-agent`，开始时 HEAD `5b3a9ff`。工作区已有用户修改的 `batch_screening.py`、其 `.bak` 和两份 tracked `.pyc`；在现有调试实现上修复，保留备份与字节码文件，未切换分支、提交或推送。

## 根因和现场证据

用户提供的原日志 `entry_730dc7765d884b79b90dd2c87951bf4b` 显示：搜索1次、10条有效候选、批量模型1次、约40.8秒后 `compilation_failed`。错误发生在搜索成功后的编译阶段。原次模型响应没有保存，无法逐项还原它。

使用相同问题“计划一场环中国旅行”和相同输入进行一次受预算诊断，成功复现同一错误路径：

1. 知乎搜索1次成功，返回10条有效候选。
2. 模型1次返回10项与3个研究假设；候选6生成了2张卡，违反每候选恰好1卡的契约，因此整项被严格拒绝。候选5合法返回 `no_evidence`。
3. 其余8个候选产生有效卡，共有9个合法 compiler output（含上述无证据项）。
4. 3个假设分别引用候选6、候选5、候选6，均没有完整的可用证据引用。旧实现对任一无效假设抛异常，使全部有效卡也一起丢失，最终只返回 `compilation_failed`。

另有两个问题：用户新增的 `_debug` 写到子进程 stderr，随后被 worker 的输出隔离机制丢弃；复制测试模板时，旅行问题的 `user_context` 仍残留“Python 初学者”“项目自动化测试”等背景，影响模型判断。这两个问题分别通过安全 IPC 诊断和中性通用测试入口解决。

## 修复行为和职责边界

- 独立校验每个研究假设。引用不存在/被拒绝/无证据的候选、字段不合法或重复ID时，舍弃整个假设并记录 `batch_research_candidate_invalid`。不删除坏引用后继续保留原摘要。
- 有合法 compiler output 时保留它们，再按已有选择规则和 `evidenceLimit` 限制卡数；通过 runner 映射为既有 `compiler_invalid_output`/`partial`。
- 所有候选不合法、顶层模型响应不合法、引用冲突、上游执行错误仍然失败；没有把失败改成成功空数组。
- 原单卡、逐字引文、source_id、CRLF、emoji、来源、检索时间、风险标签和人工审核状态校验不变。不裁剪两卡违规输出、不修补引文、不新写 EvidenceCard adapter。
- 部分失败结果不会写入证据缓存。正常无证据仍为 `no_evidence`。
- 子进程的原始 stdout/stderr 继续隔离。`compile_batch(..., diagnostics=None)` 可收集最多128条固定事件，只有固定枚举和0–1,000,000的整数计数可以通过 IPC；任意模型字段名、标签值、异常文字、bool计数均不透传。
- `ZHIHU_BATCH_DEBUG=1` 时，父进程输出这些安全事件；协议摘要和 Server Provider 保留 `batch_invalid_item_count`、`batch_valid_output_count`、`batch_invalid_group_count`。HTTP EvidencePack 协议保持兼容。
- 没有追加搜索、重新调用 Planner、自动重试、修改模型/endpoint、放宽安全校验，或回退 Mock；正式 Plan、History、pending proposal 与 Roadmapper 不改动。

## 本地直接运行

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'

# 离线预览：0搜索、0模型。request.json 的 user_context 为 {}。
node .\node_modules\tsx\dist\cli.mjs .\apps\server\scripts\research_zhihu.ts --question '计划一场环中国旅行'

# 真实链路：只加 --live；每次调用都可能产生费用，无自动重试。
node .\node_modules\tsx\dist\cli.mjs .\apps\server\scripts\research_zhihu.ts --question '计划一场环中国旅行' --live

# 全部普通自动化测试离线，使用独立数据目录。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
```

默认使用根目录 `.venv\Scripts\python.exe` 和 `packages\zhihu` 工作目录；可使用已有 `ZHIHU_PYTHON_BIN` / `ZHIHU_PYTHON_CWD` Server 配置。Python仍从进程环境和包内 `.env` 获取既有 DeepSeek 配置，知乎CLI沿用本机授权；Node不读取 `.env`。不传密钥参数，不将密钥写进请求或前端。

通用入口通过现有 `createZhihuProvider(...).researchOne(input)` 执行。固定1个Query、最多10条搜索结果、1次批量模型、5张卡、600秒研究期限，缓存关闭；不带 `--live` 不创建Provider。每次创建独立 `packages/zhihu/artifacts/research-zhihu-*` 目录：

- `request.json`：本次中性测试输入，含新 requestId。
- `status.json`：成功/无证据/partial/失败、阶段、计数与输出目录。
- `result.json`：仅研究成功返回时保存，包含经过真实TS校验和既有adapter的完整结果；`partial` 的问题和覆盖缺口仍然保留。

这是操作者本地联调入口；现有HTTP接口继续从Server保存的已确认项目资料取上下文，不接受任意覆盖。

## 已验证与剩余限制

已用同一份保存的真实候选和模型响应离线重放：修复后返回 **`partial`、5张有效卡、1个被拒绝候选、3个被舍弃假设**；9个合法原始compiler output在选择前保留。该输出通过真实 TypeScript runtime validator 和原 adapter；requestId保持一致，重放未发生新搜索或模型调用。

诊断与重放材料只保存在本地 `packages/zhihu/artifacts/live-compilation-debug-20260913-013330/`，未纳入Git。报告只输出安全摘要，原文快照用于本地回放。可提交的测试只使用相同结构的合成内容。

修复后的真实验证使用新中性输入，通过 **Server Provider → Python pipeline → 知乎 → batch compiler → TypeScript runtime validator → 既有 adapter** 完成：

| 项目 | 实际结果 |
| --- | --- |
| 问题 / 用户背景 | 计划一场环中国旅行 / `{}` |
| 状态 | `partial`，返回2张合格证据卡，0个研究假设 |
| 搜索 / 模型 / Planner | 1 / 1 / 0 |
| 候选 | 10 |
| 已校验输出 / 校验不合法项 / 未返回项 | 2 / 6 / 2 |
| 无效假设 | 2个，全部舍弃 |
| 耗时 | 搜索984ms，批量28016ms，总计约29秒 |
| 缓存 | 禁用，无命中 |
| 结果目录 | `packages/zhihu/artifacts/research-zhihu-xta7Ws/` |

该次完整模型响应未另存，不能从安全计数进一步认定6个不合法项各自的具体错误。已保存的 `result.json` 只包含通过校验的证据和未完成项。本次不追求凑满5张卡，未因 `partial` 自动重试。

本轮总真实调用为 **2次知乎搜索、2次批量模型、0次Planner**：前一次用于诊断复现，后一次用于完整Provider验证。离线回放和自动化测试没有真实调用。

实际自动化验证：

| 命令 | 结果 |
| --- | --- |
| 根目录 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1` | Python **1033 passed**；TypeScript **205 passed**；Server类型检查通过；HTTP **36/36**；原批量Provider两领域离线验收通过 |
| 最后补全超限假设计数后，在Python包目录运行 `..\..\.venv\Scripts\python.exe -B -m pytest tests/test_batch_screening.py tests/test_batch_worker_diagnostics.py tests/test_research_runner_batch.py -q` | **85 passed** |
| `git diff --check` | 通过，只有现有LF/CRLF配置提示 |

上述最终测试均无失败或跳过。测试优先新增失败用例后实现，覆盖多卡违规与缺失引用、无效组独立隔离、全部证据不合法仍失败、真实spawn诊断回传、bool/超大计数/模型文字过滤，以及CLI中性输入、预算、默认离线、partial保存和错误分阶段。全套检查记录在 `packages/zhihu/artifacts/local-backend-20260913T054225Z-85c72b83/checks.json`。

真实证据只说明技术链路和逐字来源绑定通过，不说明模型主张已核实、语义覆盖充分或完整Roadmap已经完成；质量仍为 `needs_human_review`。

## 改动与交接

- `packages/zhihu/zhihu_m2/batch_screening.py`：在用户调试改动上实现无效假设隔离和安全诊断。
- `packages/zhihu/zhihu_m2/research_runner.py`、`pipeline.py`：跨进程传回诊断和安全计数，不放开原始日志。
- `apps/server/src/zhihu-provider.ts`、`zhihu-boundary.ts`：运行时校验并保留新增安全计数，EvidencePack adapter复用原实现。
- `apps/server/scripts/research_zhihu.ts`：通用中性测试入口；对应 `research_zhihu.test.ts` 验证离线和失败行为。
- `packages/zhihu/tests/test_batch_screening.py`、`test_batch_worker_diagnostics.py`，以及Provider测试/子进程fixture：新增和调整回归。
- `scripts/test-backend.ps1`：纳入新CLI测试；包README与本文提供中文使用和结果记录。

Jia继续使用原 `createZhihuProvider(config).researchOne(input)`；不需更换接口或适配器。应检查 `status`、`issues` 与覆盖缺口；需要补充研究时仍由Controller按明确预算决定。真实证据接入已验证，完整真实证据驱动Roadmap仍不属于本次交付。

最终工作区有12个修改路径和5个未跟踪路径，其中用户原有两份 `.pyc` 修改和 `batch_screening.py.bak` 保留；其余为本次源码、测试和文档。无暂存、commit或push。
