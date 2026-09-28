# Parasites New Dawn - Enhanced :: The Hive Remembers - read-only USB lane check for the Coral USB Accelerator.
#
#   powershell -ExecutionPolicy Bypass -File oracle\tools\usbports.ps1
#
# Read-only. It changes nothing: no driver, device, service, registry or power setting is touched, and no
# process is started or ended. It asks each USB 3 root hub (the same query IOCTLs USBView uses) which ports
# speak USB 2 / USB 3, which port is the SuperSpeed companion of which, and what is attached at what speed,
# then lists the Coral's Plug and Play entries:
#   1A6E:089A  the Coral in its DFU bootloader (before the Edge TPU runtime uploads its firmware)
#   18D1:9302  the Coral after the firmware upload (expected on a SuperSpeed port)
# TDD 4.1 / 6.4: after installing the runtime and replugging, expect 18D1:9302 on the SuperSpeed companion
# port at speed Super once the TPU worker has opened the device once.

$ErrorActionPreference = 'Continue'
$src = @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PneUsbQ {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern SafeFileHandle CreateFile(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool DeviceIoControl(SafeFileHandle h, uint code, byte[] inb, int inl, byte[] outb, int outl, out int ret, IntPtr ov);
  public static byte[] Ioctl(SafeFileHandle h, uint code, byte[] buf) {
    int r; bool ok = DeviceIoControl(h, code, buf, buf.Length, buf, buf.Length, out r, IntPtr.Zero);
    if (!ok) return null; return buf;
  }
}
"@
Add-Type -TypeDefinition $src

$GUID_HUB = '{f18a0e88-c30c-11d0-8815-00a0c906bed8}'
$IOCTL_NODE_INFO = 0x220408         # IOCTL_USB_GET_NODE_INFORMATION
$IOCTL_CONN_INFO_EX = 0x220448      # IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX
$IOCTL_PORT_PROPS = 0x220458        # IOCTL_USB_GET_PORT_CONNECTOR_PROPERTIES
$IOCTL_CONN_INFO_V2 = 0x22045C      # IOCTL_USB_GET_NODE_CONNECTION_INFORMATION_EX_V2
$speeds = @('Low', 'Full', 'High', 'Super')

$hubs = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'USB\ROOT_HUB30*' })
if ($hubs.Count -eq 0) { 'No USB 3 root hub found.' }
foreach ($hub in $hubs) {
  $path = '\\?\' + ($hub.InstanceId -replace '\\', '#') + '#' + $GUID_HUB
  $h = [PneUsbQ]::CreateFile($path, 0x40000000, 2, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
  if ($h.IsInvalid) { "Root hub {0}: cannot query (error {1})" -f $hub.FriendlyName, [Runtime.InteropServices.Marshal]::GetLastWin32Error(); continue }
  $ni = [PneUsbQ]::Ioctl($h, $IOCTL_NODE_INFO, (New-Object byte[] 80))
  if (-not $ni) { "Root hub {0}: no node information" -f $hub.FriendlyName; $h.Close(); continue }
  $nports = $ni[6]
  "Root hub: {0} ({1} ports)" -f $hub.FriendlyName, $nports
  for ($p = 1; $p -le $nports; $p++) {
    $v2 = New-Object byte[] 16
    [BitConverter]::GetBytes([uint32]$p).CopyTo($v2, 0)
    [BitConverter]::GetBytes([uint32]16).CopyTo($v2, 4)
    [BitConverter]::GetBytes([uint32]7).CopyTo($v2, 8)
    $v2 = [PneUsbQ]::Ioctl($h, $IOCTL_CONN_INFO_V2, $v2)
    $proto = if ($v2) { [BitConverter]::ToUInt32($v2, 8) } else { 0 }
    $cp = New-Object byte[] 512
    [BitConverter]::GetBytes([uint32]$p).CopyTo($cp, 0)
    $cp = [PneUsbQ]::Ioctl($h, $IOCTL_PORT_PROPS, $cp)
    $props = 0; $comp = 0
    if ($cp) { $props = [BitConverter]::ToUInt32($cp, 8); $comp = [BitConverter]::ToUInt16($cp, 14) }
    $ci = New-Object byte[] 512
    [BitConverter]::GetBytes([uint32]$p).CopyTo($ci, 0)
    $ci = [PneUsbQ]::Ioctl($h, $IOCTL_CONN_INFO_EX, $ci)
    $dev = ''; $spd = ''
    if ($ci -and [BitConverter]::ToUInt32($ci, 31) -eq 1) {
      $dev = '{0:X4}:{1:X4}' -f [BitConverter]::ToUInt16($ci, 12), [BitConverter]::ToUInt16($ci, 14)
      $spd = $speeds[[Math]::Min(3, [int]$ci[23])]
    }
    $lanes = @()
    if ($proto -band 1) { $lanes += 'USB1.1' }
    if ($proto -band 2) { $lanes += 'USB2' }
    if ($proto -band 4) { $lanes += 'USB3' }
    $note = ''
    if ($dev -eq '1A6E:089A') { $note = '  <- Coral (bootloader, no firmware yet)' }
    if ($dev -eq '18D1:9302') { $note = '  <- Coral (runtime firmware)' + $(if ($spd -ne 'Super') { ': NOT at SuperSpeed' } else { '' }) }
    "  port {0,2}: {1,-16} companion={2,-2} userConnectable={3} {4} {5}{6}" -f $p, ($lanes -join '+'), $comp, ($props -band 1), $dev, $spd, $note
  }
  $h.Close()
}

''
'Coral Plug and Play entries (present and phantom):'
$coral = @(Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_1A6E&PID_089A|VID_18D1&PID_9302' })
if ($coral.Count -eq 0) { '  none: the Coral has never been seen by this PC, or it is unplugged' }
foreach ($d in $coral) {
  $code = (Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_ProblemCode' -ErrorAction SilentlyContinue).Data
  "  {0}  status={1}  problem code={2}  present={3}" -f $d.InstanceId, $d.Status, $code, $d.Present
}
'Problem code 28 means no driver is installed yet (expected before the Edge TPU runtime install, TDD 6.4).'
