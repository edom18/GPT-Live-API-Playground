$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$liveNodeCommand = Get-Command node -ErrorAction SilentlyContinue
$liveNodePath = if ($liveNodeCommand) { $liveNodeCommand.Source } elseif (Test-Path -LiteralPath 'C:\nvm4w\nodejs\node.exe') { 'C:\nvm4w\nodejs\node.exe' } else { throw 'Node.js 22.15以降をインストールしてください。' }
$env:Path = (Split-Path -Parent $liveNodePath) + ';' + $env:Path
if (-not (Test-Path -LiteralPath 'node_modules\ws')) {
  & (Join-Path (Split-Path -Parent $liveNodePath) 'npm.cmd') ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
}
& (Join-Path (Split-Path -Parent $liveNodePath) 'npm.cmd') run build
if ($LASTEXITCODE -ne 0) { throw 'Editor build failed' }
& $liveNodePath --env-file-if-exists=.env server.mjs
