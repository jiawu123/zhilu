<#
Local backend checks. Default is offline; existing project data is never used.
Examples:
  .\scripts\test-backend.ps1
  .\scripts\test-backend.ps1 -Mode Http
  .\scripts\test-backend.ps1 -Mode Serve -Port 8787
  .\scripts\test-backend.ps1 -Mode Http -Live -Profile v3
#>
[CmdletBinding()]
param(
    [ValidateSet('Test', 'Http', 'Serve')]
    [string]$Mode = 'Test',
    [ValidateSet('legacy', 'v3')]
    [string]$Profile = 'legacy',
    [switch]$Live,
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$repoPath = Split-Path -Parent $PSScriptRoot
$savedDirectory = Get-Location
$envNames = @('NODE_ENV', 'PORT', 'ZHILU_DATA_DIR', 'ZHIHU_LIVE_ENABLED',
    'ZHIHU_PYTHON_BIN', 'ZHIHU_PYTHON_CWD', 'ZHIHU_TIMEOUT_MS',
    'ZHIHU_RETRIEVAL_PROFILE', 'ZHIHU_COMPILER_MAX_CALLS',
    'ZHIHU_SEARCH_LIMIT_PER_QUERY', 'ZHIHU_RESEARCH_DEADLINE_SECONDS',
    'PYTHON_DOTENV_DISABLED', 'PYTHONDONTWRITEBYTECODE',
    'DEEPSEEK_API_KEY', 'ZHIHU_ACCESS_SECRET')
$savedEnvironment = @{}
foreach ($name in $envNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$steps = [System.Collections.Generic.List[object]]::new()
$resultCode = 0
$reportPath = $null

function Invoke-CheckedNative {
    param([string]$Label, [string]$Executable, [string[]]$Arguments)
    Write-Host "`n[RUN] $Label"
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    & $Executable @Arguments
    $nativeExit = $LASTEXITCODE
    $timer.Stop()
    $steps.Add([ordered]@{ name = $Label; exitCode = $nativeExit; seconds = $timer.Elapsed.TotalSeconds })
    if ($nativeExit -ne 0) { throw 'A backend check returned a nonzero exit code.' }
}

try {
    Set-Location -LiteralPath $repoPath
    if ($Live -and $Mode -eq 'Test') { throw 'Live requires Mode Http or Serve.' }
    if (-not $Python) { $Python = Join-Path $repoPath '.venv\Scripts\python.exe' }
    $pythonPath = (Resolve-Path -LiteralPath $Python -ErrorAction Stop).Path
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $tsxPath = Join-Path $repoPath 'node_modules\tsx\dist\cli.mjs'
    $vitestPath = Join-Path $repoPath 'node_modules\vitest\vitest.mjs'
    $tscPath = Join-Path $repoPath 'node_modules\typescript\bin\tsc'
    foreach ($dependency in @($tsxPath, $vitestPath, $tscPath)) {
        if (-not (Test-Path -LiteralPath $dependency -PathType Leaf)) { throw 'Node dependencies are missing.' }
    }

    $runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $runPath = Join-Path $repoPath ('packages\zhihu\artifacts\local-backend-' + $runId)
    New-Item -ItemType Directory -Path $runPath -ErrorAction Stop | Out-Null
    $reportPath = Join-Path $runPath 'checks.json'
    $env:ZHILU_DATA_DIR = Join-Path $runPath 'data'
    $env:PYTHONDONTWRITEBYTECODE = '1'
    $env:ZHIHU_PYTHON_BIN = $pythonPath
    $env:ZHIHU_PYTHON_CWD = Join-Path $repoPath 'packages\zhihu'
    $env:ZHIHU_RETRIEVAL_PROFILE = $Profile
    $env:ZHIHU_LIVE_ENABLED = if ($Live) { 'true' } else { 'false' }
    $env:ZHIHU_COMPILER_MAX_CALLS = '3'
    $env:ZHIHU_SEARCH_LIMIT_PER_QUERY = '5'
    $env:ZHIHU_RESEARCH_DEADLINE_SECONDS = '600'
    $env:ZHIHU_TIMEOUT_MS = '630000'
    if ($Live) {
        # Python loads only its existing package-local .env; never copy or print it.
        [Environment]::SetEnvironmentVariable('PYTHON_DOTENV_DISABLED', $null, 'Process')
    } else {
        $env:PYTHON_DOTENV_DISABLED = '1'
        [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $null, 'Process')
        [Environment]::SetEnvironmentVariable('ZHIHU_ACCESS_SECRET', $null, 'Process')
    }
    Write-Host "Mode: $Mode; live: $([bool]$Live); profile: $Profile"
    Write-Host "Isolated artifacts: $runPath"

    if ($Mode -eq 'Test') {
        $env:NODE_ENV = 'test'
        $env:ZHIHU_RETRIEVAL_PROFILE = 'legacy'
        Push-Location -LiteralPath (Join-Path $repoPath 'packages\zhihu')
        try {
            Invoke-CheckedNative -Label 'Python backend suite (offline)' -Executable $pythonPath -Arguments @('-B', '-m', 'pytest', '-q')
        } finally { Pop-Location }
        Invoke-CheckedNative -Label 'Server and backend dependency tests (offline)' -Executable $nodePath -Arguments @(
            $vitestPath, 'run', 'apps/server/src', 'packages/agent-runtime/src', 'packages/plan-engine/src')
        Invoke-CheckedNative -Label 'Server typecheck' -Executable $nodePath -Arguments @(
            $tscPath, '--noEmit', '-p', 'apps/server/tsconfig.json')
        Invoke-CheckedNative -Label 'Full local HTTP flow (offline)' -Executable $nodePath -Arguments @(
            $tsxPath, 'apps/server/scripts/test_backend_http.ts')
    } elseif ($Mode -eq 'Http') {
        $httpArgs = @($tsxPath, 'apps/server/scripts/test_backend_http.ts')
        if ($Live) { $httpArgs += '--live' }
        Invoke-CheckedNative -Label 'Full local HTTP flow' -Executable $nodePath -Arguments $httpArgs
    } else {
        $env:NODE_ENV = 'development'
        $env:PORT = [string]$Port
        Write-Host "Server: http://127.0.0.1:$Port ; stop with Ctrl+C."
        Write-Host 'Only this run uses the displayed data directory. Existing data/ is untouched.'
        Invoke-CheckedNative -Label 'Local backend server' -Executable $nodePath -Arguments @(
            $tsxPath, 'apps/server/src/index.ts')
    }
    Write-Host "`n[PASS] All requested steps completed."
} catch {
    $resultCode = 1
    Write-Host "`n[FAIL] Backend check or startup failed. See the last check and checks.json."
    Write-Host 'Verify Node, .venv and installed dependencies. Test cannot use -Live; use -Mode Http or Serve.'
    # Never print a raw exception, environment, secret or upstream response here.
} finally {
    if ($reportPath) {
        $report = [ordered]@{ mode = $Mode; live = [bool]$Live; requestedProfile = $Profile;
            status = if ($resultCode -eq 0) { 'passed' } else { 'failed' };
            steps = @($steps.ToArray()); completedAt = [DateTime]::UtcNow.ToString('o') }
        try { $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding UTF8 }
        catch { $resultCode = 1; Write-Host '[FAIL] Could not save checks.json.' }
    }
    foreach ($name in $envNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    Set-Location -LiteralPath $savedDirectory.Path
}
exit $resultCode
