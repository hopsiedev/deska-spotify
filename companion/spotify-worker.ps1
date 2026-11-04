# Proceso PowerShell persistente: compila el C# y abre SMTC una sola vez y atiende comandos por stdin.
# Entrada:  id|cmd|arg(base64 utf8)      Salida: id|json
param([string]$Dir = $PSScriptRoot)
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Keys {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Press(byte vk) { keybd_event(vk, 0, 1, UIntPtr.Zero); keybd_event(vk, 0, 3, UIntPtr.Zero); }
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int m, out IntPtr d); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int a(); int b(); int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl2 s); }
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
  int a(); int b(); int c(); int d(); int e(); int f(); int g(); int h(); int i();
  int j(); int k(); int GetProcessId(out uint pid);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume { int SetMasterVolume(float v, ref Guid ctx); int GetMasterVolume(out float v); }
public static class AppVolume {
  // level >= 0: fija el volumen; level < 0: lo lee. Devuelve el volumen (0..1) o -1 si no hay sesión.
  public static float Do(uint[] pids, float level) {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
    IMMDevice dev; en.GetDefaultAudioEndpoint(0, 1, out dev);
    var iid = typeof(IAudioSessionManager2).GUID; object o; dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    IAudioSessionEnumerator se; ((IAudioSessionManager2)o).GetSessionEnumerator(out se);
    int n; se.GetCount(out n); float res = -1; var g = Guid.Empty;
    for (int i = 0; i < n; i++) {
      IAudioSessionControl2 s; se.GetSession(i, out s);
      uint pid; s.GetProcessId(out pid);
      if (Array.IndexOf(pids, pid) < 0) continue;
      var v = (ISimpleAudioVolume)s;
      if (level >= 0) { v.SetMasterVolume(level, ref g); res = level; } else { v.GetMasterVolume(out res); }
    }
    return res;
  }
}
'@

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(5000); $t.Result }
function AwaitAction($op) { $t = [System.WindowsRuntimeSystemExtensions]::AsTask($op); [void]$t.Wait(5000) }

$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$coverKey = ''
$coverFile = Join-Path $Dir '.cover.img'

function Get-Session { $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'Spotify' } | Select-Object -First 1 }
function Get-SpotifyPids { [uint32[]]@(Get-Process Spotify -EA 0 | ForEach-Object Id) }

$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1 } | Select-Object -First 1
function Save-Cover($props) {
  $ref = $props.Thumbnail
  if (-not $ref) { return }
  $stream = Await ($ref.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $net = $asStream.Invoke($null, @($stream))
  $ms = New-Object IO.MemoryStream
  $net.CopyTo($ms)
  if ($ms.Length -gt 0) { [IO.File]::WriteAllBytes($coverFile, $ms.ToArray()) }
}

function Get-Status {
  $s = Get-Session
  if (-not $s) { return @{ run = $false } }
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $key = "$($props.Title)|$($props.Artist)|$($props.AlbumTitle)"
  if ($key -ne $script:coverKey) {
    try { Save-Cover $props } catch { [Console]::Error.WriteLine("cover: $_") }
    $script:coverKey = $key
  }
  $hash = [BitConverter]::ToString([Security.Cryptography.MD5]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '').Substring(0, 10)
  $vol = [AppVolume]::Do((Get-SpotifyPids), -1)
  $isPlaying = ($s.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing')
  $tl = $s.GetTimelineProperties()
  $pos = $tl.Position.TotalSeconds
  # La posición es una instantánea: si suena, se le suma el tiempo desde su última actualización.
  if ($isPlaying) { $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime.ToUniversalTime()).TotalSeconds }
  $dur = $tl.EndTime.TotalSeconds
  if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
  @{
    run = $true
    playing = $isPlaying
    pos = [math]::Round($pos, 1); dur = [math]::Round($dur, 1)
    title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle
    cover = $hash
    vol = if ($vol -ge 0) { [int][math]::Round($vol * 100) } else { $null }
  }
}

function Media($method, [byte]$fallbackKey) {
  $s = Get-Session
  if ($s) { [void](Await ($s.$method()) ([bool])) } else { [Keys]::Press($fallbackKey) }
}

function Invoke-Cmd($cmd, $arg) {
  switch ($cmd) {
    'status' { return Get-Status }
    'toggle' { Media 'TryTogglePlayPauseAsync' 0xB3 }
    'pause'  { Media 'TryPauseAsync' 0xB3 }
    'resume' { Media 'TryPlayAsync' 0xB3 }
    'next'   { Media 'TrySkipNextAsync' 0xB0 }
    'prev'   { Media 'TrySkipPreviousAsync' 0xB1 }
    'seek'   { $s = Get-Session; if ($s) { [void](Await ($s.TryChangePlaybackPositionAsync([long]([double]$arg * 1e7))) ([bool])) } }
    'volume' {
      $p = Get-SpotifyPids
      if (-not $p) { throw 'Spotify no está en ejecución' }
      if ([AppVolume]::Do($p, [int]$arg / 100) -lt 0) { throw 'Spotify no tiene sesión de audio activa' }
    }
    default { throw "comando desconocido: $cmd" }
  }
  return @{}
}

[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $id, $cmd, $b64 = $line.Split('|', 3)
  try {
    $arg = if ($b64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) } else { '' }
    $r = Invoke-Cmd $cmd $arg
    $out = @{ ok = $true; data = $r }
  } catch {
    $out = @{ ok = $false; out = $_.Exception.Message }
  }
  [Console]::Out.WriteLine("$id|" + ($out | ConvertTo-Json -Compress -Depth 5))
}
