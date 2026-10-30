Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

$outDir = "D:\Develop\Relay-Agent\docs\testing\evidence\ui-screenshots-2026-10-11"
function Save-Screen([string]$name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $path = Join-Path $outDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "SAVED_DESKTOP $name"
}

function Find-Button($root, [string]$name) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

# Find Relay window
$root = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Window)
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
$relay = $null
foreach ($w in $windows) {
  $n = $w.Current.Name
  if ($n -match 'Relay') { Write-Host "WINDOW: $n"; $relay = $w }
}
if (-not $relay) {
  Write-Host "NO_RELAY_WINDOW — listing windows:"
  foreach ($w in $windows) { if ($w.Current.Name) { Write-Host (" - " + $w.Current.Name) } }
  exit 2
}

# Activate
$relay.SetFocus()
Start-Sleep -Milliseconds 400
Save-Screen "desktop-relay-agent-foreground.png"

# Try 更换目录
$change = Find-Button $relay "更换目录"
if (-not $change) { $change = Find-Button $relay "更换工作目录" }
Write-Host "change_btn=$([bool]$change)"
if ($change) {
  try {
    $inv = $change.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $inv.Invoke()
    Start-Sleep -Milliseconds 800
    Save-Screen "desktop-folder-change-dialog.png"
  } catch { Write-Host "invoke_change_err=$($_.Exception.Message)" }
}

# Try 打开文件夹 (native picker)
$open = Find-Button $relay "打开文件夹"
Write-Host "open_folder_btn=$([bool]$open)"
if ($open) {
  $enabled = $open.Current.IsEnabled
  Write-Host "open_folder_enabled=$enabled"
  if ($enabled) {
    try {
      $inv = $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $inv.Invoke()
      Start-Sleep -Milliseconds 1200
      # Look for common file dialog
      $dlg = $null
      foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {
        $n = $w.Current.Name
        if ($n -match '选择|文件夹|Browse|Folder|打开') { Write-Host "DIALOG: $n"; $dlg = $w }
      }
      Save-Screen "desktop-os-folder-dialog.png"
      if ($dlg) {
        # Cancel dialog so we don't leave it open
        $cancel = Find-Button $dlg "取消"
        if (-not $cancel) { $cancel = Find-Button $dlg "Cancel" }
        if ($cancel) { try { $cancel.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {} }
        Write-Host "OS_DIALOG_CAPTURED"
      } else {
        Write-Host "OS_DIALOG_NOT_FOUND_IN_UIA — screenshot still taken"
      }
    } catch { Write-Host "invoke_open_err=$($_.Exception.Message)" }
  } else {
    Write-Host "OPEN_FOLDER_DISABLED — need 更换目录 dialog open first with native path"
  }
} else {
  Write-Host "OPEN_FOLDER_NOT_FOUND — may need to open 更换目录 AppDialog first"
}

# If change opened AppDialog, try open folder again
$open2 = Find-Button $relay "打开文件夹"
if ($open2 -and $open2.Current.IsEnabled) {
  Write-Host "retry open folder"
  try {
    $open2.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1200
    Save-Screen "desktop-os-folder-dialog.png"
    Write-Host "OS_DIALOG_RETRY_SHOT"
  } catch { Write-Host "retry_err=$($_.Exception.Message)" }
}