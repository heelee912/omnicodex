param([Parameter(Mandatory=$true)][ValidateSet('protect','verify')][string]$Operation)
$ErrorActionPreference = 'Stop'
Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$path = [Console]::In.ReadToEnd()
$item = Get-Item -LiteralPath $path -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Configuration must be a regular file.'
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($Operation -eq 'protect') {
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $path -AclObject $acl
}
$acl = Get-Acl -LiteralPath $path
if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) {
    throw 'Configuration ACL must be private to the current user.'
}
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -eq 0) { throw 'Configuration has no private access rule.' }
foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited) {
        throw 'Configuration ACL grants access outside the current user.'
    }
}
