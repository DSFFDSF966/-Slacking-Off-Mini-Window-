param(
  [ValidateSet('pick','set','reset')][string]$Mode,
  [int64]$ExcludeHwnd = 0,
  [int64]$Hwnd = 0,
  [int]$Alpha = 255
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint c, byte a, uint f);
  public const uint GA_ROOT = 2; public const int GWL_EXSTYLE = -20;
  public const int WS_EX_LAYERED = 0x80000; public const uint LWA_ALPHA = 2;
}
"@

function Get-Title([IntPtr]$Handle) {
  $s = New-Object Text.StringBuilder 512
  [Win32]::GetWindowText($Handle, $s, $s.Capacity) | Out-Null
  return $s.ToString().Trim()
}

if ($Mode -eq 'pick') {
  # 跳过点击“选择窗口”按钮的鼠标事件，等待用户点击目标窗口
  Start-Sleep -Milliseconds 350
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  $clicked = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if (([Win32]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) {
      $null = [Win32]::GetCursorPos([ref]$p)
      $clicked = $true
      while (([Win32]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) { Start-Sleep -Milliseconds 30 }
      break
    }
    Start-Sleep -Milliseconds 30
  }
  if (-not $clicked) { exit 2 }
  $h = [Win32]::GetAncestor([Win32]::WindowFromPoint($p), [Win32]::GA_ROOT)
  if ($h -eq [IntPtr]::Zero -or $h.ToInt64() -eq $ExcludeHwnd) { exit 2 }
  $title = Get-Title $h
  if (-not [Win32]::IsWindowVisible($h) -or [string]::IsNullOrWhiteSpace($title)) { exit 2 }
  [Console]::WriteLine((ConvertTo-Json @{ hwnd=$h.ToInt64(); title=$title } -Compress))
  exit 0
}

if ($Hwnd -eq 0) { exit 2 }
$h = [IntPtr]$Hwnd
$stylePtr = [Win32]::GetWindowLongPtr($h, [Win32]::GWL_EXSTYLE)
$style = $stylePtr.ToInt64()
if ($Mode -eq 'reset') { $Alpha = 255 }
if (($style -band [Win32]::WS_EX_LAYERED) -eq 0) { [Win32]::SetWindowLongPtr($h, [Win32]::GWL_EXSTYLE, [IntPtr]($style -bor [Win32]::WS_EX_LAYERED)) | Out-Null }
if (-not [Win32]::SetLayeredWindowAttributes($h, 0, [byte]$Alpha, [Win32]::LWA_ALPHA)) { exit 3 }
exit 0
