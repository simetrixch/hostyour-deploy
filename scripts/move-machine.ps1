$ErrorActionPreference = 'Stop'
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node) {
  [Console]::Error.Write("domain-move: node is required`n")
  exit 69
}
$start = [System.Diagnostics.ProcessStartInfo]::new()
$start.FileName = $node.Source
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.ArgumentList.Add("$PSScriptRoot/move-machine.mjs")
foreach ($argument in $args) { $start.ArgumentList.Add([string]$argument) }
$process = [System.Diagnostics.Process]::Start($start)
# Copy native bytes so Windows does not rewrite the JSON's LF endings.
$outCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
$errCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
$process.WaitForExit()
[System.Threading.Tasks.Task]::WaitAll(@($outCopy, $errCopy))
exit $process.ExitCode
