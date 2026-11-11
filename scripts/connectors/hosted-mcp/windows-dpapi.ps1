param([Parameter(Mandatory=$true)][ValidateSet('protect','unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = $utf8
$payload = [Console]::In.ReadToEnd()
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Operation -eq 'protect') {
    $bytes = [System.Security.Cryptography.ProtectedData]::Protect($utf8.GetBytes($payload), $null, $scope)
    [Console]::Out.Write([Convert]::ToBase64String($bytes))
} else {
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($payload), $null, $scope)
    [Console]::Out.Write($utf8.GetString($bytes))
}
