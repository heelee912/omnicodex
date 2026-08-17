#Requires -Version 7.4
[CmdletBinding(SupportsShouldProcess)] param()
$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ShouldProcess('omnicodex', 'Remove the npm package only')) {
  & npm uninstall --global '@heelee912/omnicodex' --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'npm uninstall failed.' }
}
Write-Output 'Configuration and receipts were preserved. No process or app setting was changed.'
