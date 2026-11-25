# Windows through WSL2

Plan and Run supports Windows by running its Linux runtime inside **WSL2**. Keep Node.js, Git, Codex CLI, authentication, the skill and the project in the same Linux distribution. You can use the WSL terminal directly or the PowerShell launcher below.

Native Windows Node.js execution is not supported in this release. Worker ownership and cleanup currently use POSIX process groups, Unix signals and `/bin/ps`. Windows needs a separate process-tree implementation; removing the OS check would leave cancellation and cleanup unreliable.

## Set up the Linux environment

Use Microsoft's [WSL installation guide](https://learn.microsoft.com/windows/wsl/install) for prerequisites and supported Windows versions. If WSL2 is not installed, these are commands for you to run from an administrator terminal; installation can require a restart:

```powershell
wsl --install -d Ubuntu
wsl --list --verbose
```

The distribution's VERSION must be `2`. For an existing WSL1 installation, follow Microsoft's [version guidance](https://learn.microsoft.com/windows/wsl/basic-commands#set-wsl-version-to-1-or-2) before converting it. This project does not install or convert distributions automatically.

Open Ubuntu:

```powershell
wsl --distribution Ubuntu
```

Inside Ubuntu, install Git, **Linux Node.js 22.13 or later** and Codex CLI using their official installation instructions. Check that these resolve to Linux installations rather than Windows programs under `/mnt/c`:

```sh
node --version
git --version
command -v node
command -v git
command -v codex
codex --version
```

Use [Node.js downloads](https://nodejs.org/en/download) and [Codex CLI installation](https://developers.openai.com/codex/cli). Sign in to Codex **inside Ubuntu** with `codex login`, or configure your chosen supported provider there. Windows sign-in does not establish Linux authentication. The runner's preflight still determines whether that authentication mechanism is supported.

Install the skill inside Ubuntu. A clone refuses to replace an existing destination; inspect an existing installation before changing it.

```sh
mkdir -p "$HOME/.agents/skills"
git clone https://github.com/aelkayesh/plan-and-run.git \
  "$HOME/.agents/skills/plan-and-run"
cd "$HOME/.agents/skills/plan-and-run"
npm run check
npm run demo
```

The demo uses fake workers and real local assertions. It needs no Codex login or model calls. Start your Codex session from the Linux project directory to discover the Linux skill installation.

## Keep the project in the Linux filesystem

Use a path such as `/home/you/projects/my-app`, with an existing Git commit. Microsoft's [filesystem guidance](https://learn.microsoft.com/windows/wsl/filesystems) recommends the Linux filesystem for Linux tools. The PowerShell launcher requires an absolute path under `/home/` and refuses direct `/mnt/c`, Windows drive and UNC repository paths. This checks the input syntax; do not use symlinks or bind mounts that put the actual project on Windows storage.

For an existing Windows checkout, make a deliberate Linux clone or copy after preserving your changes. Do not move a checkout with started runner state: progress binds the original canonical checkout. Keep Windows and Linux `node_modules`, Codex authentication and generated execution state separate.

Author a plan using [the plan format](plan-format.md), review it, and set its manifest to `"ready": true` when complete. From your WSL project directory:

```sh
node docs/implementation-plans/my-feature/run.mjs preflight --from 01 --to 02 --json
node docs/implementation-plans/my-feature/run.mjs start --from 01 --to 02
# After interruption, from the same WSL checkout:
node docs/implementation-plans/my-feature/run.mjs resume --from 01 --to 02
```

Real `start` and `resume` calls consume your Codex quota or API budget. Preflight is a local readiness check, not a quota or remote authorization guarantee.

## Optional PowerShell launcher

Use [PowerShell 7.3+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`) on Windows. The script can live in a Windows clone of this repository or be accessed through the Linux skill clone's `\\wsl.localhost` share. The project and its execution stay inside WSL2.

The launcher recognizes the current standard Microsoft WSL2 kernel signature (`microsoft-standard...WSL2`), then delegates directly to `node` through `wsl.exe --exec`; it does not build a shell command string. If you use a custom kernel or an older unrecognized signature, verify VERSION 2 with `wsl --list --verbose` and use the WSL terminal workflow. It does not install WSL, tools or credentials. It supports ordinary run/diagnostic commands; perform runtime upgrades from the WSL terminal after review.

The launcher uses noninteractive WSL execution. First check from PowerShell that the Linux tools are available there:

```powershell
wsl --distribution Ubuntu --exec node --version
wsl --distribution Ubuntu --exec codex --version
```

Shell-managed installations such as `nvm` may work in an interactive WSL terminal while being absent from this PATH. If either command fails, use the WSL terminal workflow with the correct Linux environment; the launcher does not load shell startup files or change your PATH.

Example using the Linux skill clone (replace `you` and the plan name):

```powershell
$launcher = '\\wsl.localhost\Ubuntu\home\you\.agents\skills\plan-and-run\scripts\wsl.ps1'
& $launcher -Distribution Ubuntu -Repository '/home/you/projects/my-app' `
  -Plan my-feature -Action preflight `
  -RunnerArguments @('--from', '01', '--to', '02', '--json')

& $launcher -Distribution Ubuntu -Repository '/home/you/projects/my-app' `
  -Plan my-feature -Action start -RunnerArguments @('--from', '01', '--to', '02')

& $launcher -Distribution Ubuntu -Repository '/home/you/projects/my-app' `
  -Plan my-feature -Action status -RunnerArguments @('--json')
```

The launcher preserves the delegated exit status. Pass runner options as an array; do not combine them into one quoted shell command. Use the same distribution, repository and range for `resume`. If Windows execution policy prevents running the launcher, use the WSL terminal commands above rather than changing machine policy.

## Limits and verification

- Linux/macOS CI exercises the core runner. Native Windows CI exercises the PowerShell launcher's argument forwarding, checks and exit status with a fake `wsl.exe`.
- Those checks are separate: they do not establish an end-to-end WSL2 run with a real Codex account. Run the synthetic demo and preflight in your own distribution before a bounded real task.
- Strict host capabilities still need their documented Linux prerequisites. The launcher does not make Windows browsers, Python environments or Docker installations available to Linux automatically. Start with ordinary receipt verification unless the selected strict adapters are ready.
- Keep WSL and the Windows host running. There is no Windows sleep inhibitor or restart service, and no survival guarantee across Windows sleep, reboot, `wsl --shutdown` or distribution termination.
- For unattended execution and cooperative stop, use the commands in the [runtime contract](runner-contract.md) from the WSL terminal. Never terminate an unknown PID or remove a live runner lock.
