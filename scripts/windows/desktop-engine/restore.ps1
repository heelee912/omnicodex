$ErrorActionPreference = 'Stop'
$dataDirectory = if ([string]::IsNullOrWhiteSpace($env:OMNICODEX_DATA_DIR)) {
    Join-Path $env:LOCALAPPDATA 'OmniCodex'
} else {
    [IO.Path]::GetFullPath($env:OMNICODEX_DATA_DIR)
}
$root = Join-Path $dataDirectory 'engine-generations'
$backup = Join-Path $root 'desktop-engine-environment-backup.json'
if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
    throw 'Desktop engine environment recovery record is missing.'
}
$snapshot = Get-Content -Raw -LiteralPath $backup | ConvertFrom-Json
if ($snapshot.SchemaVersion -ne 1) { throw 'Desktop engine environment recovery record is unsupported.' }
$registry = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $registry) { throw 'User environment registry key is missing.' }
try {
    $current = [string]$registry.GetValue('CODEX_CLI_PATH', '',
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not $current.StartsWith(($root + '\'), [StringComparison]::OrdinalIgnoreCase) -or
        -not $current.EndsWith('\package\codex.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'CODEX_CLI_PATH is no longer set to the installed Desktop engine.'
    }
    if ($snapshot.CliExists) {
        $kind = [Enum]::Parse([Microsoft.Win32.RegistryValueKind], [string]$snapshot.CliKind)
        $registry.SetValue('CODEX_CLI_PATH', [string]$snapshot.CliValue, $kind)
    } else {
        $registry.DeleteValue('CODEX_CLI_PATH', $false)
    }
} finally {
    $registry.Dispose()
}
Write-Output 'Original CODEX_CLI_PATH restored. Desktop must be fully restarted to load it.'
