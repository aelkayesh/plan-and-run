#Requires -Version 7.3
<#
.SYNOPSIS
Run an existing Plan and Run bundle inside one WSL2 distribution.
.DESCRIPTION
Requires PowerShell 7.3+ on Windows, an existing WSL2 distribution, and Linux
Node/Git/Codex installed there. Repository must be inside /home, not a Windows
mounted drive. This launcher neither installs prerequisites nor changes login.
.EXAMPLE
./scripts/wsl.ps1 -Repository /home/alice/project -Plan feature -Action status -RunnerArguments @('--json')
#>
[CmdletBinding()]
param(
    [string] $Distribution = 'Ubuntu',
    [Parameter(Mandatory)] [string] $Repository,
    [Parameter(Mandatory)] [string] $Plan,
    [ValidateSet('start', 'resume', 'preflight', 'status', 'dry-run', 'logs', 'stop')]
    [string] $Action = 'status',
    [string[]] $RunnerArguments = @()
)

$ErrorActionPreference = 'Stop'
# wsl.exe is a native executable. Preserve each array element verbatim and let
# its exit code describe a failed probe/runner operation rather than throwing.
$PSNativeCommandArgumentPassing = 'Standard'
$PSNativeCommandUseErrorActionPreference = $false

try {
    if (-not $IsWindows) {
        throw 'This launcher requires Windows. On Linux/WSL or macOS, invoke the generated run.mjs directly.'
    }
    if ($Distribution -cnotmatch '^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,127}$') {
        throw 'Distribution must be an existing WSL distribution name, without control characters or option syntax.'
    }
    if ($Repository -cnotmatch '^/home/[^/]+(?:/[^/]+)+$' -or
        $Repository -match '[\p{Cc}\\]' -or
        @($Repository.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -gt 0) {
        throw 'Repository must be an absolute Linux project path under /home, without traversal or control characters. Windows, UNC and /mnt paths are not supported.'
    }
    if ($Plan.Length -gt 63 -or $Plan -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
        throw 'Plan must be a generated plan slug: 1-63 lowercase letters/digits separated by single hyphens.'
    }

    # Keep repository, manifest, executable and runtime upgrade authority inside
    # the selected Linux bundle. Unknown options fail before any WSL invocation.
    $valueOptions = @{
        '--model' = 'text'; '--profile' = 'text'
        '--step' = 'step'; '--from' = 'step'; '--to' = 'step'
        '--session' = 'uuid'
        '--tpm-threshold' = 'number'; '--max-session-rotations' = 'number'
        '--max-rate-retries' = 'number'; '--retry-delay-seconds' = 'number'
        '--max-delay-seconds' = 'number'; '--timeout-minutes' = 'number'
        '--progress-seconds' = 'number'; '--max-repair-retries' = 'number'
        '--max-protocol-retries' = 'number'; '--max-transport-retries' = 'number'
        '--max-evidence-refreshes' = 'number'; '--max-no-progress' = 'number'
        '--host-timeout-minutes' = 'number'
    }
    $switchOptions = @('--json', '--no-recovery', '--fresh-session', '--help')
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    for ($index = 0; $index -lt $RunnerArguments.Count; $index++) {
        $flag = $RunnerArguments[$index]
        if (-not $seen.Add($flag)) { throw "Repeated runner option: $flag" }
        if ($switchOptions -ccontains $flag) { continue }
        if (-not ($valueOptions.Keys -ccontains $flag)) {
            throw "Unsupported runner option: $flag. Use the Linux CLI directly for host evidence, executable overrides or runtime upgrades."
        }
        $index++
        if ($index -ge $RunnerArguments.Count) { throw "Missing value for runner option: $flag" }
        $value = $RunnerArguments[$index]
        if ([string]::IsNullOrEmpty($value) -or $value.StartsWith('--') -or $value -match '\p{Cc}') {
            throw "Invalid value for runner option: $flag"
        }
        switch ($valueOptions[$flag]) {
            'step' { if ($value -cnotmatch '^\d{1,2}$') { throw "Invalid package number for $flag" } }
            'number' { if ($value -cnotmatch '^\d+(?:\.\d+)?$') { throw "Invalid nonnegative numeric value for $flag" } }
            'uuid' { if ($value -cnotmatch '^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$') { throw 'Session must be a UUID.' } }
        }
    }

    $wsl = Get-Command 'wsl.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $wsl) { throw 'wsl.exe was not found. Install WSL2 and a Linux distribution before using this launcher.' }
    $wslPath = $wsl.Source
    $probeArguments = @('--distribution', $Distribution, '--exec', 'uname', '-r')
    $kernelLines = @(& $wslPath @probeArguments)
    $probeExit = $LASTEXITCODE
    if ($probeExit -ne 0) {
        [Console]::Error.WriteLine("Could not inspect WSL distribution '$Distribution'. Verify its name and installation with wsl --list --verbose.")
        exit $probeExit
    }
    $kernel = $kernelLines -join "`n"
    if ($kernel -notmatch '(?i)microsoft-standard[^\r\n]*wsl2') {
        throw "Distribution '$Distribution' did not report a WSL2 kernel. WSL1 and native Windows execution are not supported."
    }

    $Action = $Action.ToLowerInvariant()
    $bundle = "docs/implementation-plans/$Plan/run.mjs"
    $arguments = @('--distribution', $Distribution, '--cd', $Repository, '--exec', 'node', $bundle, $Action) + $RunnerArguments
    & $wslPath @arguments
    $runnerExit = $LASTEXITCODE
    exit $runnerExit
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
