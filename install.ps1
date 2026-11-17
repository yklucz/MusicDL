# Native Windows bootstrap. Does not change PowerShell execution policy.
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$DryRun,
    [switch]$NoSystem,
    [switch]$Help,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$InstallerArgs
)
$ErrorActionPreference = 'Stop'
try {
    $arguments = @()
    if ($Check) { $arguments += '--check' }
    if ($DryRun) { $arguments += '--dry-run' }
    if ($NoSystem) { $arguments += '--no-system' }
    if ($Help) { $arguments += '--help' }
    $arguments += @($InstallerArgs | Where-Object { $_ })
    foreach ($argument in $arguments) {
        if ($argument -notin @('--check', '--dry-run', '--no-system', '--help', '-h')) { throw "Unknown installer option: $argument. Use -Help." }
    }
    if ($arguments -contains '--help' -or $arguments -contains '-h') {
        Write-Output 'MusicDL installer: .\install.ps1 [-Check | -DryRun] [-NoSystem] (also accepts --check, --dry-run, --no-system)'
        Write-Output '--check / --dry-run: read-only prerequisite and doctor checks; missing dependencies fail.'
        Write-Output '--no-system: refuse system changes; isolated project downloads are allowed. System package changes require confirmation.'
        exit 0
    }
    $nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $cpu = switch ($nativeArch.ToUpperInvariant()) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw "Unsupported Windows architecture: $nativeArch. Native x64 or ARM64 is required." }
    }
    function Test-CompatibleNode([string]$Executable) {
        if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
        & $Executable --eval 'const [a,b]=process.versions.node.split(/\./).map(Number);process.exit(process.arch===process.argv[1]&&(a>24||(a===24&&b>=12))?0:1)' $cpu 2>$null
        return $LASTEXITCODE -eq 0
    }
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    $nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } else { $null }
    if (-not (Test-CompatibleNode $nodeExecutable)) {
        $version = '24.22.3'
        $name = "node-v$version-win-$cpu"
        $tools = Join-Path $PSScriptRoot '.tools'
        $nodeExecutable = Join-Path $tools "$name\node.exe"
        if (-not (Test-CompatibleNode $nodeExecutable)) {
            if ($arguments -contains '--check' -or $arguments -contains '--dry-run') { throw 'Missing prerequisite: Node.js >=24.12. Read-only check will not download it. Run .\install.ps1.' }
            New-Item -ItemType Directory -Force -Path $tools | Out-Null
            $staging = Join-Path $tools ('node-bootstrap.' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $staging | Out-Null
            try {
                $base = "https://nodejs.org/dist/v$version"
                Write-Output "Downloading official portable Node.js $version for Windows/$cpu into this project."
                Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt" -OutFile (Join-Path $staging 'SHASUMS256.txt')
                $archive = Join-Path $staging "$name.zip"
                Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.zip" -OutFile $archive
                $checksumLine = Get-Content -LiteralPath (Join-Path $staging 'SHASUMS256.txt') | Where-Object { $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape("$name.zip") + '$') }
                if (@($checksumLine).Count -ne 1) { throw 'Official Node SHA256 entry is missing or ambiguous.' }
                $expected = ($checksumLine -split '\s+')[0]
                if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Node SHA256 verification failed; archive was not installed.' }
                Expand-Archive -LiteralPath $archive -DestinationPath $staging
                if (Test-Path -LiteralPath (Join-Path $tools $name)) { throw 'An incompatible Node directory exists in .tools. Inspect it before retrying.' }
                Move-Item -LiteralPath (Join-Path $staging $name) -Destination (Join-Path $tools $name)
            } finally { Remove-Item -LiteralPath $staging -Recurse -Force }
            if (-not (Test-CompatibleNode $nodeExecutable)) { throw 'Downloaded Node cannot run on this Windows version/architecture.' }
        }
    }
    & $nodeExecutable (Join-Path $PSScriptRoot 'scripts\install.mjs') @arguments
    $result = $LASTEXITCODE
    if ($result -eq 0 -and $arguments -notcontains '--check' -and $arguments -notcontains '--dry-run') {
        $launcherDirectory = if ($env:MUSICDL_BIN_DIR) { $env:MUSICDL_BIN_DIR } else { Join-Path $HOME 'AppData\Local\MusicDL\bin' }
        # Refresh this PowerShell session immediately. The shared installer also updates User PATH.
        $env:Path = $launcherDirectory + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
    }
    exit $result
} catch {
    Write-Error -ErrorAction Continue "MusicDL installation failed: $($_.Exception.Message) Fix the prerequisite and rerun. No execution-policy changes were made."
    exit 1
}
