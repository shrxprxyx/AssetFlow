# Moves the app code into src/. Run once, from the project root (the folder with package.json).
#   powershell -ExecutionPolicy Bypass -File .\move-to-src.ps1
# Then extract assetflow-src-layout.zip over the project (it overwrites the config files and
# a few moved files), delete the .next folder, and restart.

$ErrorActionPreference = "Stop"

if (-not (Test-Path ".\package.json") -or -not (Test-Path ".\prisma\schema.prisma")) {
  throw "Run this from the project root (the folder with package.json and prisma/)."
}
if (Test-Path ".\src") { throw "src/ already exists. Nothing was moved." }
foreach ($name in "app", "components", "lib", "hooks", "styles", "types", "auth.ts", "auth.config.ts", "proxy.ts") {
  if (-not (Test-Path ".\$name")) { throw "Expected .\$name but it is missing. Nothing was moved." }
}

New-Item -ItemType Directory -Path ".\src" | Out-Null
foreach ($name in "app", "components", "lib", "hooks", "styles", "types", "auth.ts", "auth.config.ts", "proxy.ts") {
  Move-Item -Path ".\$name" -Destination ".\src\$name"
}
# The global stylesheet moves out of app/ into styles/.
Move-Item -Path ".\src\app\globals.css" -Destination ".\src\styles\globals.css"

if (Test-Path ".\.next") { Remove-Item ".\.next" -Recurse -Force }
Write-Host "Moved. Now extract assetflow-src-layout.zip over the project."
