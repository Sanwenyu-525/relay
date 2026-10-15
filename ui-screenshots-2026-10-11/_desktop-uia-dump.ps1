Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Focus2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

$outDir = "D:\Develop\Relay-Agent\ui-screenshots-2026-10-11"
$changeName = [string]([char]0x66F4 + [char]0x6362 + [char]0x76EE + [char]0x5F55)  # 更换目录
$openName = [string]([char]0x6253 + [char]0x5F00 + [char]0x6587 + [char]0x4EF6 + [char]0x5939) # 打开文件夹
Write-Host "changeName=$changeName openName=$openName"

$proc = Get-Process -Name relay-desktop -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host "NO_PROCESS"; exit 2 }
Write-Host "pid=$($proc.Id) hwnd=$($proc.MainWindowHandle) title=$($proc.MainWindowTitle)"
if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
  if ([Win32Focus2]::IsIconic($proc.MainWindowHandle)) { [void][Win32Focus2]::ShowWindow($proc.MainWindowHandle, 9) }
  [void][Win32Focus2]::ShowWindow($proc.MainWindowHandle, 5)
  [void][Win32Focus2]::SetForegroundWindow($proc.MainWindowHandle)
  Start-Sleep -Milliseconds 600
}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Relay Agent"))
)
$relay = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
if (-not $relay) { Write-Host "NO_UIA_WINDOW"; exit 3 }

$all = $relay.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$lines = New-Object System.Collections.Generic.List[string]
$hits = New-Object System.Collections.Generic.List[object]
foreach ($el in $all) {
  try {
    $n = $el.Current.Name
    if (-not $n) { continue }
    $lines.Add("$($el.Current.ControlType.ProgrammaticName) | $n")
    if ($n.Contains($changeName) -or $n.Contains($openName) -or $n -match 'folder|directory|Browse|Open') {
      $hits.Add($el)
      Write-Host "HIT $($el.Current.ControlType.ProgrammaticName) | $n enabled=$($el.Current.IsEnabled)"
    }
  } catch {}
}
[System.IO.File]::WriteAllLines((Join-Path $outDir "_desktop-uia-names.txt"), ($lines | Select-Object -Unique), $utf8)
Write-Host "named_unique=$(($lines | Select-Object -Unique).Count) hits=$($hits.Count)"

$r = $relay.Current.BoundingRectangle
$bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
$bmp.Save((Join-Path $outDir "desktop-relay-window.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "SAVED desktop-relay-window.png"

$clicked = $false
foreach ($el in $hits) {
  try {
    $n = $el.Current.Name
    if (-not $el.Current.IsEnabled) { continue }
    if ($n.Contains($changeName) -or $n.Contains($openName)) {
      $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $pat.Invoke()
      Write-Host "INVOKED $n"
      $clicked = $true
      Start-Sleep -Milliseconds 1200
      break
    }
  } catch { Write-Host "invoke_err=$($_.Exception.Message)" }
}

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp3 = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g3 = [System.Drawing.Graphics]::FromImage($bmp3)
$g3.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp3.Save((Join-Path $outDir "desktop-os-folder-dialog.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g3.Dispose(); $bmp3.Dispose()
Write-Host "SAVED desktop-os-folder-dialog.png clicked=$clicked"

# Check for dialog windows
$winType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winType)) {
  $n = $w.Current.Name
  if ($n) { Write-Host "TOPWIN: $n" }
}