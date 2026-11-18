param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repoRoot
$env:npm_config_cache = Join-Path $repoRoot '.cache/npm'
$env:npm_config_devdir = Join-Path $repoRoot '.cache/node-gyp'
$runtimeRoot = Get-ChildItem -LiteralPath 'C:/Program Files/WindowsApps' -Directory -Filter 'OpenAI.CodexPrimaryRuntime*' -ErrorAction SilentlyContinue | Where-Object { (Test-Path -LiteralPath (Join-Path $_.FullName 'dependencies/node/bin/node.exe')) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'dependencies/node/node_modules/pnpm/bin/pnpm.mjs')) } | Sort-Object Name -Descending | Select-Object -First 1
$runtimeNode = if ($runtimeRoot) { Join-Path $runtimeRoot.FullName 'dependencies/node/bin/node.exe' }
$runtimePnpm = if ($runtimeRoot) { Join-Path $runtimeRoot.FullName 'dependencies/node/node_modules/pnpm/bin/pnpm.mjs' }
if ($runtimeNode -and (Test-Path -LiteralPath $runtimeNode) -and (Test-Path -LiteralPath $runtimePnpm)) {
  $runtimeTools = Join-Path $runtimeRoot.FullName 'dependencies/bin/fallback'
  $env:PATH = (Split-Path $runtimeNode -Parent) + ';' + $runtimeTools + ';' + $env:PATH
  & $runtimeNode $runtimePnpm @TaskArgs
} else {
  & pnpm @TaskArgs
}
exit $LASTEXITCODE
