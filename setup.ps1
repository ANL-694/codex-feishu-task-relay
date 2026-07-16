$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '未找到 Node.js。请先安装 Node.js 22 或更高版本。'
}

npm install

$exampleConfig = Join-Path $projectRoot 'config\projects.example.json'
$localConfig = Join-Path $projectRoot 'config\projects.json'

if (-not (Test-Path -LiteralPath $localConfig)) {
    Copy-Item -LiteralPath $exampleConfig -Destination $localConfig
    Write-Host '已创建 config\projects.json，请按本机项目目录修改后再安装 Hook。'
}

Write-Host '依赖安装完成。接下来运行 npm run install-hook，并在 程序\Codex飞书中继.exe 中配置飞书。'
