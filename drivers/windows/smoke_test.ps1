# smoke_test.ps1 — All-in-one BridgeCam virtual camera smoke test.
# Run elevated:  Start-Process pwsh -Verb RunAs -ArgumentList '-File smoke_test.ps1'
#
# What it does:
#   1. Stops Frame Server
#   2. Rebuilds DLL + test_reader (clean)
#   3. Clears stale logs/framebuffer
#   4. Deploys DLL
#   5. Restarts Frame Server
#   6. Ensures frame_writer is running
#   7. Waits for camera to stabilize
#   8. Runs test_reader to grab frames
#   9. Checks vcam_qi.log for Start/RequestSample
#  10. Reports PASS/FAIL

param(
    [switch]$SkipBuild,
    [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'
$root = 'C:\Users\conno\OneDrive\old\Documents\CQNNQR\BridgeCam\drivers\windows'
$buildDir = "$root\build"
$progData = 'C:\ProgramData\BridgeCam'
$dll = "$progData\BridgeCamFilter.dll"
$log = "$progData\vcam_qi.log"
$fbuf = "$progData\framebuffer.dat"

function Write-Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Write-OK($msg)       { Write-Host "  OK: $msg" -ForegroundColor Green }
function Write-Fail($msg)     { Write-Host "  FAIL: $msg" -ForegroundColor Red }

$exitCode = 0

# ── 1. Stop Frame Server ──
Write-Step 1 'Stopping Windows Camera Frame Server...'
if (-not $SkipDeploy) {
    Stop-Service -Name FrameServerMonitor -Force -ErrorAction SilentlyContinue
    Stop-Service -Name FrameServer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Write-OK 'Frame Server stopped'
} else {
    Write-Host '  (skipped — -SkipDeploy)'
}

# ── 2. Build ──
Write-Step 2 'Building DLL + test_reader (clean)...'
if (-not $SkipBuild) {
    # Regenerate cmake if needed
    if (-not (Test-Path "$buildDir\CMakeCache.txt")) {
        cmake -S $root -B $buildDir -G 'Visual Studio 18 2025' 2>&1 | Out-Null
    }
    $buildOut = cmake --build $buildDir --config Debug --target BridgeCamFilter --clean-first 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "DLL build failed:`n$buildOut"
        exit 1
    }
    Write-OK 'BridgeCamFilter.dll built'

    $buildOut2 = cmake --build $buildDir --config Debug --target test_reader 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "test_reader build failed:`n$buildOut2"
        exit 1
    }
    Write-OK 'test_reader.exe built'

    # Also rebuild frame_writer if needed
    cmake --build $buildDir --config Debug --target frame_writer 2>&1 | Out-Null
    Write-OK 'frame_writer.exe built'
} else {
    Write-Host '  (skipped — -SkipBuild)'
}

# ── 3. Clear stale data ──
Write-Step 3 'Clearing logs and framebuffer...'
Remove-Item $log -Force -ErrorAction SilentlyContinue
Remove-Item $fbuf -Force -ErrorAction SilentlyContinue
# Also clear TEMP logs for system service
Remove-Item 'C:\Windows\TEMP\bridgecam_qi.log' -Force -ErrorAction SilentlyContinue
Write-OK 'Cleared'

# ── 4. Deploy DLL ──
Write-Step 4 'Deploying DLL...'
if (-not $SkipDeploy) {
    $srcDll = "$buildDir\Debug\BridgeCamFilter.dll"
    if (-not (Test-Path $srcDll)) {
        Write-Fail "Built DLL not found at $srcDll"
        exit 1
    }
    Copy-Item $srcDll $dll -Force
    $ts = (Get-Item $dll).LastWriteTime
    Write-OK "Deployed — timestamp: $ts"
} else {
    Write-Host '  (skipped — -SkipDeploy)'
}

# ── 5. Restart Frame Server ──
Write-Step 5 'Restarting Frame Server...'
if (-not $SkipDeploy) {
    Start-Service -Name FrameServerMonitor -ErrorAction SilentlyContinue
    Start-Service -Name FrameServer -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
    $svc = Get-Service FrameServer
    if ($svc.Status -eq 'Running') { Write-OK 'Frame Server running' }
    else { Write-Fail "Frame Server status: $($svc.Status)"; $exitCode = 1 }
} else {
    Write-Host '  (skipped — -SkipDeploy)'
}

# ── 6. Ensure frame_writer is running ──
Write-Step 6 'Ensuring frame_writer is running...'
$fw = Get-Process frame_writer -ErrorAction SilentlyContinue
if ($fw) {
    Write-OK "Already running (PID $($fw.Id))"
} else {
    $fwExe = "$buildDir\Debug\frame_writer.exe"
    if (Test-Path $fwExe) {
        Start-Process $fwExe -WindowStyle Hidden
        Start-Sleep -Seconds 2
        $fw = Get-Process frame_writer -ErrorAction SilentlyContinue
        if ($fw) { Write-OK "Started (PID $($fw.Id))" }
        else { Write-Fail 'frame_writer did not start'; $exitCode = 1 }
    } else {
        Write-Fail "frame_writer.exe not found at $fwExe"
        $exitCode = 1
    }
}

# Verify framebuffer exists
Start-Sleep -Seconds 2
if (Test-Path $fbuf) {
    $fbSize = (Get-Item $fbuf).Length
    Write-OK "framebuffer.dat exists ($fbSize bytes)"
} else {
    Write-Fail 'framebuffer.dat not found — frame_writer may not be writing'
    $exitCode = 1
}

# ── 7. Wait for camera to stabilize ──
Write-Step 7 'Waiting 5s for camera registration to stabilize...'
Start-Sleep -Seconds 5

# ── 8. Run test_reader ──
Write-Step 8 'Running test_reader smoke test...'
$testExe = "$buildDir\Debug\test_reader.exe"
if (Test-Path $testExe) {
    $testOut = & $testExe 2>&1
    $testExit = $LASTEXITCODE
    Write-Host ($testOut -join "`n")
    if ($testExit -eq 0) {
        Write-OK 'test_reader PASSED'
    } else {
        Write-Fail "test_reader exited with code $testExit"
        $exitCode = $testExit
    }
} else {
    Write-Fail "test_reader.exe not found at $testExe"
    $exitCode = 1
}

# ── 9. Check vcam_qi.log ──
Write-Step 9 'Checking vcam_qi.log...'
if (Test-Path $log) {
    $logContent = Get-Content $log -ErrorAction SilentlyContinue
    $initCount = ($logContent | Select-String 'Source::Initialize called').Count
    $startCount = ($logContent | Select-String 'Source::Start called').Count
    $reqCount = ($logContent | Select-String 'RequestSample').Count
    $shutCount = ($logContent | Select-String 'Shutdown complete').Count
    $activateCount = ($logContent | Select-String 'Activate::ActivateObject called').Count
    $errLines = $logContent | Select-String 'ERROR|FAIL' | Select-Object -First 5

    Write-Host "  ActivateObject calls: $activateCount"
    Write-Host "  Initialize calls:     $initCount"
    Write-Host "  Start calls:          $startCount"
    Write-Host "  RequestSample calls:  $reqCount"
    Write-Host "  Shutdown calls:       $shutCount"

    if ($activateCount -ge 2) { Write-OK 'Multiple ActivateObject calls (enum + capture)' }
    elseif ($activateCount -eq 1) { Write-Host '  WARNING: Only 1 ActivateObject call' -ForegroundColor Yellow }
    if ($startCount -ge 1) { Write-OK 'Start() was called' }
    else { Write-Fail 'Start() was NEVER called'; $exitCode = 1 }
    if ($reqCount -ge 1) { Write-OK "RequestSample called ($reqCount times)" }
    else { Write-Fail 'RequestSample was NEVER called'; $exitCode = 1 }

    if ($errLines) {
        Write-Host '  Error/warning lines:' -ForegroundColor Yellow
        $errLines | ForEach-Object { Write-Host "    $($_.Line)" -ForegroundColor Yellow }
    }

    # Show last 10 lines
    Write-Host "`n  Last 10 log lines:"
    $logContent | Select-Object -Last 10 | ForEach-Object { Write-Host "    $_" }
} else {
    Write-Fail 'vcam_qi.log does not exist'
    $exitCode = 1
}

# ── 10. Final verdict ──
Write-Step 10 'Final Result'
if ($exitCode -eq 0) {
    Write-Host '  ============================================' -ForegroundColor Green
    Write-Host '  SMOKE TEST PASSED — BridgeCam is working!' -ForegroundColor Green
    Write-Host '  ============================================' -ForegroundColor Green
} else {
    Write-Host '  ============================================' -ForegroundColor Red
    Write-Host "  SMOKE TEST FAILED (exit code $exitCode)" -ForegroundColor Red
    Write-Host '  ============================================' -ForegroundColor Red
}

exit $exitCode
