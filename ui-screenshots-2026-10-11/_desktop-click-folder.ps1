Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinClick {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  public const int MOUSEEVENTF_LEFTDOWN = 0x02;
  public const int MOUSEEVENTF_LEFTUP = 0x04;
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
  }
}
"@

$outDir = "D:\Develop\Relay-Agent\ui-screenshots-2026-10-11"
$changeName = [string]([char]0x66F4+[char]0x6362+[char]0x76EE+[char]0x5F55)
$openName = [string]([char]0x6253+[char]0x5F00+[char]0x6587+[char]0x4EF6+[char]0x5939)

$proc = Get-Process -Name relay-desktop | Select-Object -First 1
[void][WinClick]::ShowWindow($proc.MainWindowHandle, 5)
[void][WinClick]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 500

$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "Relay Agent"))
)
$relay = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
$all = $relay.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

function Click-Named([string]$want) {
  foreach ($el in $all) {
    try {
      $n = $el.Current.Name
      if ($n -eq $want -and $el.Current.IsEnabled) {
        $b = $el.Current.BoundingRectangle
        $x = [int]($b.X + $b.Width/2); $y = [int]($b.Y + $b.Height/2)
        Write-Host "CLICK $want at $x,$y size=$($b.Width)x$($b.Height)"
        [WinClick]::Click($x, $y)
        return $true
      }
    } catch {}
  }
  return $false
}

function Shot([string]$name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "SAVED $name"
}

$ok = Click-Named $changeName
Write-Host "clicked_change=$ok"
Start-Sleep -Milliseconds 900
# refresh tree after dialog
$all = $relay.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
Shot "desktop-folder-change-appdialog.png"

$ok2 = Click-Named $openName
Write-Host "clicked_open=$ok2"
Start-Sleep -Milliseconds 1500
Shot "desktop-os-folder-dialog.png"

# list top windows for dialog detection
$winType = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
$foundDlg = $false
foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winType)) {
  $n = $w.Current.Name
  if ($n -and ($n -match 'Folder|Directory|Browse|[选择]' -or $n.Contains([string]([char]0x9009+[char]0x62E9)))) {
    Write-Host "DIALOG_WIN: $n"; $foundDlg = $true
  }
}
Write-Host "found_dialog=$foundDlg"

# Press Escape to close OS dialog if open
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Write-Host "DONE"