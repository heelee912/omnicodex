param(
    [Parameter(Mandatory = $true)][string]$EnginePackage
)

$ErrorActionPreference = 'Stop'
$packageRoot = (Resolve-Path -LiteralPath $EnginePackage -ErrorAction Stop).Path
$patch = Join-Path $packageRoot 'codex.exe'
$desktop = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $desktop) { throw 'Codex Desktop is not installed.' }
$stock = Join-Path $desktop.InstallLocation 'app\resources\codex.exe'
if (-not (Test-Path -LiteralPath $stock -PathType Leaf)) { throw 'Desktop engine is missing.' }
if (-not (Test-Path -LiteralPath $patch -PathType Leaf)) { throw 'Patched engine is missing.' }

$stockVersion = (& $stock --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Desktop engine version check failed.' }
$patchVersion = (& $patch --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $stockVersion -ne $patchVersion) {
    throw "Engine versions differ: Desktop=$stockVersion patch=$patchVersion"
}
$stockConfig = (& $stock app-server --print-startup-config | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Desktop app-server check failed.' }
$patchConfig = (& $patch app-server --print-startup-config | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $stockConfig.appServerVersion -ne $patchConfig.appServerVersion) {
    throw 'App-server versions differ.'
}

$dataDirectory = if ([string]::IsNullOrWhiteSpace($env:OMNICODEX_DATA_DIR)) {
    Join-Path $env:LOCALAPPDATA 'OmniCodex'
} else {
    [IO.Path]::GetFullPath($env:OMNICODEX_DATA_DIR)
}
$root = Join-Path $dataDirectory 'engine-generations'
$stage = Join-Path $PSScriptRoot 'stage-engine.mjs'
$selected = (& node $stage $packageRoot $root $patchVersion | Select-Object -Last 1).Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $selected -PathType Leaf)) {
    throw 'Engine generation was not staged.'
}
$selected = (Resolve-Path -LiteralPath $selected).Path
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $selected).Hash -ne
    (Get-FileHash -Algorithm SHA256 -LiteralPath $patch).Hash) {
    throw 'Staged engine executable differs from the verified build.'
}

$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $registry) { $registry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment') }
try {
    $oldValue = $registry.GetValue('CODEX_CLI_PATH', $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $backup = Join-Path $root 'desktop-engine-environment-backup.json'
    $sameEngine = ([string]$oldValue).Equals($selected, [StringComparison]::OrdinalIgnoreCase)
    $previousGeneration = ([string]$oldValue).StartsWith(($root + '\'), [StringComparison]::OrdinalIgnoreCase)
    if (-not [string]::IsNullOrWhiteSpace([string]$oldValue) -and
        -not $sameEngine -and
        -not ($previousGeneration -and (Test-Path -LiteralPath $backup -PathType Leaf))) {
        throw "CODEX_CLI_PATH is already configured elsewhere: $oldValue"
    }
    if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
        $snapshot = [ordered]@{
            SchemaVersion = 1
            CliExists = $null -ne $oldValue
            CliValue = $oldValue
            CliKind = if ($null -eq $oldValue) { $null } else { [string]$registry.GetValueKind('CODEX_CLI_PATH') }
        }
        [IO.File]::WriteAllText($backup, ($snapshot | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
    }
    $registry.SetValue('CODEX_CLI_PATH', $selected, [Microsoft.Win32.RegistryValueKind]::String)
} finally {
    $registry.Dispose()
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DesktopEngineEnvironmentNotice {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam,
        IntPtr lParam, uint flags, uint timeoutMs, out IntPtr result);
}
'@
$environmentText = [Runtime.InteropServices.Marshal]::StringToHGlobalUni('Environment')
try {
    $ignored = [IntPtr]::Zero
    [void][DesktopEngineEnvironmentNotice]::SendMessageTimeout(
        [IntPtr]::new(0xffff), 0x1a, [IntPtr]::Zero, $environmentText, 0x2, 5000, [ref]$ignored)
} finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($environmentText)
}

Write-Output "Desktop engine override: $selected"
Write-Output "Engine version: $patchVersion"
Write-Output 'Desktop will load this engine after a full application restart.'
