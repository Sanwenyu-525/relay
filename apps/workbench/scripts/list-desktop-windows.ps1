Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class RelayWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static List<string> List(uint pid) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid) {
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        RECT r; GetWindowRect(h, out r);
        rows.Add(h.ToString() + " | vis=" + IsWindowVisible(h) + " | " + (r.R - r.L) + "x" + (r.B - r.T)
          + " | cls=" + c.ToString() + " | title=" + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
"@
$proc = Get-Process relay-desktop -ErrorAction Stop | Select-Object -First 1
Write-Host ("pid=" + $proc.Id + " MainWindowHandle=" + $proc.MainWindowHandle)
[RelayWindows]::List([uint32]$proc.Id) | ForEach-Object { Write-Host $_ }
