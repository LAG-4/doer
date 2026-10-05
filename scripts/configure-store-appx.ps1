#Requires -Version 5.1
<#
.SYNOPSIS
  Reconfigure the Doer Store template .appx with Partner Center identity values (no rebuild).
.DESCRIPTION
  Unpacks a template .appx built with the SYNTHETIC test identity, validates it is
  exactly that expected payload, edits ONLY the four Partner Center identity fields
  via XML DOM, and repacks UNSIGNED (Store signs after certification).
  Makes NO cert/signing, computer, network, or account changes.
  Windows-only. Requires an installed x64 Windows SDK (makeappx.exe).
  Ref: https://learn.microsoft.com/en-us/windows/msix/package/create-app-package-with-makeappx-tool
  pack uses /h SHA256; /nv (skip validation) is NEVER used.
.EXAMPLE
  .\Configure-Doer-Store-Package.ps1 -InputAppx .\Doer-0.0.56-template.appx `
    -OutputAppx .\Doer-0.0.56-store.appx `
    -IdentityName 'FILL-FROM-PARTNER-CENTER' -Publisher 'CN=FILL-FROM-PARTNER-CENTER' `
    -PublisherDisplayName 'FILL-FROM-PARTNER-CENTER' -DisplayName 'FILL-RESERVED-DISPLAY-NAME'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InputAppx,
  [Parameter(Mandatory = $true)][string]$OutputAppx,
  [Parameter(Mandatory = $true)][string]$IdentityName,
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)][string]$PublisherDisplayName,
  [Parameter(Mandatory = $true)][string]$DisplayName,
  [Parameter(Mandatory = $false)][string]$MakeAppxPath,
  [Parameter(Mandatory = $false)][switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Expected SYNTHETIC template payload (main worker build). Must be replaced, never submitted.
$OrigName = 'Doer.StoreBuildVerification'
$OrigPublisher = 'CN=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
$OrigDisplay = 'Doer Build Verification'
$OrigVersion = '1.0.56.0'
$OrigAppId = 'Doer'

function Fail([string]$msg) { throw "Configure-Doer-Store-Package FAILED: $msg" }

# --- 1. New-identity shape validation (fail closed; never guess values) ---
# Identity Name: 3..50 chars [A-Za-z0-9.-], consistent with the electron-builder/Store pipeline.
# Display names: non-blank after trim, max 256 chars. Publisher: exact CN=<guid>.
foreach ($pair in @(
    @('IdentityName', $IdentityName), @('Publisher', $Publisher),
    @('PublisherDisplayName', $PublisherDisplayName), @('DisplayName', $DisplayName))) {
  if ([string]::IsNullOrWhiteSpace($pair[1])) { Fail "$($pair[0]) is missing or blank." }
  if ($pair[1].Trim().Length -eq 0) { Fail "$($pair[0]) is blank after trimming." }
  if ($pair[1].Length -gt 256) { Fail "$($pair[0]) exceeds 256 characters." }
}
if ($IdentityName -notmatch '^[A-Za-z0-9][A-Za-z0-9.\-]{2,49}$') { Fail 'IdentityName must be 3..50 chars of [A-Za-z0-9.-] (Partner Center package Name).' }
if ($Publisher -notmatch '^CN=[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') {
  Fail 'Publisher must be exactly the Partner Center value of form CN=<guid>.'
}
if ($IdentityName -eq $OrigName) { Fail 'IdentityName still equals the synthetic test identity.' }
if ($Publisher -eq $OrigPublisher) { Fail 'Publisher still equals the synthetic test publisher.' }
if ($PublisherDisplayName -eq $OrigDisplay) { Fail 'PublisherDisplayName still equals the synthetic test value.' }
if ($DisplayName -eq $OrigDisplay) { Fail 'DisplayName still equals the synthetic test value.' }

# --- 2. Path checks (never overwrite original; plain path-string comparison only) ---
# Note: this compares resolved path strings; it cannot detect hardlink/alias tricks.
if ([IO.Path]::GetExtension($InputAppx) -ne '.appx') { Fail 'InputAppx must have the .appx extension.' }
if ([IO.Path]::GetExtension($OutputAppx) -ne '.appx') { Fail 'OutputAppx must have the .appx extension.' }
$inFull = [IO.Path]::GetFullPath($InputAppx)
$outFull = [IO.Path]::GetFullPath($OutputAppx)
if ($inFull -eq $outFull) { Fail 'InputAppx and OutputAppx must differ (never overwrite the original).' }
if (-not (Test-Path -LiteralPath $inFull -PathType Leaf)) { Fail "InputAppx not found: $inFull" }
if (Test-Path -LiteralPath $inFull -PathType Container) { Fail 'InputAppx is a directory; pass the .appx file.' }
if (Test-Path -LiteralPath $outFull -PathType Container) { Fail 'OutputAppx is a directory; pass the .appx file path.' }
$outExists = Test-Path -LiteralPath $outFull -PathType Leaf
if ($outExists -and -not $Force) { Fail "OutputAppx exists; pass -Force to replace: $outFull" }
# When -Force is given, the old output is removed only AFTER the template validates
# (immediately before pack) — never before a valid package is known.

# --- 3. Locate makeappx (bounded x64 Windows SDK discovery only; never guess blindly) ---
if ($MakeAppxPath) {
  $makeappx = (Resolve-Path -LiteralPath $MakeAppxPath -ErrorAction Stop).Path
  if ([IO.Path]::GetFileName($makeappx) -ne 'makeappx.exe') { Fail 'MakeAppxPath must point to makeappx.exe.' }
} else {
  $sdkBin = Join-Path ${Env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (-not (Test-Path -LiteralPath $sdkBin)) { Fail 'Windows SDK bin root not found; install the x64 Windows SDK or pass -MakeAppxPath.' }
  $makeappx = Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction Stop |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64\makeappx.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
  if (-not $makeappx) { Fail 'makeappx.exe (x64) not found under the Windows SDK bin root.' }
}

# --- 4. Unique owned temp dir; cleanup ONLY this dir via finally ---
$tmpDir = Join-Path ([IO.Path]::GetTempPath()) ('DoerStoreRepack-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
  & $makeappx unpack /o /p "$inFull" /d "$tmpDir"
  if ($LASTEXITCODE -ne 0) { Fail "makeappx unpack exited with code $LASTEXITCODE." }

  $manifestPath = Join-Path $tmpDir 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifestPath)) { Fail 'AppxManifest.xml missing after unpack.' }
  [xml]$xml = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8
  $ns = New-Object Xml.XmlNamespaceManager($xml.NameTable)
  $ns.AddNamespace('m', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10')
  $ns.AddNamespace('uap', 'http://schemas.microsoft.com/appx/manifest/uap/windows10')
  $ns.AddNamespace('rescap', 'http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities')

  # --- 5. Validate ORIGINAL template payload before any change ---
  $id = $xml.SelectSingleNode('/m:Package/m:Identity', $ns)
  if ($null -eq $id) { Fail 'Manifest Identity node missing.' }
  if ($id.GetAttribute('Name') -ne $OrigName) { Fail 'Original Identity.Name is not the expected synthetic value; refusing.' }
  if ($id.GetAttribute('Publisher') -ne $OrigPublisher) { Fail 'Original Identity.Publisher is not the expected synthetic value; refusing.' }
  if ($id.GetAttribute('Version') -ne $OrigVersion) { Fail "Package Version is $($id.GetAttribute('Version')); expected $OrigVersion. Refusing." }
  if ($id.GetAttribute('ProcessorArchitecture') -ne 'x64') { Fail 'ProcessorArchitecture is not x64; refusing.' }
  $props = $xml.SelectSingleNode('/m:Package/m:Properties', $ns)
  if ($props.SelectSingleNode('m:DisplayName', $ns).InnerText -ne $OrigDisplay) { Fail 'Original DisplayName mismatch; refusing.' }
  if ($props.SelectSingleNode('m:PublisherDisplayName', $ns).InnerText -ne $OrigDisplay) { Fail 'Original PublisherDisplayName mismatch; refusing.' }
  $app = $xml.SelectSingleNode('/m:Package/m:Applications/m:Application', $ns)
  if ($null -eq $app -or $app.GetAttribute('Id') -ne $OrigAppId) { Fail 'Application Id is not Doer; refusing.' }
  # Protocol schemes live under windows.protocol extensions only; the list must be
  # exactly the single production scheme — no doer-dev, no extras, no unrelated nodes.
  $protoNodes = $xml.SelectNodes("/m:Package/m:Applications/m:Application/m:Extensions/uap:Extension[@Category='windows.protocol']/uap:Protocol", $ns)
  $schemes = @($protoNodes | ForEach-Object { $_.GetAttribute('Name') })
  if ($schemes.Count -ne 1 -or $schemes[0] -ne 'doer') {
    Fail "windows.protocol schemes must be exactly ('doer'); found: $($schemes -join ', '). Refusing."
  }
  if ($null -eq $xml.SelectSingleNode('//rescap:Capability[@Name="runFullTrust"]', $ns)) { Fail 'runFullTrust capability missing; refusing.' }
  $tdf = $xml.SelectSingleNode('/m:Package/m:Dependencies/m:TargetDeviceFamily', $ns)
  if ($null -eq $tdf -or $tdf.GetAttribute('MinVersion') -ne '10.0.19041.0') { Fail 'TargetDeviceFamily MinVersion is not 10.0.19041.0; refusing.' }

  # --- 6. XML DOM edits only (correct namespaces, XML escaping; no regex) ---
  $id.SetAttribute('Name', $IdentityName)
  $id.SetAttribute('Publisher', $Publisher)
  $props.SelectSingleNode('m:DisplayName', $ns).InnerText = $DisplayName
  $props.SelectSingleNode('m:PublisherDisplayName', $ns).InnerText = $PublisherDisplayName
  $ve = $xml.SelectSingleNode('/m:Package/m:Applications/m:Application/uap:VisualElements', $ns)
  if ($null -eq $ve) { Fail 'uap:VisualElements node missing; refusing.' }
  $ve.SetAttribute('DisplayName', $DisplayName)
  # Package Version stays 1.0.56.0; executable/assets untouched.
  $xml.Save($manifestPath)

  # --- 7. Drop stale pack footprints so repack regenerates them; never ship old signature ---
  # Bounded to these known footprint paths ONLY, inside the owned unique unpack dir.
  # App payload catalogs elsewhere are never touched.
  foreach ($stale in @('AppxBlockMap.xml', '[Content_Types].xml', 'AppxSignature.p7x', 'AppxMetadata/CodeIntegrity.cat')) {
    $p = Join-Path $tmpDir $stale
    if (Test-Path -LiteralPath $p -PathType Leaf) { Remove-Item -LiteralPath $p -Force }
  }

  # --- 8. Repack UNSIGNED with SHA256 + full semantic validation (/nv NEVER) ---
  # The old output (if -Force) is removed here, only after the template validated.
  if ($outExists) { Remove-Item -LiteralPath $outFull -Force }
  & $makeappx pack /h SHA256 /d "$tmpDir" /p "$outFull"
  if ($LASTEXITCODE -ne 0) { Fail "makeappx pack exited with code $LASTEXITCODE." }

  # --- 9. Companion manifest + SHA256 evidence ---
  Copy-Item -LiteralPath $manifestPath -Destination ($outFull + '.AppxManifest.xml') -Force
  (Get-FileHash -LiteralPath $outFull -Algorithm SHA256).Hash | Out-File -LiteralPath ($outFull + '.sha256') -Encoding ASCII
  Write-Host "Wrote: $outFull (+ .AppxManifest.xml, .sha256). Upload the .appx to Partner Center; Microsoft signs it after certification."
} finally {
  if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
}
