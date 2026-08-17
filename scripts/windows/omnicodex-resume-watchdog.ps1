[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$ThreadId = '019f97a8-0ad8-7bb2-82e8-65c689b30de0'
$ProjectDirectory = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AutomationFile = Join-Path $env:USERPROFILE '.codex\automations\omnicodex\automation.toml'
$ThreadLockFile = Join-Path $env:USERPROFILE ".codex\thread-writer-locks\$ThreadId.lock"
$StateDirectory = Join-Path $env:USERPROFILE '.codex\automation-recovery'
$StateLog = Join-Path $StateDirectory 'omnicodex-watchdog.log'

function Write-WatchdogState {
    param([Parameter(Mandatory = $true)][string]$State)

    if (-not (Test-Path -LiteralPath $StateDirectory)) {
        New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    }

    if ((Test-Path -LiteralPath $StateLog) -and
        (Get-Item -LiteralPath $StateLog).Length -gt 65536) {
        Move-Item -LiteralPath $StateLog -Destination "$StateLog.previous" -Force
    }

    Add-Content -LiteralPath $StateLog -Value ("{0} {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $State)
}

if (Test-Path -LiteralPath $AutomationFile) {
    try {
        $AutomationText = [System.IO.File]::ReadAllText($AutomationFile)
        $HasActiveStatus = $AutomationText -match '(?m)^status\s*=\s*"ACTIVE"\s*$'
        $HasFiveMinuteRule = $AutomationText -match '(?m)^rrule\s*=\s*"FREQ=MINUTELY;INTERVAL=5"\s*$'
        $HasCurrentThread = $AutomationText -match ('(?m)^target_thread_id\s*=\s*"{0}"\s*$' -f [regex]::Escape($ThreadId))

        if ($HasActiveStatus -and $HasFiveMinuteRule -and $HasCurrentThread) {
            Write-WatchdogState 'official-heartbeat-active'
            exit 0
        }
    }
    catch {
        Write-WatchdogState 'official-heartbeat-read-retry'
        exit 0
    }
}

$LockDirectory = Split-Path -Parent $ThreadLockFile
if (-not (Test-Path -LiteralPath $LockDirectory)) {
    New-Item -ItemType Directory -Path $LockDirectory -Force | Out-Null
}

$LockStream = $null
try {
    $LockStream = [System.IO.File]::Open(
        $ThreadLockFile,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
}
catch {
    Write-WatchdogState 'thread-busy'
    exit 0
}

$CodexCandidates = @(
    (Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\codex.exe')
)
$CodexExecutable = $CodexCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ([string]::IsNullOrWhiteSpace($CodexExecutable)) {
    $LockStream.Dispose()
    Write-WatchdogState 'codex-runtime-missing'
    exit 1
}

$ResumePrompt = @'
Resume the current OmniCodex goal after reboot. First read the active Goal and the latest user instructions, then continue the real OmniCodex work safely. If the official omnicodex heartbeat is missing or inactive, restore it on this same thread as ACTIVE with a five-minute interval as soon as the app management bridge is available. Never delete the overall OmniCodex Goal or its recurring automation merely because a subgoal finished. Never open a foreground cmd, PowerShell, or Terminal window. Keep every local child process hidden. Do not modify or interrupt the existing Codex app login, settings, or user sessions. Do not touch OCI trading runtimes, ports, directories, or credentials. Do not infer success; verify real state and the real user flow.
'@

Write-WatchdogState 'resume-started'
try {
    Set-Location -LiteralPath $ProjectDirectory
    & $CodexExecutable exec resume --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check $ThreadId $ResumePrompt | Out-Null
    $CodexExitCode = $LASTEXITCODE
    Write-WatchdogState ("resume-finished exit={0}" -f $CodexExitCode)
    exit $CodexExitCode
}
finally {
    $LockStream.Dispose()
}
