# Harness CLI installer for Windows.
#
# Usage:
#   irm https://raw.githubusercontent.com/cgast/harness/main/scripts/install.ps1 | iex
#
# Environment variables:
#   HARNESS_VERSION   - Specific version to install (default: latest)
#   HARNESS_INSTALL   - Installation directory (default: ~\.harness\bin)

$ErrorActionPreference = 'Stop'

$Repo = "cgast/harness"
$BaseUrl = "https://github.com/$Repo/releases"
$InstallDir = if ($env:HARNESS_INSTALL) { $env:HARNESS_INSTALL } else { "$HOME\.harness\bin" }

function Write-Info($msg)    { Write-Host "  > $msg" -ForegroundColor Blue }
function Write-Ok($msg)      { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Err($msg)     { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

# ── Detect architecture ──────────────────────────────────────────
function Get-Arch {
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    switch ($arch) {
        'X64'   { return 'x64' }
        'Arm64' { return 'arm64' }
        default { Write-Err "Unsupported architecture: $arch" }
    }
}

# ── Resolve version ─────────────────────────────────────────────
function Get-Version {
    if ($env:HARNESS_VERSION) {
        return $env:HARNESS_VERSION
    }

    Write-Info "Fetching latest version..."
    try {
        $response = Invoke-WebRequest -Uri "$BaseUrl/latest" -MaximumRedirection 0 -ErrorAction SilentlyContinue
    } catch {
        $response = $_.Exception.Response
    }

    $location = $response.Headers.Location
    if (-not $location) {
        # Fallback: parse the redirect from the page
        try {
            $response = Invoke-WebRequest -Uri "$BaseUrl/latest" -UseBasicParsing
            $location = $response.BaseResponse.ResponseUri.AbsoluteUri
            if (-not $location) { $location = $response.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }
        } catch {
            Write-Err "Could not determine latest version"
        }
    }

    $version = ($location -split '/')[-1]
    if (-not $version) { Write-Err "Could not parse version from redirect" }
    return $version
}

# ── Download & install ───────────────────────────────────────────
function Install-Harness {
    $arch = Get-Arch
    $version = Get-Version
    $versionNum = $version -replace '^v', ''

    Write-Info "Platform: windows/$arch"
    Write-Info "Version: $version"

    $filename = "Harness Desktop-Setup-$versionNum-$arch.exe"
    $url = "$BaseUrl/download/$version/$filename"

    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "harness-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $tmpFile = Join-Path $tmpDir $filename

    Write-Info "Downloading $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmpFile -UseBasicParsing
    } catch {
        Write-Err "Download failed. Check that version $version exists."
    }

    # Create install directory
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    # For NSIS installer, run it; for portable, just copy
    if ($filename -match '\.exe$') {
        Write-Info "Running installer..."
        Start-Process -FilePath $tmpFile -ArgumentList '/S' -Wait
        Write-Ok "Harness Desktop installed via Windows installer"
    } else {
        Copy-Item $tmpFile -Destination (Join-Path $InstallDir "harness.exe") -Force
        Write-Ok "Installed to $InstallDir\harness.exe"
    }

    # Clean up
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

    # ── Update PATH ──────────────────────────────────────────────
    $currentPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($currentPath -notlike "*$InstallDir*") {
        Write-Info "Adding $InstallDir to user PATH"
        [Environment]::SetEnvironmentVariable('Path', "$InstallDir;$currentPath", 'User')
        $env:PATH = "$InstallDir;$env:PATH"
        Write-Ok "PATH updated (restart your terminal for changes to take effect)"
    }

    Write-Host ""
    Write-Ok "Done! Harness $version installed successfully."
    Write-Host ""
}

# ── Main ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Harness Installer" -ForegroundColor White
Write-Host ""

Install-Harness
