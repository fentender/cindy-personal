[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Repository = 'fentender/cindy-personal',
    [ValidateSet('all', 'windows', 'android', 'collect')][string]$Target = 'all',
    [switch]$VerifyOnly,
    [switch]$Publish
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-BuildTool {
    param([string]$Command, [string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "构建命令失败（$LASTEXITCODE）：$Command" }
}

$environmentKeys = @('CINDY_PERSONAL_RELEASE_REPOSITORY', 'EXPO_PUBLIC_CINDY_PERSONAL_RELEASE_REPOSITORY',
    'CINDY_PERSONAL_RELEASE_VERSION', 'EXPO_PUBLIC_CINDY_AUTH_REGION', 'JAVA_HOME', 'ANDROID_HOME', 'Path',
    'CARGO_HOME', 'RUSTUP_HOME', 'WindowsSdkDir', 'COREPACK_HOME', 'pnpm_config_store_dir',
    'pnpm_config_verify_deps_before_run', 'CINDY_SELF_HOST_REGIONS_FILE', 'CINDY_SIGNING_PASSWORD',
    'XDT_ANDROID_KEYSTORE_PASSWORD_CN', 'XDT_ANDROID_KEY_PASSWORD_CN')
$previousEnvironment = @{}
foreach ($key in $environmentKeys) { $previousEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
Push-Location -LiteralPath $PSScriptRoot
try {
if ($Repository -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*$') {
    throw 'Repository 必须是 owner/repository'
}
$versionCode = & node.exe scripts/personal-release.mjs version-code $Version
if ($LASTEXITCODE -ne 0) { throw '个人发行版本号无效' }
$outputDirectory = Join-Path $PSScriptRoot "release\personal\$Version"

# 本地工具链由环境或现有安装决定；签名资料只保存在仓库外的个人构建目录。
$privateDirectory = Join-Path $env:LOCALAPPDATA 'CindyPersonalBuild'
$javaDirectory = Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'
if (-not $env:JAVA_HOME -and (Test-Path -LiteralPath $javaDirectory)) { $env:JAVA_HOME = $javaDirectory }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if ($env:JAVA_HOME) { $env:Path = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:Path }

if ($Target -ne 'collect') {
    Invoke-BuildTool 'node.exe' @('--test', 'scripts/__tests__/personal-release.test.mjs')
    if ($Target -in @('all', 'windows')) {
        Push-Location packages/maker-core
        try { Invoke-BuildTool 'node.exe' @('../../node_modules/vitest/vitest.mjs', 'run', 'src/agents/antigravity', '--reporter=dot') }
        finally { Pop-Location }
        Push-Location apps/desktop
        try {
            Invoke-BuildTool 'node.exe' @('--max-old-space-size=12288', '../../node_modules/typescript/bin/tsc', '--noEmit')
            Invoke-BuildTool 'node.exe' @('../../node_modules/vitest/vitest.mjs', 'run', 'src/main/__tests__/manifestService.test.ts', 'src/main/__tests__/updateService.test.ts', '--reporter=dot')
        } finally { Pop-Location }
    }
    if ($Target -in @('all', 'android')) {
        Push-Location apps/mobile
        try {
            Invoke-BuildTool 'node.exe' @('--max-old-space-size=12288', 'node_modules/typescript/bin/tsc', '--noEmit')
            Invoke-BuildTool 'node.exe' @('../../node_modules/vitest/vitest.mjs', 'run', 'src/__tests__/nativeAppConfig.test.ts', 'src/update/bundleUpdate.test.ts', 'src/update/fetchLatestRelease.test.ts', '--reporter=dot')
        } finally { Pop-Location }
    }
}
if ($VerifyOnly) { Write-Host 'PERSONAL_RELEASE_CHECKS=passed'; return }
$env:CINDY_PERSONAL_RELEASE_REPOSITORY = $Repository
$env:EXPO_PUBLIC_CINDY_PERSONAL_RELEASE_REPOSITORY = $Repository
$env:CINDY_PERSONAL_RELEASE_VERSION = $Version
$env:EXPO_PUBLIC_CINDY_AUTH_REGION = 'cn'
if (-not $env:CARGO_HOME -and (Test-Path -LiteralPath 'E:\data\tools\rust\cargo')) { $env:CARGO_HOME = 'E:\data\tools\rust\cargo' }
if (-not $env:RUSTUP_HOME -and (Test-Path -LiteralPath 'E:\data\tools\rust\rustup')) { $env:RUSTUP_HOME = 'E:\data\tools\rust\rustup' }
if ($env:CARGO_HOME) { $env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path }
if (-not $env:WindowsSdkDir -and (Test-Path -LiteralPath 'F:\Windows Kits\10')) { $env:WindowsSdkDir = 'F:\Windows Kits\10\' }
if (Test-Path -LiteralPath 'E:\data\cache\corepack') {
    $env:COREPACK_HOME = 'E:\data\cache\corepack'
    $env:Path = 'E:\data\tools\pnpm;' + $env:Path
    $env:pnpm_config_store_dir = 'E:\data\cache\pnpm-store'
}
$env:pnpm_config_verify_deps_before_run = 'false'

if ($Target -in @('all', 'windows')) {
    Push-Location apps/desktop
    try { Invoke-BuildTool 'node.exe' @('scripts/package-desktop.mjs', '--region', 'cn', '--platform', 'win32', '--arch', 'x64', '--no-sign', '--version', $Version) }
    finally { Pop-Location }
}

if ($Target -in @('all', 'android')) {
    Invoke-BuildTool 'cargo.exe' @('ndk', '--version')
    New-Item -ItemType Directory -Path $privateDirectory -Force | Out-Null
    $keystore = Join-Path $privateDirectory 'android-release.p12'
    $secretFile = Join-Path $privateDirectory 'android-signing.dpapi'
    if ((Test-Path -LiteralPath $keystore) -ne (Test-Path -LiteralPath $secretFile)) {
        throw '签名文件不完整；请恢复原 keystore 和 DPAPI 口令，不能生成另一把密钥覆盖已发布应用'
    }
    if (-not (Test-Path -LiteralPath $secretFile)) {
        $randomBytes = New-Object byte[] 32
        $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($randomBytes) } finally { $generator.Dispose() }
        $signingSecret = ConvertTo-SecureString ([Convert]::ToBase64String($randomBytes)) -AsPlainText -Force
        ConvertFrom-SecureString $signingSecret | Set-Content -LiteralPath $secretFile
    } else {
        $signingSecret = ConvertTo-SecureString (Get-Content -LiteralPath $secretFile -Raw).Trim()
    }
    $credential = New-Object System.Management.Automation.PSCredential('android-signing', $signingSecret)
    $env:CINDY_SIGNING_PASSWORD = $credential.GetNetworkCredential().Password
    try {
        if (-not (Test-Path -LiteralPath $keystore)) {
            Invoke-BuildTool 'keytool.exe' @('-genkeypair', '-keystore', $keystore, '-storetype', 'PKCS12', '-alias', 'cindy-personal',
                '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Cindy Personal',
                '-storepass:env', 'CINDY_SIGNING_PASSWORD', '-keypass:env', 'CINDY_SIGNING_PASSWORD')
        }
        $regions = Get-Content apps/mobile/scripts/self-host-regions.json.example -Raw | ConvertFrom-Json
        $regions.cn.androidPackage = 'cn.fentender.cindy'
        $regions.cn.iosBundleId = 'cn.fentender.cindy'
        $regions.cn.androidSigning.keystorePath = $keystore
        $regions.cn.androidSigning.keyAlias = 'cindy-personal'
        $env:CINDY_SELF_HOST_REGIONS_FILE = Join-Path $privateDirectory 'regions.json'
        [System.IO.File]::WriteAllText($env:CINDY_SELF_HOST_REGIONS_FILE, ($regions | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
        $env:XDT_ANDROID_KEYSTORE_PASSWORD_CN = $env:CINDY_SIGNING_PASSWORD
        $env:XDT_ANDROID_KEY_PASSWORD_CN = $env:CINDY_SIGNING_PASSWORD
        Invoke-BuildTool 'node.exe' @('apps/mobile/scripts/build-android.mjs', '--region', 'cn', '--execute', '--skip-git-gate',
            '--artifacts', 'apk', '--version-code', "$versionCode", '--desktop-version', $Version, '--out', $outputDirectory)
    } finally {
        Remove-Item Env:CINDY_SIGNING_PASSWORD -ErrorAction SilentlyContinue
        Remove-Item Env:XDT_ANDROID_KEYSTORE_PASSWORD_CN -ErrorAction SilentlyContinue
        Remove-Item Env:XDT_ANDROID_KEY_PASSWORD_CN -ErrorAction SilentlyContinue
    }
}

if ($Target -in @('all', 'collect')) {
    Invoke-BuildTool 'node.exe' @('scripts/personal-release.mjs', 'collect', $Version, $Repository)
} elseif ($Publish) {
    throw '发布需要 Windows 与 Android 的完整产物，请使用 -Target collect -Publish'
}

if ($Publish) {
    # 先建草稿、上传完整资产，再发布，latest 不会指向缺少安装包的半成品。
    $githubCli = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
    if (-not (Test-Path -LiteralPath $githubCli)) { $githubCli = (Get-Command gh.exe -ErrorAction Stop).Source }
    Invoke-BuildTool $githubCli @('repo', 'view', $Repository)
    Invoke-BuildTool $githubCli @('release', 'create', "v$Version", '--repo', $Repository, '--draft', '--title', "Cindy Personal $Version", '--notes', "Cindy Personal $Version")
    $assets = @("Cindy-Personal-$Version-Windows-x64.exe", "Cindy-Personal-$Version-Windows-x64.zip", "Cindy-Personal-$Version-Android.apk", 'manifest-win32-x64.json', 'mobile-android.json', 'SHA256SUMS')
    $uploadArguments = @('release', 'upload', "v$Version", '--repo', $Repository) + @($assets | ForEach-Object { Join-Path $outputDirectory $_ })
    Invoke-BuildTool $githubCli $uploadArguments
    Invoke-BuildTool $githubCli @('release', 'edit', "v$Version", '--repo', $Repository, '--draft=false', '--latest')
}
} finally {
    foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $previousEnvironment[$key], 'Process') }
    Pop-Location
}
