#Requires -Version 7.3
# Native Windows routing tests. The only WSL executable used is compiled below;
# no distribution, model call, account or external service is required.
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Run these launcher tests in PowerShell 7.3+ on Windows.' }

$launcher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'wsl.ps1'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('plan-and-run-windows-' + [Guid]::NewGuid().ToString('N'))
$fakeDirectory = Join-Path $testRoot 'fake wsl'
$callLog = Join-Path $testRoot 'calls.txt'
$passed = 0

function Assert-True([bool] $Value, [string] $Message) {
    if (-not $Value) { throw $Message }
}
function Assert-Equal($Expected, $Actual, [string] $Message) {
    $left = @($Expected)
    $right = @($Actual)
    if ($left.Count -ne $right.Count) { throw "$Message (count $($left.Count) != $($right.Count))" }
    for ($i = 0; $i -lt $left.Count; $i++) {
        if (-not [string]::Equals([string]$left[$i], [string]$right[$i], [StringComparison]::Ordinal)) {
            throw "$Message (element $i differs: '$($left[$i])' != '$($right[$i])')"
        }
    }
}
function Get-Calls {
    if (-not (Test-Path -LiteralPath $callLog)) { return }
    foreach ($line in [IO.File]::ReadAllLines($callLog)) {
        $arguments = @($line.Split("`t") | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) })
        ,$arguments
    }
}
function Invoke-Launcher {
    param(
        [hashtable] $Options,
        [string] $Kernel = '6.6.87.2-microsoft-standard-WSL2',
        [int] $ProbeExit = 0,
        [int] $RunnerExit = 0,
        [switch] $MissingWsl
    )
    if (Test-Path -LiteralPath $callLog) { Remove-Item -LiteralPath $callLog }
    $caseFile = Join-Path $testRoot 'case.json'
    $Options | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $caseFile -Encoding utf8NoBOM
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Process -Id $PID).Path
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $testRoot
    foreach ($argument in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path $testRoot 'invoke.ps1'), '-CaseFile', $caseFile, '-Launcher', $launcher)) {
        $start.ArgumentList.Add($argument)
    }
    $start.Environment['PATH'] = if ($MissingWsl) { $testRoot } else { $fakeDirectory + [IO.Path]::PathSeparator + $env:PATH }
    $start.Environment['PLAN_AND_RUN_TEST_WSL_LOG'] = $callLog
    $start.Environment['PLAN_AND_RUN_TEST_WSL_KERNEL'] = $Kernel
    $start.Environment['PLAN_AND_RUN_TEST_WSL_PROBE_EXIT'] = [string]$ProbeExit
    $start.Environment['PLAN_AND_RUN_TEST_WSL_RUNNER_EXIT'] = [string]$RunnerExit
    $child = [Diagnostics.Process]::new()
    $child.StartInfo = $start
    try {
        Assert-True ($child.Start()) 'Could not start the owned PowerShell test child.'
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (-not $child.WaitForExit(20000)) {
            $child.Kill($true)
            $child.WaitForExit()
            throw 'Owned test child exceeded 20 seconds and was stopped.'
        }
        $result = [pscustomobject]@{ ExitCode = $child.ExitCode; Out = $stdout.GetAwaiter().GetResult(); Error = $stderr.GetAwaiter().GetResult(); Calls = @(Get-Calls) }
        return $result
    } finally { $child.Dispose() }
}
function Test-Case([string] $Name, [scriptblock] $Body) {
    & $Body
    $script:passed++
    Write-Host "ok $script:passed - $Name"
}

try {
    New-Item -ItemType Directory -Path $fakeDirectory | Out-Null
    @'
param([string] $CaseFile, [string] $Launcher)
$ErrorActionPreference = 'Stop'
$parameters = Get-Content -LiteralPath $CaseFile -Raw | ConvertFrom-Json -AsHashtable
& $Launcher @parameters
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath (Join-Path $testRoot 'invoke.ps1') -Encoding utf8NoBOM
    $source = @'
using System;
using System.IO;
using System.Text;
public static class FakeWsl {
    public static int Main(string[] args) {
        string[] encoded = new string[args.Length];
        for (int i = 0; i < args.Length; i++) encoded[i] = Convert.ToBase64String(Encoding.UTF8.GetBytes(args[i]));
        File.AppendAllText(Environment.GetEnvironmentVariable("PLAN_AND_RUN_TEST_WSL_LOG"), String.Join("\t", encoded) + Environment.NewLine, new UTF8Encoding(false));
        bool probe = args.Length == 5 && args[0] == "--distribution" && args[2] == "--exec" && args[3] == "uname" && args[4] == "-r";
        if (probe) {
            Console.WriteLine(Environment.GetEnvironmentVariable("PLAN_AND_RUN_TEST_WSL_KERNEL"));
            return Int32.Parse(Environment.GetEnvironmentVariable("PLAN_AND_RUN_TEST_WSL_PROBE_EXIT"));
        }
        Console.WriteLine("synthetic runner output");
        return Int32.Parse(Environment.GetEnvironmentVariable("PLAN_AND_RUN_TEST_WSL_RUNNER_EXIT"));
    }
}
'@
    $sourceFile = Join-Path $testRoot 'fake-wsl.cs'
    $source | Set-Content -LiteralPath $sourceFile -Encoding utf8NoBOM
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe' }
    Assert-True (Test-Path -LiteralPath $compiler) 'The Windows .NET Framework C# compiler is required for this synthetic test fixture.'
    $executable = Join-Path $fakeDirectory 'wsl.exe'
    & $compiler '/nologo' '/target:exe' "/out:$executable" $sourceFile
    Assert-Equal 0 $LASTEXITCODE 'Fake WSL compilation failed.'
    Assert-True (Test-Path -LiteralPath $executable) 'Fake WSL executable was not produced.'

    # Parse both scripts with the same native PowerShell parser used to run them.
    foreach ($file in @($launcher, $PSCommandPath)) {
        $parseErrors = $null
        [void][Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors)
        Assert-Equal 0 @($parseErrors).Count "PowerShell parser errors in $file"
    }

    Test-Case 'WSL2 probe precedes direct node routing and preserves current directory' {
        $before = (Get-Location).Path
        $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature'; Action = 'status'; RunnerArguments = @('--json') }
        Assert-Equal 0 $r.ExitCode $r.Error
        Assert-Equal 2 $r.Calls.Count 'Expected one probe and one runner call.'
        Assert-Equal @('--distribution','Ubuntu','--exec','uname','-r') $r.Calls[0] 'Unexpected WSL2 probe.'
        Assert-Equal @('--distribution','Ubuntu','--cd','/home/alice/project','--exec','node','docs/implementation-plans/feature/run.mjs','status','--json') $r.Calls[1] 'Unexpected direct runner routing.'
        Assert-Equal $before (Get-Location).Path 'Launcher changed the caller working directory.'
        Assert-True ($r.Out.Contains('synthetic runner output')) 'Runner stdout was not forwarded.'
    }
    Test-Case 'spaces Unicode quotes and shell metacharacters remain literal argument values' {
        $repository = '/home/alice/project space;$(echo nope)&"quote"-é'
        $profile = 'team profile;$(touch nope)&"quoted"-研究'
        $r = Invoke-Launcher @{ Distribution = 'Ubuntu Test (研究)'; Repository = $repository; Plan = 'feature-2'; Action = 'resume'; RunnerArguments = @('--from','01','--to','02','--profile',$profile) }
        Assert-Equal 0 $r.ExitCode $r.Error
        Assert-Equal @('--distribution','Ubuntu Test (研究)','--cd',$repository,'--exec','node','docs/implementation-plans/feature-2/run.mjs','resume','--from','01','--to','02','--profile',$profile) $r.Calls[1] 'Native argument boundaries changed.'
    }
    Test-Case 'case-insensitive PowerShell action is normalized for the Linux CLI' {
        $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature'; Action = 'STATUS' }
        Assert-Equal 0 $r.ExitCode $r.Error
        Assert-Equal 'status' $r.Calls[1][7] 'Action was not normalized.'
    }
    Test-Case 'missing WSL executable fails before any native delegation' {
        $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature' } -MissingWsl
        Assert-True ($r.ExitCode -ne 0) 'Missing WSL executable was accepted.'
        Assert-Equal 0 $r.Calls.Count 'A missing-WSL test unexpectedly invoked an executable.'
        Assert-True ($r.Error.Contains('wsl.exe was not found')) 'Missing actionable WSL installation diagnostic.'
    }
    Test-Case 'runner exit code is propagated' {
        $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature'; Action = 'start'; RunnerArguments = @('--step','01') } -RunnerExit 75
        Assert-Equal 75 $r.ExitCode 'Runner exit code was lost.'
        Assert-Equal 2 $r.Calls.Count 'Expected runner invocation after successful probe.'
    }
    Test-Case 'failed distribution probe preserves its exit code without running node' {
        $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature' } -ProbeExit 17
        Assert-Equal 17 $r.ExitCode 'Probe exit code was lost.'
        Assert-Equal 1 $r.Calls.Count 'Failed probe must not invoke node.'
        Assert-True ($r.Error.Contains('Could not inspect WSL distribution')) 'Missing actionable probe error.'
    }
    foreach ($kernel in @('4.4.0-19041-Microsoft', '6.8.0-generic', '')) {
        Test-Case "kernel '$kernel' is refused without invoking node" {
            $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature' } -Kernel $kernel
            Assert-True ($r.ExitCode -ne 0) 'Non-WSL2 kernel was accepted.'
            Assert-Equal 1 $r.Calls.Count 'Non-WSL2 kernel must not invoke node.'
            Assert-True ($r.Error.Contains('did not report a WSL2 kernel')) 'Missing WSL2 diagnostic.'
        }
    }
    foreach ($action in @('start','resume','preflight','status','dry-run','logs','stop')) {
        Test-Case "ordinary action '$action' is routed explicitly" {
            $r = Invoke-Launcher @{ Repository = '/home/alice/project'; Plan = 'feature'; Action = $action }
            Assert-Equal 0 $r.ExitCode $r.Error
            Assert-Equal $action $r.Calls[1][7] 'Action was not forwarded.'
        }
    }
    $invalidCases = @(
        @{ Repository = 'C:\project'; Plan = 'feature' },
        @{ Repository = '\\server\share'; Plan = 'feature' },
        @{ Repository = '/mnt/c/project'; Plan = 'feature' },
        @{ Repository = '/home/alice/../project'; Plan = 'feature' },
        @{ Repository = '/home/alice/./project'; Plan = 'feature' },
        @{ Repository = '/home/alice//project'; Plan = 'feature' },
        @{ Repository = "/home/alice/project`nother"; Plan = 'feature' },
        @{ Repository = '/home/alice/project'; Plan = '../other' },
        @{ Repository = '/home/alice/project'; Plan = 'Uppercase' },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; Distribution = '--exec' },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; Action = 'runtime-apply' },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--repo','/home/other/project') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--manifest=other.json') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--codex-bin','evil') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--proposal','other.json') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--host-validation','other.json') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--json','--json') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--profile','') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--profile',"bad`nvalue") },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--step','../01') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--session','not-a-uuid') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--profile') },
        @{ Repository = '/home/alice/project'; Plan = 'feature'; RunnerArguments = @('--profile=team') }
    )
    foreach ($options in $invalidCases) {
        Test-Case ('invalid input is refused before WSL: ' + ($options | ConvertTo-Json -Compress)) {
            $r = Invoke-Launcher $options
            Assert-True ($r.ExitCode -ne 0) 'Invalid launcher input was accepted.'
            Assert-Equal 0 $r.Calls.Count 'Invalid launcher input invoked WSL.'
        }
    }
    Write-Host "Passed $passed native Windows launcher cases. Fake WSL only; no WSL2 end-to-end run is claimed."
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    Assert-True (-not (Test-Path -LiteralPath $testRoot)) 'Owned Windows test fixture cleanup failed.'
}
