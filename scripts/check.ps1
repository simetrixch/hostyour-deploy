<#
.SYNOPSIS
The checks this repository runs on itself, before every push.

.EXAMPLE
pwsh -NoProfile -File scripts/check.ps1

.NOTES
Two steps, in this order, stopping at the first red one and naming it:

  1. every YAML file in this tree parses
  2. every program binds to the registry the shipped ansiwise binary carries

WHY THE SECOND STEP RUNS IN ANOTHER CHECKOUT. A program file names steps, predicates and
arguments. What those names may be is declared by the plugin packages, and only the CLI checkout
composes the whole set a shipped binary carries. The suite there reads THIS tree and judges it
against that set. A parser run here proves the files are YAML and proves nothing about whether a
machine can execute them.

A MISSING TOOL IS NAMED AND THE CHECK IS RED. A step that did not run is not a step that passed,
and a green line over a step that never started is how a program no binary can execute reaches a
machine.

The YAML parser is yq, the same one the shell twin uses. Two parsers can disagree about one file,
and then the answer depends on which shell the person happened to start.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# A native command that exits non-zero must set $LASTEXITCODE and do nothing else. Where PowerShell
# turns that exit code into a terminating error instead, every refusal below is replaced by a stack
# trace and the run stops printing the line that says which step was red. The default of this
# setting has moved between PowerShell releases, so it is stated here rather than inherited.
$PSNativeCommandUseErrorActionPreference = $false

$root = Split-Path -Parent $PSScriptRoot
$suite = 'test/checks/config_validity_test.dart'

function Stop-Check($what) { Write-Host "check: FAIL — $what"; exit 1 }

if (-not (Get-Command yq -ErrorAction SilentlyContinue)) {
  Stop-Check 'yq is not on PATH, and it is the YAML parser both halves of this check use'
}

# STEP 1 — every YAML file parses.
#
# The templates under ansiwise/templates are left out ON PURPOSE. Five of them are systemd units, a
# netplan file and a shell script. They are rendered onto a machine and are never read as YAML, so
# a parser would report them broken for being what they are.
$files = @(
  Get-ChildItem -LiteralPath (Join-Path $root 'ansiwise') -Recurse -File -Filter '*.yaml' |
    Sort-Object FullName
)
$roots = @(Get-ChildItem -LiteralPath $root -File -Filter 'ansiwise*.yaml' | Sort-Object FullName)
if ($roots.Count -eq 0) {
  Stop-Check 'no ansiwise*.yaml stands at the root of this repository, and the engine reads out of it which plugins to load'
}
$files += $roots

$broken = 0
foreach ($file in $files) {
  # The parsed document is thrown away and only the exit code is read. yq writes its own message,
  # naming the file and the line it stopped at, and that message goes straight to the screen.
  & yq e '.' $file.FullName 1> $null
  if ($LASTEXITCODE -ne 0) { $broken++ }
}
if ($broken -gt 0) { Stop-Check "$broken of $($files.Count) YAML file(s) do not parse" }
Write-Host "check: $($files.Count) YAML file(s) parse."

# STEP 2 — every program binds to the registry the shipped binary carries.
#
# THE CLI CHECKOUT IS FOUND BY NAME, WITHOUT CASE. A checkout is regularly cased differently from
# the repository it came from, and an exact match reports a present one as absent.
$cli = Get-ChildItem -LiteralPath (Split-Path -Parent $root) -Directory |
  Where-Object { $_.Name -ieq 'ansiwise-cli' } |
  Select-Object -First 1
if (-not $cli) {
  Stop-Check 'no ansiwise-cli checkout beside this one, and the suite that binds these programs to the shipped registry lives there'
}
if (-not (Test-Path -LiteralPath (Join-Path $cli.FullName $suite))) {
  Stop-Check "$($cli.FullName)/$suite is missing, so these programs cannot be bound to a registry"
}
if (-not (Get-Command dart -ErrorAction SilentlyContinue)) {
  Stop-Check 'dart is not on PATH, and the suite that binds these programs to the shipped registry is a Dart test'
}

# THE TREE UNDER TEST IS NAMED, and is not left to the search the suite runs when nothing names
# one. That search takes the one directory near the CLI checkout that holds ansiwise/programs, and
# it refuses where a machine carries two. Naming this checkout makes the suite read the tree this
# check is about, on every machine.
$env:ANSIWISE_INSTALLATION = $root
Push-Location -LiteralPath $cli.FullName
try {
  # Standard output is captured so a SKIPPED suite can be told from a green one, then printed
  # whole. Standard error is not captured and reaches the screen while the suite runs.
  $output = & dart test $suite | Out-String
  $status = $LASTEXITCODE
} finally {
  Pop-Location
  $env:ANSIWISE_INSTALLATION = $null
}
Write-Host $output
if ($status -ne 0) { Stop-Check "dart test $suite in $($cli.FullName)" }

# A SKIPPED SUITE IS NOT A GREEN ONE. Where no installation tree is found, the suite skips itself
# and dart test still exits 0. That is honest of the suite, because a clone standing alone has no
# programs to judge. Here the suite was pointed at this tree, so a skip means these programs were
# never bound to anything.
if ($output -match 'All tests skipped' -or $output -match 'Skip:') {
  Stop-Check "dart test $suite skipped its tests, so no program was bound to the shipped registry"
}

Write-Host 'check: OK — every check green'
exit 0
