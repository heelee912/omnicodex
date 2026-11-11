[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PythonExe,

    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,

    [Parameter(Mandatory = $true)]
    [string]$ConfigFile,

    [Parameter(Mandatory = $true)]
    [string]$SubnetName,

    [Parameter(Mandatory = $true)]
    [string]$DisplayName,

    [Parameter(Mandatory = $true)]
    [string]$SshPublicKeyFile,

    [Parameter(Mandatory = $true)]
    [string]$StateFile,

    [Parameter(Mandatory = $true)]
    [string]$LogFile,

    [string]$Profile = "OMNICODEX_A1"
)

$ErrorActionPreference = "Stop"
$logDirectory = Split-Path -Parent $LogFile
if (-not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
}

$arguments = @(
    $ScriptPath,
    "--config-file", $ConfigFile,
    "--profile", $Profile,
    "--subnet-name", $SubnetName,
    "--display-name", $DisplayName,
    "--ssh-public-key-file", $SshPublicKeyFile,
    "--state-file", $StateFile,
    "--once"
)

& $PythonExe @arguments *>> $LogFile
$exitCode = $LASTEXITCODE
if ($exitCode -notin @(0, 75, 76)) {
    throw "A1 capacity watcher stopped on non-capacity error with exit code $exitCode. See $LogFile"
}
exit $exitCode
