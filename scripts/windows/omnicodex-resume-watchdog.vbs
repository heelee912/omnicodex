Option Explicit

Dim shell, fso, scriptDirectory, powershellScript, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
powershellScript = fso.BuildPath(scriptDirectory, "omnicodex-resume-watchdog.ps1")
command = """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe""" _
    & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
    & """" & powershellScript & """"

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
