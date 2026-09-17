# Builds the zip uploaded to the Chrome Web Store, and the signed .crx a
# verified upload needs.
#
#   powershell -File tools\package.ps1                  # uses src/config.js
#   pwsh tools/package.ps1 -ClientId '123-abc.apps.googleusercontent.com'
#   pwsh tools/package.ps1 -KeyPath ~/keys/mailboy-upload.pem
#
# The .crx is the zip that was just built, wrapped and signed by tools/crx.mjs —
# so the two carry identical bytes and only one of them can ever be the odd one
# out. Without a key it is still built, signed with a throwaway one and named
# "_unsigned", which is loadable in Chrome but not uploadable to a store item
# with verified CRX uploads switched on.
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
  # Path to the RSA private key the Web Store has the public half of. Falls back
  # to CRX_KEY_PATH in src/config.js, which is where a local machine keeps it.
  [string]$KeyPath = $env:MAILBOY_CRX_KEY_PATH,
  # Also write a second zip carrying the manifest "key", for loading this exact
  # build unpacked. Never for upload: the store refuses a manifest with a key,
  # and the key is what pins the extension ID the OAuth redirect URI is
  # registered against, so a build without it cannot sign in.
  [switch]$Dev,
  # The manifest "key" the -Dev zip carries. Defaults to the local
  # manifest.json's, which is where it already is on a development machine.
  [string]$ManifestKey = $env:MAILBOY_MANIFEST_KEY,
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

# src/config.js is the one file that is local to a machine, so it is also where
# the path to the signing key lives. It ships to users, though, so the export is
# read here and then cut out of what gets packed — a local path names the person
# who built it, and users have no use for it.
$keyExport = '(?m)(?:^[ \t]*//[^\r\n]*\r?\n)*^[ \t]*export[ \t]+const[ \t]+CRX_KEY_PATH[ \t]*=\s*([''"])(?<path>(?:\\.|(?!\1).)*)\1[ \t]*;?[ \t]*\r?\n?'
$configKeyPath = ''
$found = [regex]::Match($config, $keyExport)
if ($found.Success) {
  # JS string escapes, which a Windows path in single quotes is full of.
  $configKeyPath = [regex]::Replace($found.Groups['path'].Value, '\\(.)', '$1')
  $config = [regex]::Replace($config, $keyExport, '')
}
# And the comment block explaining all this, which config.example.js carries so
# that whoever sets a key up can find out how. It is instructions for building
# MailBoy sitting in a file shipped to people running it, so it goes the same
# way: a whole run of comment lines, if any line of it names the export.
# Plain regex rather than a MatchEvaluator scriptblock: this script runs under
# both Windows PowerShell 5.1 and pwsh 7, and a pure pattern behaves the same in
# each. It reads as: the comment lines above, the one naming the export, the
# comment lines below.
$keyComment = '(?m)(?:^[ \t]*//[^\r\n]*\r?\n)*^[ \t]*//[^\r\n]*CRX_KEY_PATH[^\r\n]*\r?\n(?:^[ \t]*//[^\r\n]*\r?\n)*'
$config = [regex]::Replace($config, $keyComment, '')
# The check is not "the name does not appear", since a stray mention in prose is
# harmless. What must not survive is a live export, or the path itself.
if ($config -match '(?m)^[ \t]*export[ \t]+const[ \t]+CRX_KEY_PATH') {
  throw 'CRX_KEY_PATH survived in the packaged config. Write it as one export statement.'
}
if ($configKeyPath -and $config.Contains($configKeyPath)) {
  throw 'The signing key path is still in the packaged config.'
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
$outFull = (Resolve-Path $OutDir).Path
$zipPath = Join-Path $outFull "mailboy-$version.zip"
$crxPath = Join-Path $outFull "mailboy-$version.crx"
$unsignedPath = Join-Path $outFull "mailboy-${version}_unsigned.crx"
$devPath = Join-Path $outFull "mailboy-${version}-dev-unpacked-only.zip"
# Every name goes first: a leftover from an earlier run of this same version
# would otherwise sit beside the new build looking like part of it.
foreach ($stale in $zipPath, $crxPath, $unsignedPath, $devPath) {
  if (Test-Path $stale) { Remove-Item $stale }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Package($path, $manifestJson) {
  $zip = [System.IO.Compression.ZipFile]::Open($path, 'Create')
  try {
    $entry = $zip.CreateEntry('manifest.json', 'Optimal')
    $writer = New-Object System.IO.StreamWriter($entry.Open(), $utf8)
    try { $writer.Write($manifestJson) } finally { $writer.Dispose() }

    $entry = $zip.CreateEntry('src/config.js', 'Optimal')
    $writer = New-Object System.IO.StreamWriter($entry.Open(), $utf8)
    try { $writer.Write($config) } finally { $writer.Dispose() }

    foreach ($name in $files.Keys) {
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $files[$name], $name, 'Optimal')
    }
  } finally {
    $zip.Dispose()
  }
}

Write-Package $zipPath $manifestText
Write-Host "Built $zipPath ($($files.Count + 2) files, version $version)"

# The signing key, in order: what was asked for on the command line or in the
# environment, then what src/config.js names. A key that was asked for and is
# not there is worth saying out loud — falling through to an unsigned build
# silently is how the wrong file gets uploaded.
$signingKey = ''
foreach ($candidate in $KeyPath, $configKeyPath) {
  if (-not $candidate) { continue }
  $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
  if ($expanded.StartsWith('~')) { $expanded = Join-Path $HOME $expanded.Substring(1).TrimStart('\', '/') }
  if (Test-Path -LiteralPath $expanded) {
    $signingKey = (Resolve-Path -LiteralPath $expanded).Path
    break
  }
  Write-Warning "No signing key at $expanded."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warning 'Node is not on PATH, so no .crx was built. The zip is unaffected.'
} else {
  $target = if ($signingKey) { $crxPath } else { $unsignedPath }
  $crxArgs = @((Join-Path $PSScriptRoot 'crx.mjs'), '--zip', $zipPath, '--out', $target)
  if ($signingKey) { $crxArgs += @('--key', $signingKey) }
  & $node.Source @crxArgs
  if ($LASTEXITCODE -ne 0) { throw 'Signing the .crx failed.' }
  if (-not $signingKey) {
    Write-Warning 'No signing key, so this .crx cannot be uploaded to a store item with verified CRX uploads on. Upload the zip, or set CRX_KEY_PATH in src/config.js.'
  }
}

# The dev zip is built last and from the same file map, so nothing it does can
# reach the package above. It differs by one line: the manifest "key", which
# fixes the extension ID at the published one and so makes the redirect URI
# registered with Google match. Without it a loaded build gets an ID derived
# from wherever it happens to sit, and signing in fails with "this app's request
# is invalid".
if ($Dev) {
  $devKey = $ManifestKey
  if (-not $devKey -and (Test-Path (Join-Path $root 'manifest.json'))) {
    $devKey = (Get-Content -Raw -Encoding UTF8 (Join-Path $root 'manifest.json') | ConvertFrom-Json).key
  }
  if (-not $devKey) {
    # A message rather than a warning: a build with no manifest key to hand is
    # an ordinary state, not something going wrong. The two files that get
    # uploaded are unaffected either way.
    Write-Host 'No manifest key, so no dev zip. Pass -ManifestKey, set MAILBOY_MANIFEST_KEY, or build where manifest.json has one.'
  } elseif ($devKey -notmatch '^[A-Za-z0-9+/]+={0,2}$') {
    throw 'The manifest key is not base64. It is the "key" line from manifest.json, without quotes.'
  } else {
    # Textual insert rather than a round trip through ConvertTo-Json, which
    # would reformat and reorder a manifest that is read by people.
    $devManifest = [regex]::Replace($manifestText, '^\s*\{', "{`n  `"key`": `"$devKey`",", 'None')
    if ($devManifest -eq $manifestText) { throw 'Could not find the manifest opening brace.' }
    $null = $devManifest | ConvertFrom-Json  # Throws if the insert broke the JSON.
    Write-Package $devPath $devManifest
    # Plain ASCII in the string: read as ANSI, an em dash ends with the byte
    # Windows-1252 calls a closing curly quote, which PowerShell 5.1 takes as a
    # string delimiter. Harmless in a comment, a parse error here.
    Write-Host "Built $devPath - load unpacked only, the store refuses a manifest with a key"
  }
}
