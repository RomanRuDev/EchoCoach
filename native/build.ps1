$ErrorActionPreference = 'Stop'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /platform:x64 /optimize /target:exe "/out:$PSScriptRoot\EchoLoopback.exe" "$PSScriptRoot\EchoLoopback.cs"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
