[CmdletBinding()]
param(
    [string]$TunnelClientPath = (Join-Path $env:LOCALAPPDATA 'OmniCodex\bin\tunnel-client\v0.0.14\tunnel-client.exe'),
    [string]$ProfileDirectory = (Join-Path $env:APPDATA 'tunnel-client'),
    [switch]$EnsureRunning
)

$ErrorActionPreference = 'Stop'
$aliasName = 'omnicodex2'
$dataDirectory = Join-Path $env:LOCALAPPDATA 'OmniCodex'
if ($env:OMNICODEX_DATA_DIR) { $dataDirectory = $env:OMNICODEX_DATA_DIR }
$profilePath = Join-Path $profileDirectory ($aliasName + '.yaml')
$runtimeKeyPath = Join-Path $dataDirectory 'tunnel-client-private\runtime.key'

foreach ($requiredPath in @($TunnelClientPath, $profilePath, $runtimeKeyPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required runtime file is missing: $requiredPath"
    }
}

# The official connect command generates JSON in its .yaml profile. Preserve
# its existing tunnel identity; never read the referenced runtime key contents.
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$tunnelId = [string]$profile.control_plane.tunnel_id
if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
    throw 'The existing omnicodex2 profile has no valid tunnel ID.'
}
$state = Get-Content -LiteralPath (Join-Path $dataDirectory 'state.json') -Raw | ConvertFrom-Json
if ($state.lifecycle -ne 'ready' -or $state.address.host -notin @('127.0.0.1', 'localhost', '::1')) {
    throw 'The local OmniCodex MCP gateway is not ready on a loopback address.'
}
$gateway = [UriBuilder]::new('http', [string]$state.address.host, [int]$state.address.port)
$baseUrl = $gateway.Uri.GetLeftPart([UriPartial]::Authority)
$mcpUrl = $baseUrl + [string]$state.address.fullPath
if ($EnsureRunning) {
    $statusOutput = & $TunnelClientPath runtimes status $aliasName --json
    if ($LASTEXITCODE -ne 0) { throw "Inspecting the omnicodex2 runtime failed: $statusOutput" }
    $runtimeStatus = $statusOutput | ConvertFrom-Json
    if ($runtimeStatus.tunnel_id -eq $tunnelId -and
        $runtimeStatus.process.target_value -eq $mcpUrl -and
        $runtimeStatus.healthy -eq $true -and
        $runtimeStatus.ready -eq $true -and
        $runtimeStatus.process_running -eq $true) {
        [pscustomobject]@{
            alias = $aliasName
            tunnelId = $tunnelId
            mcpUrl = $mcpUrl
            alreadyRunning = $true
        } | ConvertTo-Json
        return
    }
}
$metadataUrl = $baseUrl + '/.well-known/oauth-protected-resource' + [string]$state.address.fullPath
$metadata = Invoke-RestMethod -Uri $metadataUrl
$oauthUrls = @(@($metadata.resource) + @($metadata.authorization_servers) | ForEach-Object {
    $uri = [Uri]$_
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo) {
        throw 'OAuth target metadata must contain an absolute HTTPS URL without credentials.'
    }
    $uri
})
if ($oauthUrls.Count -lt 2) {
    throw 'The local gateway did not advertise an OAuth resource and authorization server.'
}
$resourceUri = $oauthUrls[0]
$targetUrls = @($resourceUri.GetLeftPart([UriPartial]::Authority) + '/.well-known/oauth-protected-resource' + $resourceUri.AbsolutePath)
foreach ($issuerUri in $oauthUrls[1..($oauthUrls.Count - 1)]) {
    $targetUrls += $issuerUri.GetLeftPart([UriPartial]::Authority) + '/.well-known/oauth-authorization-server' + $issuerUri.AbsolutePath.TrimEnd('/')
}
$targetUrls = @($targetUrls | Select-Object -Unique)
$targets = @()
for ($index = 0; $index -lt $targetUrls.Count; $index++) {
    $targets += 'label=omnicodex-oauth-' + $index + ',url=' + $targetUrls[$index]
}

# connect rewrites the profile, but its managed child inherits this environment.
# Supply explicit targets on every start instead of editing generated YAML.
$previousTargets = [Environment]::GetEnvironmentVariable('HARPOON_TARGETS', 'Process')
$previousPlaintextHttp = [Environment]::GetEnvironmentVariable('HARPOON_ALLOW_PLAINTEXT_HTTP', 'Process')
$previousPath = [Environment]::GetEnvironmentVariable('PATH', 'Process')
try {
    $env:HARPOON_TARGETS = $targets -join ';'
    # The local PRMD source uses the already validated loopback MCP origin.
    # Use the official transport option so discovery can register that source.
    $env:HARPOON_ALLOW_PLAINTEXT_HTTP = 'true'
    # The tunnel's optional admin UI starts its own app-server when it finds codex.
    # The MCP relay below already uses OmniCodex's URL, so keep codex out of this child only.
    $pathWithoutCodex = foreach ($entry in ($previousPath -split ';')) {
        $directory = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        $containsCodex = $false
        if ($directory -and (Test-Path -LiteralPath $directory -PathType Container)) {
            foreach ($name in @('codex.exe', 'codex.cmd', 'codex.bat', 'codex.com', 'codex.ps1')) {
                if (Test-Path -LiteralPath (Join-Path $directory $name) -PathType Leaf) {
                    $containsCodex = $true
                    break
                }
            }
        }
        if (-not $containsCodex) { $entry }
    }
    $env:PATH = $pathWithoutCodex -join ';'
    $codexLookup = Get-Command codex -All -ErrorAction SilentlyContinue
    if ($codexLookup) {
        throw "The tunnel child PATH still resolves codex: $($codexLookup.Source -join ', ')"
    }
    $stopOutput = & $TunnelClientPath runtimes stop $aliasName --json
    if ($LASTEXITCODE -ne 0) { throw "Stopping the omnicodex2 runtime failed: $stopOutput" }
    $connectOutput = & $TunnelClientPath runtimes connect --alias $aliasName `
        --tunnel-id $tunnelId --profile $aliasName --profile-dir $profileDirectory `
        --mcp-server-url $mcpUrl --runtime-api-key ('file:' + $runtimeKeyPath) --json
    if ($LASTEXITCODE -ne 0) { throw "Starting the omnicodex2 runtime failed: $connectOutput" }
    $connected = $connectOutput | ConvertFrom-Json
    [pscustomobject]@{
        alias = $aliasName
        tunnelId = $tunnelId
        mcpUrl = $mcpUrl
        targetUrls = $targetUrls
        profilePath = $profilePath
        mode = $connected.mode
        readyAtLaunch = $connected.ready
        healthUrlFile = $connected.process.health_url_file
        process = $connected.process
    } | ConvertTo-Json -Depth 8
}
finally {
    [Environment]::SetEnvironmentVariable('HARPOON_TARGETS', $previousTargets, 'Process')
    [Environment]::SetEnvironmentVariable('HARPOON_ALLOW_PLAINTEXT_HTTP', $previousPlaintextHttp, 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $previousPath, 'Process')
}
