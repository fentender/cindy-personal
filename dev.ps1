[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Test,
    [switch]$InstallDependencies,
    [switch]$Mock,
    [switch]$Shared,
    [switch]$TakeoverMetro,
    [ValidateSet('windows', 'android')][string]$Target = 'windows',
    [string]$Avd = 'Pixel_3a_API_34_extension_level_7_x86_64',
    [ValidateSet('global', 'cn')]
    [string]$Region = 'cn'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Invoke-Tool {
    param([string]$Command, [string[]]$Arguments)

    Write-Host "`n> $Command $($Arguments -join ' ')" -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败，退出码 ${LASTEXITCODE}：$Command $($Arguments -join ' ')"
    }
}

# 使用项目锁定的 pnpm，缓存与工具均放在 E 盘。
$env:Path = 'E:\data\tools\pnpm;' + $env:Path
$env:COREPACK_HOME = 'E:\data\cache\corepack'
$env:npm_config_cache = 'E:\data\cache\npm'
$env:NODE_USE_ENV_PROXY = '1'
$env:ELECTRON_GET_USE_PROXY = '1'
$env:electron_config_cache = 'E:\data\cache\electron'
$env:pnpm_config_store_dir = 'E:\data\cache\pnpm-store'
New-Item -ItemType Directory -Path 'E:\data\tools\pnpm' -Force | Out-Null
Invoke-Tool 'corepack.cmd' @('enable', '--install-directory', 'E:\data\tools\pnpm')
Invoke-Tool 'node.exe' @('--version')
if ($InstallDependencies) {
    Invoke-Tool 'git.exe' @('lfs', 'pull')
    Invoke-Tool 'pnpm.cmd' @('install', '--frozen-lockfile', '--store-dir', 'E:\data\cache\pnpm-store')
}
if ($Target -eq 'android') {
    if (-not $env:CARGO_HOME -and (Test-Path -LiteralPath 'E:\data\tools\rust\cargo')) { $env:CARGO_HOME = 'E:\data\tools\rust\cargo' }
    if (-not $env:RUSTUP_HOME -and (Test-Path -LiteralPath 'E:\data\tools\rust\rustup')) { $env:RUSTUP_HOME = 'E:\data\tools\rust\rustup' }
    if ($env:CARGO_HOME) { $env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path }
    Invoke-Tool 'cargo.exe' @('ndk', '--version')
    Invoke-Tool 'pnpm.cmd' @('--filter', 'mobile', 'typecheck')
    if ($CheckOnly) { Write-Host 'DEV_CHECKS=passed'; return }
    # Metro 先就绪，rebuild 才能在装机后核对归属并启动开发客户端。
    $metroLog = Join-Path ([System.IO.Path]::GetTempPath()) ('cindy-personal-metro-' + [guid]::NewGuid().ToString('N'))
    $metroArguments = @(('"' + (Join-Path $PSScriptRoot 'apps\mobile\scripts\sim-start.mjs') + '"'), "--region=$Region", ('--avd="' + $Avd + '"'))
    if ($Mock) { $metroArguments += '--mock' }
    if ($TakeoverMetro) { $metroArguments += '--takeover' }
    $metro = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $metroArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "$metroLog.out.log" -RedirectStandardError "$metroLog.err.log"
    $deadline = (Get-Date).AddSeconds(210)
    $metroReady = $false
    $metroCheckArguments = @('apps/mobile/scripts/sim-metro-ready.mjs', "--region=$Region")
    if ($Mock) { $metroCheckArguments += '--mock' }
    $metroIdentity = 'Metro 尚未响应'
    while ((Get-Date) -lt $deadline) {
        $metro.Refresh()
        if ($metro.HasExited -and $metro.ExitCode -ne 0) { throw "Metro 启动失败：$metroLog.err.log" }
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:8081/status' -UseBasicParsing -TimeoutSec 2
            # Metro 未声明文本编码时，PowerShell 会返回原始字节。
            $statusText = if ($response.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($response.Content) } else { $response.Content }
            if ($statusText -match 'packager-status:running') {
                $metroIdentity = & node.exe @metroCheckArguments
                if ($LASTEXITCODE -eq 0) { $metroReady = $true; break }
                if ($LASTEXITCODE -ne 2) { throw 'Metro 身份检查执行失败' }
                # 同工作区切换源码、区域或 Mock 时，启动器正在替换旧 Metro。
            }
        } catch [System.Net.WebException], [System.Net.Http.HttpRequestException], [System.Threading.Tasks.TaskCanceledException] {
            # 启动期连接尚未建立，继续等待本次进程或超时。
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not $metroReady) { throw "Metro 未在限定时间就绪（$metroIdentity）：$metroLog.err.log" }
    $mobileArguments = @('mobile:sim:rebuild', "--region=$Region", "--avd=$Avd")
    if ($Mock) { $mobileArguments += '--mock' }
    Invoke-Tool 'pnpm.cmd' $mobileArguments
    Write-Host "Metro 日志：$metroLog.out.log"
    return
}
Invoke-Tool 'pnpm.cmd' @('--filter', 'desktop', 'typecheck')

if ($Test -or $CheckOnly) {
    Invoke-Tool 'node.exe' @('--test', '--test-timeout=120000', 'scripts/__tests__/dev-docs-contract.test.mjs', 'scripts/__tests__/restart-desktop-remote.test.mjs')
}

Invoke-Tool 'pnpm.cmd' @('--filter', 'desktop', 'build:remote-bundles')
Write-Host 'DEV_CHECKS=passed' -ForegroundColor Green
if (-not $CheckOnly) {
    # 官方启动器负责隔离数据、编译界面和检查窗口就绪。
    $desktopArguments = @('restart:desktop:remote', "--region=$Region")
    if ($Mock) { $desktopArguments += '--mock' }
    if ($Shared) { $desktopArguments += @('--shared', '--passive') }
    else { $desktopArguments += '--isolated=project-preview' }
    Invoke-Tool 'pnpm.cmd' $desktopArguments
}
