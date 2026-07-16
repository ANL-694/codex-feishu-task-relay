Option Explicit

Dim fileSystem
Dim shell
Dim scriptDirectory
Dim artifactDirectory
Dim pythonCommand
Dim smokePath
Dim exitCodePath
Dim command
Dim exitCode
Dim exitFile

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
artifactDirectory = fileSystem.BuildPath(scriptDirectory, "artifacts")
pythonCommand = "py -3"
smokePath = fileSystem.BuildPath(scriptDirectory, "smoke.py")
exitCodePath = fileSystem.BuildPath(artifactDirectory, "exit-code.txt")

If Not fileSystem.FolderExists(artifactDirectory) Then
    fileSystem.CreateFolder artifactDirectory
End If

shell.Environment("PROCESS")("PYTHONUTF8") = "1"
If fileSystem.FileExists(fileSystem.BuildPath(scriptDirectory, "control-worker.flag")) Then
    shell.Environment("PROCESS")("E2E_CONTROL_WORKER") = "1"
End If
command = pythonCommand & " """ & smokePath & """"
exitCode = shell.Run(command, 0, True)

Set exitFile = fileSystem.CreateTextFile(exitCodePath, True, False)
exitFile.Write CStr(exitCode)
exitFile.Close
