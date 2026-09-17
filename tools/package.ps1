# Builds the zip uploaded to the Chrome Web Store.
#
#   powershell -File tools\package.ps1                  # uses src/config.js
#   pwsh tools/package.ps1 -ClientId '123-abc.apps.googleusercontent.com'
#
# Runs under Windows PowerShell 5.1 and PowerShell 7, so the same script serves
# a local build and the GitHub Action.
#
# The package is an allowlist, not the repo minus some things: private_key/,
# tools/, docs/ and the website files must never reach users, and a new stray
# folder should stay out by default rather than by someone remembering.
#
# The manifest comes from manifest.template.json, which has no "key". The store
# item already fixes the extension ID, and the store refuses a "key" on upload.
#
# The zip is written with System.IO.Compression rather than Compress-Archive:
# 5.1's Compress-Archive stores entry names with backslashes, which is not a
# valid zip path and which the store may not read as folders.

[CmdletBinding()]
param(
  # OAuth client ID. When given, src/config.js is generated from
  # src/config.example.js; otherwise the local src/config.js is used.
  [string]$ClientId = $env:MAILBOY_CLIENT_ID,
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

$manifestText = Get-Content -Raw -Encoding UTF8 'manifest.template.json'
$manifest = $manifestText | ConvertFrom-Json
if ($manifest.PSObject.Properties.Name -contains 'key') {
  throw 'manifest.template.json carries a "key"; the store refuses it.'
}
$version = $manifest.version

$placeholder = 'YOUR_CLIENT_ID.apps.googleusercontent.com'
if ($ClientId) {
  if ($ClientId -notmatch '^[\w-]+\.apps\.googleusercontent\.com$') {
    throw "ClientId does not look like a Google OAuth client ID."
  }
  $config = (Get-Content -Raw -Encoding UTF8 'src/config.example.js').Replace($placeholder, $ClientId)
} elseif (Test-Path 'src/config.js') {
  $config = Get-Content -Raw -Encoding UTF8 'src/config.js'
} else {
  throw 'No client ID: pass -ClientId, set MAILBOY_CLIENT_ID, or create src/config.js.'
}
if ($config.Contains($placeholder)) {
  throw 'The config still holds the placeholder client ID.'
}

# Published path -> source path. Everything under src/ except the two config
# files, which are handled above.
$files = [ordered]@{}
foreach ($name in 'background.js', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js', 'LICENSE') {
  $files[$name] = Join-Path $root $name
}
foreach ($dir in 'src', 'resources/icons') {
  Get-ChildItem -Path (Join-Path $root $dir) -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    if ($rel -ne 'src/config.js' -and $rel -ne 'src/config.example.js') {
      $files[$rel] = $_.FullName
    }
  }
}

# Every icon the manifest names has to be in the package.
$wanted = @()
foreach ($section in $manifest.icons, $manifest.action.default_icon) {
  if ($section) { $wanted += $section.PSObject.Properties.Value }
}
foreach ($path in $wanted | Sort-Object -Unique) {
  if (-not $files.Contains($path)) { throw "The manifest names $path, which is not in the package." }
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$zipPath = Join-Path (Resolve-Path $OutDir).Path "mailboy-$version.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  function Add-Text($name, $text) {
    $entry = $zip.CreateEntry($name, 'Optimal')
    $writer = New-Object System.IO.StreamWriter($entry.Open(), $utf8)
    try { $writer.Write($text) } finally { $writer.Dispose() }
  }
  Add-Text 'manifest.json' $manifestText
  Add-Text 'src/config.js' $config
  foreach ($name in $files.Keys) {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $files[$name], $name, 'Optimal')
  }
} finally {
  $zip.Dispose()
}

Write-Host "Built $zipPath ($($files.Count + 2) files, version $version)"
