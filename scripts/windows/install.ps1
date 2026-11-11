#Requires -Version 7.4
[CmdletBinding(SupportsShouldProcess)] param()
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22.12 or newer is required.' }
if ($PSCmdlet.ShouldProcess('omnicodex', 'Install the signed npm package globally')) {
  & npm install --global '@heelee912/omnicodex' --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm installation failed.' }
}
Write-Output 'Run omnicodex init in this terminal. No background console was started.'
