[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [string]$SourceHost,
    [string]$TargetIdentityFile = "$HOME\.ssh\omnicodex-oracle-a1-ed25519",
    [string]$BackhaulIdentityFile = "$env:LOCALAPPDATA\OmniCodex\secrets\oracle-backhaul-ed25519",
    [string]$BackhaulPublicKeyFile = "$env:LOCALAPPDATA\OmniCodex\secrets\oracle-backhaul-ed25519.pub",
    [int]$LocalCdpPort = 0,
    [string]$StateFile = "$env:LOCALAPPDATA\OmniCodex\a1-capacity-state.json"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$currentConfig = Get-Content -Raw -LiteralPath "$env:LOCALAPPDATA\OmniCodex\config.json" | ConvertFrom-Json
$currentDaemon = Get-Content -Raw -LiteralPath "$env:LOCALAPPDATA\OmniCodex\state.json" | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($SourceHost)) { $SourceHost = $currentConfig.tunnel.sshHost }
if ($currentDaemon.lifecycle -ne 'ready') { throw 'Current OmniCodex daemon must be ready for parallel deployment' }
$localGatewayPort = [int]$currentDaemon.address.port
if ($LocalCdpPort -eq 0) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); $LocalCdpPort = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
}

function Assert-Executable([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label is missing: $Path"
    }
}

function Invoke-Native([string]$Executable, [string[]]$Arguments) {
    $output = & $Executable @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "$Executable failed with exit code $LASTEXITCODE`n$($output -join "`n")"
    }
    return $output
}

$parsedAddress = $null
if (-not [System.Net.IPAddress]::TryParse($TargetHost, [ref]$parsedAddress) -or
    $parsedAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "TargetHost must be one exact IPv4 address: $TargetHost"
}
if ($TargetHost -eq $SourceHost) {
    throw 'TargetHost must not be the existing E2 host'
}
$parsedSourceAddress = $null
if (-not [System.Net.IPAddress]::TryParse($SourceHost, [ref]$parsedSourceAddress) -or
    $parsedSourceAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "SourceHost must be one exact IPv4 address: $SourceHost"
}
if ($LocalCdpPort -lt 1024 -or $LocalCdpPort -gt 65535 -or $LocalCdpPort -eq 19222) {
    throw 'LocalCdpPort must be an unused non-privileged port other than the existing E2 port 19222'
}

$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
Assert-Executable $ssh 'OpenSSH client'
Assert-Executable $scp 'OpenSSH secure-copy client'
Assert-Executable $TargetIdentityFile 'new A1 identity'
Assert-Executable $BackhaulIdentityFile 'backhaul identity'
Assert-Executable $BackhaulPublicKeyFile 'backhaul public key'

$scriptRoot = Split-Path -Parent $PSCommandPath
$deploymentFiles = @(
    'install-a1-parallel-host.sh',
    'install-backhaul-user.sh',
    'install-ip-ingress.sh',
    'install-managed-caddy.py',
    'install-oracle-browser-host.sh',
    'oracle-browser-profile.py',
    'oracle-browser-run.sh',
    'omnicodex-oracle-xvfb.service',
    'omnicodex-oracle-browser.service'
) | ForEach-Object {
    $path = Join-Path $scriptRoot $_
    Assert-Executable $path "deployment file $_"
    $path
}

$sourceStateText = Get-Content -Raw -LiteralPath $StateFile
$sourceState = $sourceStateText | ConvertFrom-Json
$acceptedStates = @('created', 'waiting_for_upgrade_capacity', 'target_reached')
if ($sourceState.status -notin $acceptedStates) {
    throw "A1 state is not deployable yet: $($sourceState.status)"
}
if ($sourceState.public_ip -ne $TargetHost) {
    throw "TargetHost does not match the OCI watcher state: $($sourceState.public_ip)"
}
if ([double]$sourceState.ocpus -ne 2.0 -or [double]$sourceState.memory_gb -lt 2.0 -or [double]$sourceState.memory_gb -gt 12.0) {
    throw 'OCI watcher state does not describe the guarded 2 OCPU / 2-12 GB A1 target'
}

$dataDirectory = Join-Path $env:LOCALAPPDATA 'OmniCodex'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$knownHosts = Join-Path $dataDirectory 'oracle-a1-known-hosts'
$hostOptions = @(
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ConnectionAttempts=2',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', "UserKnownHostsFile=$knownHosts"
)

Invoke-Native $ssh @(
    '-i', $TargetIdentityFile,
    @($hostOptions),
    "ubuntu@$TargetHost",
    'cloud-init status --wait && test "$(uname -m)" = aarch64'
) | Out-Null

$nonce = [Guid]::NewGuid().ToString('N')
$remoteStage = "/home/ubuntu/.omnicodex-a1-bootstrap-$nonce"
$backhaulPublicKeyName = 'oracle-backhaul-ed25519.pub'
$backhaulProcess = $null
$cdpProcess = $null

try {
    Invoke-Native $ssh @(
        '-i', $TargetIdentityFile,
        @($hostOptions),
        "ubuntu@$TargetHost",
        "install -d -m 0700 '$remoteStage'"
    ) | Out-Null

    Invoke-Native $scp @(
        '-q',
        '-i', $TargetIdentityFile,
        @($hostOptions),
        @($deploymentFiles),
        $BackhaulPublicKeyFile,
        "ubuntu@${TargetHost}:$remoteStage/"
    ) | Out-Null

    Invoke-Native $ssh @(
        '-i', $TargetIdentityFile,
        @($hostOptions),
        "ubuntu@$TargetHost",
        "sudo bash '$remoteStage/install-a1-parallel-host.sh' '$TargetHost' '$remoteStage/$backhaulPublicKeyName' auto"
    ) | Out-Null

    $backhaulArguments = @(
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$knownHosts",
        '-i', $BackhaulIdentityFile,
        '-R', "127.0.0.1:18766:127.0.0.1:$localGatewayPort",
        "omnicodex-backhaul@$TargetHost"
    )
    $backhaulProcess = Start-Process -FilePath $ssh -ArgumentList $backhaulArguments -WindowStyle Hidden -PassThru

    $cdpArguments = @(
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', "UserKnownHostsFile=$knownHosts",
        '-i', $TargetIdentityFile,
        '-L', "127.0.0.1:${LocalCdpPort}:127.0.0.1:19222",
        "ubuntu@$TargetHost"
    )
    $cdpProcess = Start-Process -FilePath $ssh -ArgumentList $cdpArguments -WindowStyle Hidden -PassThru

    Start-Sleep -Seconds 3
    if ($backhaulProcess.HasExited) {
        throw "A1 backhaul exited early with code $($backhaulProcess.ExitCode)"
    }
    if ($cdpProcess.HasExited) {
        throw "A1 CDP tunnel exited early with code $($cdpProcess.ExitCode)"
    }

    $cdpVersion = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalCdpPort/json/version" -TimeoutSec 10
    if ([string]::IsNullOrWhiteSpace([string]$cdpVersion.Browser) -or
        [string]::IsNullOrWhiteSpace([string]$cdpVersion.webSocketDebuggerUrl)) {
        throw 'A1 CDP authoritative readback is incomplete'
    }

    $publicStatus = & "$env:WINDIR\System32\curl.exe" -sS -o NUL -w '%{http_code}' --max-time 15 "https://$TargetHost/mcp/full"
    if ($LASTEXITCODE -ne 0 -or $publicStatus -ne '401') {
        throw "A1 HTTPS ingress readback failed with status $publicStatus"
    }

    $runtimeState = [ordered]@{
        schemaVersion = 1
        targetHost = $TargetHost
        publicUrl = "https://$TargetHost/mcp/full"
        memoryGb = [double]$sourceState.memory_gb
        backhaulPid = $backhaulProcess.Id
        cdpTunnelPid = $cdpProcess.Id
        localCdpEndpoint = "http://127.0.0.1:$LocalCdpPort"
        browser = [string]$cdpVersion.Browser
        createdAt = [DateTimeOffset]::UtcNow.ToString('O')
    }
    $runtimePath = Join-Path $dataDirectory 'a1-parallel-runtime.json'
    $runtimeState | ConvertTo-Json | Set-Content -LiteralPath $runtimePath -Encoding utf8NoBOM

    [pscustomobject]$runtimeState
}
catch {
    foreach ($process in @($cdpProcess, $backhaulProcess)) {
        if ($null -ne $process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
    }
    throw
}
finally {
    try {
        Invoke-Native $ssh @(
            '-i', $TargetIdentityFile,
            @($hostOptions),
            "ubuntu@$TargetHost",
            "rm -rf -- '$remoteStage'"
        ) | Out-Null
    }
    catch {
        Write-Warning "Could not remove the exact A1 staging directory $remoteStage"
    }
}
