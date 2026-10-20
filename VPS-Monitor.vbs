' Double-click to start VPS Monitor with no console window.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' ELECTRON_RUN_AS_NODE (set by some editors) makes Electron behave as plain Node and crash
sh.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
sh.Run """" & dir & "\node_modules\electron\dist\electron.exe"" .", 0, False
