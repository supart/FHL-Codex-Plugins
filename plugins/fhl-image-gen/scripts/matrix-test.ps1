param(
  [string]$Prompt = "在河边钓鱼的小狗",
  [int]$Concurrency = 4,
  [int]$MaxRetries = 3,
  [string]$NodeScript = "$HOME\plugins\fhl-image-gen\scripts\generate.mjs",
  [string]$OutputRoot = "$HOME\Pictures\fhl-image-gen\matrix-tests",
  [string]$OnlyQuality = "2K",
  [switch]$NoResize
)

$ErrorActionPreference = "Stop"
$startedAt = Get-Date
$stamp = $startedAt.ToString("yyyyMMdd_HHmmss")
$outputDir = Join-Path $OutputRoot $stamp
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$resultsJsonl = Join-Path $outputDir "matrix_results.jsonl"
$summaryJson = Join-Path $outputDir "matrix_summary.json"
$contactSheet = Join-Path $outputDir "matrix_contact_sheet.png"

$matrix = @(
  [pscustomobject]@{ Index=1; Quality="1K"; Aspect="1:1"; Size="1024x1024" },
  [pscustomobject]@{ Index=2; Quality="1K"; Aspect="3:2"; Size="1536x1024" },
  [pscustomobject]@{ Index=3; Quality="1K"; Aspect="2:3"; Size="1024x1536" },
  [pscustomobject]@{ Index=4; Quality="1K"; Aspect="4:3"; Size="1536x1152" },
  [pscustomobject]@{ Index=5; Quality="1K"; Aspect="3:4"; Size="1152x1536" },
  [pscustomobject]@{ Index=6; Quality="1K"; Aspect="5:4"; Size="1520x1216" },
  [pscustomobject]@{ Index=7; Quality="1K"; Aspect="4:5"; Size="1216x1520" },
  [pscustomobject]@{ Index=8; Quality="1K"; Aspect="16:9"; Size="1536x864" },
  [pscustomobject]@{ Index=9; Quality="1K"; Aspect="9:16"; Size="864x1536" },
  [pscustomobject]@{ Index=10; Quality="1K"; Aspect="2:1"; Size="1536x768" },
  [pscustomobject]@{ Index=11; Quality="1K"; Aspect="1:2"; Size="768x1536" },
  [pscustomobject]@{ Index=12; Quality="1K"; Aspect="3:1"; Size="1536x512" },
  [pscustomobject]@{ Index=13; Quality="1K"; Aspect="1:3"; Size="512x1536" },
  [pscustomobject]@{ Index=14; Quality="1K"; Aspect="7:4"; Size="1664x944" },
  [pscustomobject]@{ Index=15; Quality="1K"; Aspect="4:7"; Size="944x1664" },
  [pscustomobject]@{ Index=16; Quality="2K"; Aspect="1:1"; Size="2048x2048" },
  [pscustomobject]@{ Index=17; Quality="2K"; Aspect="3:2"; Size="2048x1360" },
  [pscustomobject]@{ Index=18; Quality="2K"; Aspect="2:3"; Size="1360x2048" },
  [pscustomobject]@{ Index=19; Quality="2K"; Aspect="4:3"; Size="2048x1536" },
  [pscustomobject]@{ Index=20; Quality="2K"; Aspect="3:4"; Size="1536x2048" },
  [pscustomobject]@{ Index=21; Quality="2K"; Aspect="5:4"; Size="2040x1632" },
  [pscustomobject]@{ Index=22; Quality="2K"; Aspect="4:5"; Size="1632x2040" },
  [pscustomobject]@{ Index=23; Quality="2K"; Aspect="16:9"; Size="2048x1152" },
  [pscustomobject]@{ Index=24; Quality="2K"; Aspect="9:16"; Size="1152x2048" },
  [pscustomobject]@{ Index=25; Quality="2K"; Aspect="2:1"; Size="2048x1024" },
  [pscustomobject]@{ Index=26; Quality="2K"; Aspect="1:2"; Size="1024x2048" },
  [pscustomobject]@{ Index=27; Quality="2K"; Aspect="3:1"; Size="2040x680" },
  [pscustomobject]@{ Index=28; Quality="2K"; Aspect="1:3"; Size="680x2040" },
  [pscustomobject]@{ Index=29; Quality="2K"; Aspect="7:4"; Size="2208x1264" },
  [pscustomobject]@{ Index=30; Quality="2K"; Aspect="4:7"; Size="1264x2208" },
  [pscustomobject]@{ Index=31; Quality="4K"; Aspect="1:1"; Size="2880x2880" },
  [pscustomobject]@{ Index=32; Quality="4K"; Aspect="3:2"; Size="3520x2352" },
  [pscustomobject]@{ Index=33; Quality="4K"; Aspect="2:3"; Size="2352x3520" },
  [pscustomobject]@{ Index=34; Quality="4K"; Aspect="4:3"; Size="3840x2880" },
  [pscustomobject]@{ Index=35; Quality="4K"; Aspect="3:4"; Size="2880x3840" },
  [pscustomobject]@{ Index=36; Quality="4K"; Aspect="5:4"; Size="3840x3072" },
  [pscustomobject]@{ Index=37; Quality="4K"; Aspect="4:5"; Size="3072x3840" },
  [pscustomobject]@{ Index=38; Quality="4K"; Aspect="16:9"; Size="3840x2160" },
  [pscustomobject]@{ Index=39; Quality="4K"; Aspect="9:16"; Size="2160x3840" },
  [pscustomobject]@{ Index=40; Quality="4K"; Aspect="2:1"; Size="3840x1920" },
  [pscustomobject]@{ Index=41; Quality="4K"; Aspect="1:2"; Size="1920x3840" },
  [pscustomobject]@{ Index=42; Quality="4K"; Aspect="3:1"; Size="3840x1280" },
  [pscustomobject]@{ Index=43; Quality="4K"; Aspect="1:3"; Size="1280x3840" },
  [pscustomobject]@{ Index=44; Quality="4K"; Aspect="7:4"; Size="3808x2176" },
  [pscustomobject]@{ Index=45; Quality="4K"; Aspect="4:7"; Size="2176x3808" }
)

if ($OnlyQuality) {
  $matrix = @($matrix | Where-Object { $_.Quality -eq $OnlyQuality })
  $nextIndex = 1
  foreach ($item in $matrix) {
    $item.Index = $nextIndex
    $nextIndex += 1
  }
}

function Test-PngFile {
  param([string]$Path, [string]$ExpectedSize)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ Exists=$false; Bytes=0; PngSignature=$false; Width=0; Height=0; DimensionsOk=$false }
  }
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  $sigOk = $bytes.Length -ge 24 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
  $width = 0
  $height = 0
  if ($sigOk) {
    $width = (([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19])
    $height = (([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23])
  }
  $parts = $ExpectedSize -split "x"
  [pscustomobject]@{
    Exists=$true
    Bytes=$bytes.Length
    PngSignature=$sigOk
    Width=$width
    Height=$height
    DimensionsOk=($width -eq [int]$parts[0] -and $height -eq [int]$parts[1])
  }
}

$jobScript = {
  param($NodeScript, $Prompt, $OutputDir, $Item, $MaxRetries, $NoResize)

  function Test-PngFileInner {
    param([string]$Path, [string]$ExpectedSize)
    if (-not (Test-Path -LiteralPath $Path)) {
      return [pscustomobject]@{ Exists=$false; Bytes=0; PngSignature=$false; Width=0; Height=0; DimensionsOk=$false }
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $sigOk = $bytes.Length -ge 24 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47 -and $bytes[4] -eq 0x0D -and $bytes[5] -eq 0x0A -and $bytes[6] -eq 0x1A -and $bytes[7] -eq 0x0A
    $width = 0
    $height = 0
    if ($sigOk) {
      $width = (([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19])
      $height = (([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23])
    }
    $parts = $ExpectedSize -split "x"
    [pscustomobject]@{
      Exists=$true
      Bytes=$bytes.Length
      PngSignature=$sigOk
      Width=$width
      Height=$height
      DimensionsOk=($width -eq [int]$parts[0] -and $height -eq [int]$parts[1])
    }
  }

  $maxAttempts = 1 + [int]$MaxRetries
  $attempt = 0
  $lastOutput = ""
  $started = Get-Date
  while ($attempt -lt $maxAttempts) {
    $attempt += 1
    $nodeArgs = @($NodeScript, "--prompt", $Prompt, "--quality", $Item.Quality, "--aspect", $Item.Aspect, "--output-dir", $OutputDir)
    if ($NoResize) { $nodeArgs += "--no-resize" }
    $output = & node @nodeArgs 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String).Trim()
    $lastOutput = $text
    if ($exitCode -eq 0) {
      $path = $null
      foreach ($line in ($text -split "`r?`n")) {
        if ($line -match "^Path:\s*(.+)$") {
          $path = $Matches[1].Trim()
        }
      }
      $validation = Test-PngFileInner -Path $path -ExpectedSize $Item.Size
      return [pscustomobject]@{
        Index=$Item.Index
        Quality=$Item.Quality
        Aspect=$Item.Aspect
        ExpectedSize=$Item.Size
        Ok=($validation.Exists -and $validation.PngSignature -and ($NoResize -or $validation.DimensionsOk))
        Attempts=$attempt
        Retries=($attempt - 1)
        Path=$path
        Bytes=$validation.Bytes
        Width=$validation.Width
        Height=$validation.Height
        PngSignature=$validation.PngSignature
        DimensionsOk=$validation.DimensionsOk
        Error=$null
        StartedAt=$started
        EndedAt=(Get-Date)
      }
    }
    if ($attempt -lt $maxAttempts) {
      Start-Sleep -Seconds 15
    }
  }
  [pscustomobject]@{
    Index=$Item.Index
    Quality=$Item.Quality
    Aspect=$Item.Aspect
    ExpectedSize=$Item.Size
    Ok=$false
    Attempts=$attempt
    Retries=([Math]::Max(0, $attempt - 1))
    Path=$null
    Bytes=0
    Width=0
    Height=0
    PngSignature=$false
    DimensionsOk=$false
    Error=$lastOutput
    StartedAt=$started
    EndedAt=(Get-Date)
  }
}

function New-ContactSheet {
  param([object[]]$Results, [string]$Path)
  Add-Type -AssemblyName System.Drawing
  $cols = 5
  $thumbW = 300
  $thumbH = 190
  $labelH = 58
  $pad = 12
  $cellW = $thumbW + ($pad * 2)
  $cellH = $thumbH + $labelH + ($pad * 2)
  $rows = [int][Math]::Ceiling($Results.Count / $cols)
  $sheet = New-Object System.Drawing.Bitmap ($cols * $cellW), ($rows * $cellH)
  $g = [System.Drawing.Graphics]::FromImage($sheet)
  $g.Clear([System.Drawing.Color]::White)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $font = New-Object System.Drawing.Font "Segoe UI", 9
  $brush = [System.Drawing.Brushes]::Black
  $failBrush = [System.Drawing.Brushes]::DarkRed
  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::LightGray), 1
  foreach ($result in ($Results | Sort-Object Index)) {
    $i = [int]$result.Index - 1
    $col = $i % $cols
    $row = [int][Math]::Floor($i / $cols)
    $x = $col * $cellW
    $y = $row * $cellH
    $g.DrawRectangle($borderPen, $x + 2, $y + 2, $cellW - 4, $cellH - 4)
    if ($result.Ok -and $result.Path -and (Test-Path -LiteralPath $result.Path)) {
      $img = [System.Drawing.Image]::FromFile($result.Path)
      try {
        $scale = [Math]::Min($thumbW / $img.Width, $thumbH / $img.Height)
        $drawW = [int]($img.Width * $scale)
        $drawH = [int]($img.Height * $scale)
        $drawX = $x + $pad + [int](($thumbW - $drawW) / 2)
        $drawY = $y + $pad + [int](($thumbH - $drawH) / 2)
        $g.DrawImage($img, $drawX, $drawY, $drawW, $drawH)
      } finally {
        $img.Dispose()
      }
    }
    $label = "{0}. {1} {2}`n{3} {4}" -f $result.Index, $result.Quality, $result.Aspect, $result.ExpectedSize, ($(if ($result.Ok) { "OK" } else { "FAIL" }))
    $g.DrawString($label, $font, ($(if ($result.Ok) { $brush } else { $failBrush })), $x + $pad, $y + $pad + $thumbH + 4)
  }
  $font.Dispose()
  $borderPen.Dispose()
  $g.Dispose()
  $sheet.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $sheet.Dispose()
}

$queue = New-Object System.Collections.Queue
foreach ($item in $matrix) { $queue.Enqueue($item) }
$running = @()
$results = @()

Write-Host "Matrix test started: prompt=$Prompt, total=$($matrix.Count), concurrency=$Concurrency, noResize=$NoResize, output=$outputDir"

while ($queue.Count -gt 0 -or $running.Count -gt 0) {
  while ($queue.Count -gt 0 -and $running.Count -lt $Concurrency) {
    $item = $queue.Dequeue()
    Write-Host ("START {0}/{1} {2} {3} {4}" -f $item.Index, $matrix.Count, $item.Quality, $item.Aspect, $item.Size)
    $job = Start-Job -ScriptBlock $jobScript -ArgumentList $NodeScript, $Prompt, $outputDir, $item, $MaxRetries, [bool]$NoResize
    $running += [pscustomobject]@{ Job=$job; Item=$item }
  }
  if ($running.Count -eq 0) { continue }
  $completed = Wait-Job -Job ($running | ForEach-Object { $_.Job }) -Any -Timeout 5
  if ($null -eq $completed) { continue }
  foreach ($job in @($completed)) {
    $entry = $running | Where-Object { $_.Job.Id -eq $job.Id } | Select-Object -First 1
    $result = Receive-Job -Job $job
    Remove-Job -Job $job
    if ($result -is [array]) { $result = $result[-1] }
    $results += $result
    $result | ConvertTo-Json -Compress -Depth 5 | Add-Content -LiteralPath $resultsJsonl -Encoding UTF8
    Write-Host ("DONE {0}/{1} {2} {3} {4} raw={5}x{6} exact={7} ok={8} attempts={9} retries={10}" -f $results.Count, $matrix.Count, $result.Quality, $result.Aspect, $result.ExpectedSize, $result.Width, $result.Height, $result.DimensionsOk, $result.Ok, $result.Attempts, $result.Retries)
    $running = @($running | Where-Object { $_.Job.Id -ne $job.Id })
  }
}

New-ContactSheet -Results $results -Path $contactSheet

$endedAt = Get-Date
$ok = @($results | Where-Object { $_.Ok })
$failed = @($results | Where-Object { -not $_.Ok })
$summary = [pscustomobject]@{
  Prompt=$Prompt
  StartedAt=$startedAt
  EndedAt=$endedAt
  Seconds=[Math]::Round(($endedAt - $startedAt).TotalSeconds, 1)
  Total=$matrix.Count
  Success=$ok.Count
  Failed=$failed.Count
  RetryCount=($results | Measure-Object -Property Retries -Sum).Sum
  NoResize=[bool]$NoResize
  AllPng=($results.PngSignature -notcontains $false)
  AllDimensionsOk=($results.DimensionsOk -notcontains $false)
  OutputDir=$outputDir
  ContactSheet=$contactSheet
  Results=$results
}

$summary | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryJson -Encoding UTF8
Write-Host "SUMMARY_JSON: $summaryJson"
Write-Host "CONTACT_SHEET: $contactSheet"
Write-Host ("SUMMARY total={0} success={1} failed={2} retries={3} seconds={4}" -f $summary.Total, $summary.Success, $summary.Failed, $summary.RetryCount, $summary.Seconds)

if ($failed.Count -gt 0) { exit 1 }
exit 0
