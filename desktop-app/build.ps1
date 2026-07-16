$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$outputDirectory = Join-Path $projectRoot '程序'
$outputPath = Join-Path $outputDirectory 'Codex飞书中继.exe'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path -LiteralPath $compiler)) {
    throw "未找到 .NET Framework C# 编译器：$compiler"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$sources = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File |
    Sort-Object Name |
    ForEach-Object FullName

& $compiler `
    /nologo `
    /target:winexe `
    /platform:x64 `
    /optimize+ `
    /warn:4 `
    /nowarn:1668 `
    /codepage:65001 `
    /utf8output `
    "/win32manifest:$PSScriptRoot\app.manifest" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    "/out:$outputPath" `
    $sources

if ($LASTEXITCODE -ne 0) {
    throw "桌面程序编译失败，退出码：$LASTEXITCODE"
}

Get-Item -LiteralPath $outputPath | Select-Object FullName, Length, LastWriteTime
