# Run the Rust Job inheritance test while the test executable itself is in an outer Job.
# This exercises Windows nested-Job behavior without a spawn-before-assign window.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$TestExe,
  [Parameter(Mandatory=$true)][string]$NodeExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testPath = [IO.Path]::GetFullPath($TestExe)
$nodePath = [IO.Path]::GetFullPath($NodeExe)
foreach ($path in @($testPath, $nodePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing test input: $path" }
}
$env:RELAY_TEST_NODE = $nodePath
$env:RELAY_EXPECT_OUTER_JOB = 'true'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RelayOuterJobProbe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct StartupInfo {
    public uint cb;
    public string reserved;
    public string desktop;
    public string title;
    public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public short showWindow, reserved2;
    public IntPtr reserved2Pointer, standardInput, standardOutput, standardError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ProcessInformation {
    public IntPtr process, thread;
    public uint processId, threadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CreateProcess(string application, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
    IntPtr environment, string currentDirectory, ref StartupInfo startup, out ProcessInformation process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  private static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  public static uint Run(string executable) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Check(job != IntPtr.Zero, "CreateJobObject");
    ProcessInformation process = new ProcessInformation();
    bool launched = false;
    bool assigned = false;
    try {
      StartupInfo startup = new StartupInfo();
      startup.cb = (uint)Marshal.SizeOf(typeof(StartupInfo));
      StringBuilder commandLine = new StringBuilder("\"" + executable +
        "\" --exact job_sidecar::tests::node_child_inherits_the_job_and_stops_with_its_parent --nocapture");
      Check(CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false,
        0x00000004 | 0x08000000, IntPtr.Zero, null, ref startup, out process), "CreateProcess suspended");
      launched = true;
      Check(AssignProcessToJobObject(job, process.process), "AssignProcessToJobObject outer");
      assigned = true;
      if (ResumeThread(process.thread) == 0xFFFFFFFF) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      uint wait = WaitForSingleObject(process.process, 30000);
      if (wait != 0) throw new Exception("Outer-Job test did not finish within 30 seconds, wait=" + wait);
      uint code;
      Check(GetExitCodeProcess(process.process, out code), "GetExitCodeProcess");
      return code;
    } finally {
      // A failed assertion must not leave the nested Node test running.
      TerminateJobObject(job, 1);
      if (launched && !assigned) TerminateProcess(process.process, 1);
      if (launched) { CloseHandle(process.thread); CloseHandle(process.process); }
      CloseHandle(job);
    }
  }
}
'@
$code = [RelayOuterJobProbe]::Run($testPath)
Write-Host "Outer-Job Rust test exit code: $code"
if ($code -ne 0) { exit [int]$code }
