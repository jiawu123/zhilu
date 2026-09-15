# 本地后端完整测试（Windows PowerShell）

2026-09-12 新分工：测试脚本现在还包含批量 M2 的编程／写作跨语言验证；`-Profile` 支持 `batch-v1`（默认）、legacy、v3。新增有预算上限的 Planner→研究→缓存脚本与真实运行记录见 [M2 新分工实施与交接](M2_FOLLOWUP_STATUS_2026-09-12.md)。以下原有 HTTP 请求与 Mock/baseline/apply 流程保持兼容。

这套代码针对当前 `zhilu` 工作区。`C:\Users\Kylee\Desktop\zhilu.zip` 的关键后端文件与工作区一致，ZIP只读核对过，没有解压覆盖已有修改。所有脚本从自身路径寻找仓库，不依赖激活虚拟环境，不自动安装依赖。

## 1. 一条命令跑完整离线后端检查

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
```

默认模式是 `Test`，依次执行：

1. Python 后端全部 pytest，包括 Planner、runner、v3、compiler 和协议边界。
2. Server、agent-runtime、plan-engine 的 Vitest，包括 Python→TypeScript 校验和已有 adapter。
3. Server TypeScript 类型检查（包含新增 HTTP 测试脚本）。
4. 完整本地 HTTP 流程：健康检查 → 创建已确认的合成测试项目 → 读取项目 → Mock研究提案 → 验证真实证据接口默认关闭且状态不变 → 确认Mock Baseline → 创建Event → 确认Diff → 核对Evidence和JSON/Markdown/ZIP导出。

普通模式禁用个人 dotenv、清除测试子进程中的模型/知乎凭据、关闭真实接口。生产代码未被更换。测试结束后恢复调用进程的环境设置，输出 `[PASS]` 并返回退出码0；任何一步失败返回1，不继续下一步。完整自动化默认不调用公网。

完整脚本：[`scripts/test-backend.ps1`](../scripts/test-backend.ps1)。独立 HTTP 测试代码：[`apps/server/scripts/test_backend_http.ts`](../apps/server/scripts/test_backend_http.ts)。两者均已写入工作区，不需要复制聊天片段或覆盖ZIP。

只跑快速 HTTP 流程：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1 -Mode Http
```

它使用 `127.0.0.1` 随机可用端口，自动启动和关闭自己的 Server。测试项目和报告保留在 `packages/zhihu/artifacts/local-backend-*`，不会使用已有 `data/`，也不会删除旧测试目录。HTTP流程中的 Mock 明确保持 `mode=mock`，不宣称生成真实路线。

## 2. 启动可手工请求的后端

终端一：

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1 -Mode Serve -Port 8787
```

服务器持续监听 `http://127.0.0.1:8787`，按 Ctrl+C 停止。该次启动仍使用新建的独立测试数据目录，路径会显示在终端；下一次启动创建新目录。若8787已占用，改为 `-Port 8788`，并同步修改下面 `$base`。脚本不会停止已有服务。

终端二执行以下完整客户端代码。所有数据都是测试样例，日期动态设置为90天后，项目ID取服务器真实返回值：

```powershell
$base = 'http://127.0.0.1:8787'
$ErrorActionPreference = 'Stop'

function Invoke-ZhiluJson {
    param([string]$Method, [string]$ApiPath, $Body = $null)
    $requestParams = @{
        Uri = "$base$ApiPath"
        Method = $Method
        TimeoutSec = 660
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $requestParams.ContentType = 'application/json; charset=utf-8'
        $json = $Body | ConvertTo-Json -Depth 50 -Compress
        $requestParams.Body = [Text.Encoding]::UTF8.GetBytes($json)
    }
    Invoke-RestMethod @requestParams
}

# 健康检查
Invoke-ZhiluJson GET '/api/health'

# 创建一份合成的、字段完整的测试项目
$projectInput = @{
    userContext = @{
        currentSituation = '会基础 Python，还没有独立完成 Agent 项目'
        weeklyHours = 8
        constraints = @('仅使用业余时间')
        confirmed = $true
    }
    goalContract = @{
        goal = '完成一个可运行、带基本测试的 Agent 项目'
        targetDate = (Get-Date).AddDays(90).ToString('yyyy-MM-dd')
        successCriteria = @('项目可以运行且有自动化测试')
        nonGoals = @()
        mustHaveOutcomes = @('测试结果和演示')
        tradeoffs = @('优先保证可验证性')
        reviewCadence = 'weekly'
        confirmed = $true
    }
    adaptiveQuestion = '时间不足时优先保留什么？'
    adaptiveAnswer = '保留核心功能和自动化测试'
}
$created = Invoke-ZhiluJson POST '/api/projects' $projectInput
$projectId = $created.projectId
Write-Host "Project: $projectId"
$initial = Invoke-ZhiluJson GET "/api/projects/$projectId"
$initial.plan.version
$initial.history.Count

# Mock研究只创建提案，正式版本仍为1
$proposal = Invoke-ZhiluJson POST "/api/projects/$projectId/research/mock" @{}
$proposal.researchRun.mode
$proposal.researchRun.routeCandidates | Select-Object id, title
$pending = Invoke-ZhiluJson GET "/api/projects/$projectId"
$pending.plan.version
$pending.baselineProposals.Count

# 仅对这份合成测试项目应用推荐Mock路线，正式版本变为2
$applied = Invoke-ZhiluJson POST "/api/projects/$projectId/baseline/apply" @{
    proposalId = $proposal.id
    routeId = $proposal.recommendedRouteId
}
$applied.plan.version
$applied.history.Count

# Event产生待确认Diff；应用后版本再次增加
$eventResult = Invoke-ZhiluJson POST "/api/projects/$projectId/events" @{
    type = 'constraint_changed'
    title = '测试：可用时间改变'
    description = '每周可投入时间改为6小时'
    targetNodeIds = @()
    changes = @{ weeklyHours = 6 }
}
Invoke-ZhiluJson GET "/api/projects/$projectId/diff"
$updated = Invoke-ZhiluJson POST "/api/projects/$projectId/diff/apply" @{
    patchId = $eventResult.patch.id
}
$updated.plan.version
$updated.plan.weeklyHours
Invoke-ZhiluJson GET "/api/projects/$projectId/evidence"

# 导出到当前终端的新目录，不覆盖已有文件
$exportDir = Join-Path $env:TEMP ('zhilu-export-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $exportDir | Out-Null
Invoke-WebRequest "$base/api/projects/$projectId/export/json" -UseBasicParsing -OutFile (Join-Path $exportDir 'plan.json')
Invoke-WebRequest "$base/api/projects/$projectId/export/markdown" -UseBasicParsing -OutFile (Join-Path $exportDir 'plan.md')
Invoke-WebRequest "$base/api/projects/$projectId/export/zip" -UseBasicParsing -OutFile (Join-Path $exportDir 'plan.planbundle.zip')
Write-Host "Exports: $exportDir"
```

这个流程测试本地项目、Mock提案、确认和历史机制，**不是完整真实 Roadmap**。

## 3. 单次真实证据 HTTP 联调（明确启用才联网）

此前知乎调用返回过 `rate_or_quota_limit`；本轮没有自动重试真实服务。确认本地授权/配额恢复后，可手动运行一次：

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1 -Mode Http -Live -Profile v3
```

这条命令使用实际 Server → Provider → Python → 知乎 → compiler → 原adapter，创建隔离测试项目，仅研究1个request、2个Query，最多3次compiler、2张卡片、0次Planner。不会因为失败或无证据重试；真实接口在成功和错误后都验证正式Plan、History和已有提案未变。失败会明确返回非零退出码，不能当作Mock成功。`-Mode Test -Live` 被拒绝，避免普通测试意外联网。

若希望手工发送真实请求，终端一用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1 -Mode Serve -Live -Profile v3 -Port 8787
```

终端二先执行上一节客户端的函数和“创建项目”部分，再发送：

```powershell
# HTTP body只有request，goal/context由Server已确认项目读取
$before = Invoke-ZhiluJson GET "/api/projects/$projectId"
$researchBody = @{
    request = @{
        id = 'rq-local-' + [Guid]::NewGuid().ToString('N')
        question = '初学者怎样检查工具调用参数是否符合预期？'
        searchQueries = @('Agent 工具调用 参数 测试', '工具调用 固定样例 预期参数 比较')
        relevantUserConditions = @('每周可投入8小时')
        evidenceLimit = 2
    }
}
try {
    $research = Invoke-ZhiluJson POST "/api/projects/$projectId/research/live/evidence" $researchBody
    $research.result.status
    $research.result.metrics
    $research.result.pack.evidence | Select-Object id, title, summary, riskTags
} catch {
    # 只显示HTTP状态，不打印原始异常、响应内容或凭据
    if ($null -ne $_.Exception.Response) {
        Write-Host ('Research HTTP failure: ' + [int]$_.Exception.Response.StatusCode)
    } else {
        Write-Host 'Research transport failed; no automatic retry.'
    }
} finally {
    $after = Invoke-ZhiluJson GET "/api/projects/$projectId"
    $beforeJson = $before | ConvertTo-Json -Depth 100 -Compress
    $afterJson = $after | ConvertTo-Json -Depth 100 -Compress
    if ($beforeJson -cne $afterJson) { throw 'Research unexpectedly changed project state.' }
}
```

`ok`、`no_evidence`、`partial` 都可能返回200，必须检查 `result.status`；disabled为503，输入错误400，项目不存在404，未确认资料/繁忙409，上游执行失败502，整体超时504。风险仍未核实，不能把排序分数或两张卡当作质量保证。

Python沿用已有 `packages/zhihu/.env` 或进程环境中的DeepSeek配置，以及本机知乎CLI授权；Node从启动环境获取解释器和包目录。脚本只设置非秘密参数，不写`.env`、不换服务商、不传密钥命令行。生产默认为 `batch-v1`；本地确定性排序可重启并显式使用 `-Profile legacy`，其 `ranker.py` 已更新为问题驱动的 V4。离线对照与旧版本回退见 [Ranker 泛化说明](../packages/zhihu/docs/RANKER_GENERALIZATION.md)。

## 4. 环境不完整时

当前工作区已有依赖，可直接执行第1节。换到新机器才需要安装；不要用ZIP覆盖当前仓库、不要复制现有个人`.env`：

```powershell
Set-Location 'C:\Users\Kylee\Desktop\zhilu'
# 先安装Python 3.12、Node 24和项目package.json指定的pnpm 10.30.2
# 仅当虚拟环境不存在时创建
if (-not (Test-Path .\.venv\Scripts\python.exe)) { py -3.12 -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -r .\packages\zhihu\requirements-dotenv.txt httpx pytest
pnpm.cmd install --frozen-lockfile
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1
```

一键脚本调用仓库已安装的 Node 工具，不依赖当前PATH里的pnpm版本。若解释器不在默认位置，传入 `-Python 'C:\完整路径\python.exe'`。不需要为离线测试提供任何API Key。

## 5. 本机实际验证结果

2026-09-12 在 Windows PowerShell 5.1 下实际执行：

- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-backend.ps1`：exit0，Python **731 passed**、Server及后端依赖 **126 passed**、Server类型检查通过、完整HTTP流程 **36/36**。普通测试0失败/0跳过。
- 同入口 `-Mode Http`：exit0，36/36，预期live=503，正式状态不变；最终Mock测试版本000003。
- `-Mode Serve`：独立端口启动成功；文档完整PowerShell客户端实跑通过，最终version=3、weeklyHours=6，JSON/Markdown/ZIP三种导出存在。仅停止了此次验证启动的服务。
- `-Mode Test -Live`：按设计拒绝，exit1，未调用真实服务。
- HTTP脚本的`--help`和Server类型检查通过。

本轮真实搜索、编译、Planner调用均为0；真实模式只提供入口，未验证当前知乎配额已经恢复。此前已有修改（包括用户本轮开始前已修改的latest artifact和pyc文件）保持不变。没有修改生产后端逻辑、自动commit或push。

默认完整检查报告：`packages/zhihu/artifacts/local-backend-20260912T130554Z-bf3099cd/checks.json`。
对应HTTP步骤报告：`packages/zhihu/artifacts/local-backend-http-346ab80a-f66a-4831-abaf-0c5d6615fd60/report.json`。以后每次生成新的唯一目录，路径在终端显示。
