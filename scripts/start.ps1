$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
if (-not (Test-Path "node_modules")) {
  Write-Host "Installing dependencies..."
  npm install
}
Write-Host "Starting PPK push server..."
node src/index.js
