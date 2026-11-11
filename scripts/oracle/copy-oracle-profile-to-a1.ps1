[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [Parameter(Mandatory = $true)]
    [switch]$AllowBriefSourceBrowserPause,

    [string]$SourceHost,
    [string]$SourceIdentityFile,
    [string]$TargetIdentityFile = "$HOME\.ssh\omnicodex-oracle-a1-ed25519"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$currentConfig = Get-Content -Raw -LiteralPath "$env:LOCALAPPDATA\OmniCodex\config.json" | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($SourceHost)) { $SourceHost = $currentConfig.oracle.remoteCdpTunnel.sshHost }
if ([string]::IsNullOrWhiteSpace($SourceIdentityFile)) { $SourceIdentityFile = $currentConfig.oracle.remoteCdpTunnel.identityFile }

function Assert-File([string]$Path, [string]$Label) {
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

if (-not $AllowBriefSourceBrowserPause) {
    throw 'Authenticated profile copy requires -AllowBriefSourceBrowserPause because the E2 browser must stop briefly for a consistent snapshot'
}
$targetAddress = $null
$sourceAddress = $null
if (-not [System.Net.IPAddress]::TryParse($TargetHost, [ref]$targetAddress) -or
    $targetAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "TargetHost must be one exact IPv4 address: $TargetHost"
}
if (-not [System.Net.IPAddress]::TryParse($SourceHost, [ref]$sourceAddress) -or
    $sourceAddress.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "SourceHost must be one exact IPv4 address: $SourceHost"
}
if ($TargetHost -eq $SourceHost) {
    throw 'TargetHost must not be the existing E2 host'
}

$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"
$scp = "$env:WINDIR\System32\OpenSSH\scp.exe"
Assert-File $ssh 'OpenSSH client'
Assert-File $scp 'OpenSSH secure-copy client'
Assert-File $SourceIdentityFile 'existing E2 identity'
Assert-File $TargetIdentityFile 'new A1 identity'

$dataDirectory = Join-Path $env:LOCALAPPDATA 'OmniCodex'
$runtimePath = Join-Path $dataDirectory 'a1-parallel-runtime.json'
$targetKnownHosts = Join-Path $dataDirectory 'oracle-a1-known-hosts'
$sourceKnownHosts = Join-Path $HOME '.ssh\known_hosts'
Assert-File $runtimePath 'A1 parallel runtime state'
Assert-File $targetKnownHosts 'A1 host-key record'
Assert-File $sourceKnownHosts 'existing E2 host-key record'

$runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
if ($runtime.targetHost -ne $TargetHost) {
    throw "TargetHost does not match the deployed A1 runtime: $($runtime.targetHost)"
}
$backhaulProcess = Get-Process -Id ([int]$runtime.backhaulPid) -ErrorAction SilentlyContinue
$cdpProcess = Get-Process -Id ([int]$runtime.cdpTunnelPid) -ErrorAction SilentlyContinue
if ($null -eq $backhaulProcess -or $backhaulProcess.ProcessName -ne 'ssh' -or
    $null -eq $cdpProcess -or $cdpProcess.ProcessName -ne 'ssh') {
    throw 'A1 parallel tunnel ownership is not live; refusing profile transfer'
}

$sourceOptions = @(
    '-i', $SourceIdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes'
)
$targetOptions = @(
    '-i', $TargetIdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$targetKnownHosts"
)

$targetProfile = (
    Invoke-Native $ssh @(
        @($targetOptions),
        "ubuntu@$TargetHost",
        "sed -n 's/^ORACLE_BROWSER_PROFILE=//p' /etc/omnicodex-oracle-browser.env"
    ) | Out-String
).Trim()
$allowedTargetProfiles = @(
    '/home/ubuntu/snap/chromium/common/omnicodex-profile',
    '/home/ubuntu/omnicodex-lab/home/.oracle/browser-profile'
)
if ($targetProfile -notin $allowedTargetProfiles) {
    throw "A1 browser returned an unexpected profile path: $targetProfile"
}

$sourceProfile = (
    Invoke-Native $ssh @(@($sourceOptions), "ubuntu@$SourceHost",
        "sed -n 's/^ORACLE_BROWSER_PROFILE=//p' /etc/omnicodex-oracle-browser.env") | Out-String
).Trim()
if ($sourceProfile -notin $allowedTargetProfiles) {
    throw "Source browser returned an unexpected profile path: $sourceProfile"
}
$nonce = [Guid]::NewGuid().ToString('N')
$archiveName = ".omnicodex-profile-transfer-$nonce.tar"
$remoteArchive = "/home/ubuntu/$archiveName"
$incomingProfile = "$targetProfile.incoming-$nonce"
$previousProfile = "$targetProfile.pre-transfer-$nonce"
$sourceBrowserStopped = $false
$targetBrowserStopped = $false
$sshConfig = New-TemporaryFile

try {
    try {
        Invoke-Native $ssh @(
            @($sourceOptions),
            "ubuntu@$SourceHost",
            'sudo systemctl stop omnicodex-oracle-browser.service'
        ) | Out-Null
        $sourceBrowserStopped = $true
        Invoke-Native $ssh @(
            @($sourceOptions),
            "ubuntu@$SourceHost",
            "test -d '$sourceProfile' && tar -C '$sourceProfile' -cf '$remoteArchive' ."
        ) | Out-Null
    }
    finally {
        if ($sourceBrowserStopped) {
            Invoke-Native $ssh @(
                @($sourceOptions),
                "ubuntu@$SourceHost",
                'sudo systemctl start omnicodex-oracle-browser.service && sudo systemctl is-active --quiet omnicodex-oracle-browser.service'
            ) | Out-Null
            $sourceBrowserStopped = $false
        }
    }

    $sourceHash = (
        Invoke-Native $ssh @(
            @($sourceOptions),
            "ubuntu@$SourceHost",
            "sha256sum '$remoteArchive' | cut -d' ' -f1"
        ) | Out-String
    ).Trim()
    if ($sourceHash -notmatch '^[a-f0-9]{64}$') {
        throw "E2 profile archive returned an invalid SHA-256: $sourceHash"
    }

    $sourceIdentity = [IO.Path]::GetFullPath($SourceIdentityFile).Replace('\', '/')
    $targetIdentity = [IO.Path]::GetFullPath($TargetIdentityFile).Replace('\', '/')
    $sourceHosts = [IO.Path]::GetFullPath($sourceKnownHosts).Replace('\', '/')
    $targetHosts = [IO.Path]::GetFullPath($targetKnownHosts).Replace('\', '/')
    $configText = @"
Host omnicodex-e2-profile-source
    HostName $SourceHost
    User ubuntu
    IdentityFile $sourceIdentity
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile $sourceHosts

Host omnicodex-a1-profile-target
    HostName $TargetHost
    User ubuntu
    IdentityFile $targetIdentity
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    UserKnownHostsFile $targetHosts
"@
    [IO.File]::WriteAllText($sshConfig.FullName, $configText, [Text.UTF8Encoding]::new($false))

    Invoke-Native $scp @(
        '-3', '-q', '-F', $sshConfig.FullName,
        "omnicodex-e2-profile-source:$remoteArchive",
        "omnicodex-a1-profile-target:$remoteArchive"
    ) | Out-Null

    $targetHash = (
        Invoke-Native $ssh @(
            @($targetOptions),
            "ubuntu@$TargetHost",
            "sha256sum '$remoteArchive' | cut -d' ' -f1"
        ) | Out-String
    ).Trim()
    if ($targetHash -ne $sourceHash) {
        throw "A1 profile archive hash mismatch: source=$sourceHash target=$targetHash"
    }

    Invoke-Native $ssh @(
        @($targetOptions),
        "ubuntu@$TargetHost",
        "install -d -m 0700 '$incomingProfile' && tar -C '$incomingProfile' -xf '$remoteArchive'"
    ) | Out-Null

    Invoke-Native $ssh @(
        @($targetOptions),
        "ubuntu@$TargetHost",
        'sudo systemctl stop omnicodex-oracle-browser.service'
    ) | Out-Null
    $targetBrowserStopped = $true

    try {
        Invoke-Native $ssh @(
            @($targetOptions),
            "ubuntu@$TargetHost",
            "mv '$targetProfile' '$previousProfile' && mv '$incomingProfile' '$targetProfile'"
        ) | Out-Null
        Invoke-Native $ssh @(
            @($targetOptions),
            "ubuntu@$TargetHost",
            'sudo systemctl start omnicodex-oracle-browser.service && sudo systemctl is-active --quiet omnicodex-oracle-browser.service'
        ) | Out-Null
        $targetBrowserStopped = $false
    }
    catch {
        Invoke-Native $ssh @(
            @($targetOptions),
            "ubuntu@$TargetHost",
            "if test -d '$previousProfile'; then rm -rf -- '$targetProfile' && mv '$previousProfile' '$targetProfile'; fi; sudo systemctl start omnicodex-oracle-browser.service"
        ) | Out-Null
        $targetBrowserStopped = $false
        throw
    }

    Start-Sleep -Seconds 3
    $cdpVersion = Invoke-RestMethod -Uri "$($runtime.localCdpEndpoint)/json/version" -TimeoutSec 10
    if ([string]::IsNullOrWhiteSpace([string]$cdpVersion.Browser)) {
        throw 'A1 browser did not return a CDP version after profile transfer'
    }

    [pscustomobject]@{
        ok = $true
        targetHost = $TargetHost
        targetProfile = $targetProfile
        rollbackProfile = $previousProfile
        archiveSha256 = $sourceHash
        sourceBrowserRestored = $true
        a1Browser = [string]$cdpVersion.Browser
        authenticationStillRequiresLiveReadback = $true
    }
}
finally {
    if ($sourceBrowserStopped) {
        try {
            Invoke-Native $ssh @(
                @($sourceOptions),
                "ubuntu@$SourceHost",
                'sudo systemctl start omnicodex-oracle-browser.service'
            ) | Out-Null
        }
        catch {
            Write-Warning 'Could not restore the E2 Oracle browser automatically'
        }
    }
    if ($targetBrowserStopped) {
        try {
            Invoke-Native $ssh @(
                @($targetOptions),
                "ubuntu@$TargetHost",
                'sudo systemctl start omnicodex-oracle-browser.service'
            ) | Out-Null
        }
        catch {
            Write-Warning 'Could not restore the A1 Oracle browser automatically'
        }
    }
    try {
        Invoke-Native $ssh @(
            @($sourceOptions),
            "ubuntu@$SourceHost",
            "rm -f -- '$remoteArchive'"
        ) | Out-Null
    }
    catch {
        Write-Warning "Could not remove the exact E2 transfer archive $remoteArchive"
    }
    try {
        Invoke-Native $ssh @(
            @($targetOptions),
            "ubuntu@$TargetHost",
            "rm -f -- '$remoteArchive'; if test -d '$incomingProfile'; then rm -rf -- '$incomingProfile'; fi"
        ) | Out-Null
    }
    catch {
        Write-Warning "Could not remove the exact A1 transfer staging paths for $nonce"
    }
    Remove-Item -LiteralPath $sshConfig.FullName -Force -ErrorAction SilentlyContinue
}
