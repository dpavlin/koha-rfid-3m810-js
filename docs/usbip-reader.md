# The reader over USB/IP — a manual test rig

This exists so the reader can be tested from a desk that is not the desk the reader
is on. **Workstations plug the 3M 810 straight into the machine running Chrome**
(see `browser-support.md`); nothing about the plugin expects a tunnel, and nothing
about a production installation should need one. It is documented because when the
tunnel breaks, the symptom is "the RFID reader is broken", and that costs an hour
nobody intended to spend.

```
3M 810 ── USB (FTDI FT232, 0403:6001) ──▶ aimax (host, usbipd -D :3240) ──▶ nuc /dev/ttyUSB1 ──▶ Chrome
```

Two machines, and mixing them up wastes an hour: **aimax** is where the reader is
plugged in, **nuc** is where Chrome runs and the tunnel is *consumed*. The Koha server
(`koha-dev.rot13.org`) has no USB anything — `ls /dev/serial/by-id` there is empty, and
`usbip` is not even installed.

## Attach

`make reader` does the whole sequence below (bind on the host, attach here, report the
node and who holds it). The hand steps are kept because when it fails, the failure is
in one of them.

```sh
sudo /usr/sbin/usbip attach -r aimax.lan -b 3-2      # on nuc; remote bus 3, port 2
ls -l /dev/serial/by-id/                             # → usb-FTDI_USB__-__Serial-if00-port0 → ttyUSB1
sudo /usr/sbin/usbip port                            # Port 00: <Port in Use> usbip://aimax.lan:3240/3-2
```

If the attach says `Attach Request for 3-2 failed - Device not found` while `lsusb
-d 0403:6001` on aimax shows the reader, it is present but **not bound for export** —
which is what a physical re-plug leaves behind. Bind it on the host, then attach:

```sh
ssh aimax.lan 'sudo /usr/sbin/usbip bind -b 3-2'     # bound: 3-2 under /sys/bus/usb/drivers/usbip-host/
sudo /usr/sbin/usbip list -r aimax.lan               # the FT232 should be listed now
```

The busid is the physical port, so a re-plug into another socket changes it: read it
from the host rather than trusting this page —
`ssh aimax.lan 'for d in /sys/bus/usb/devices/3-*; do grep -q 0403 $d/idVendor && echo "$(basename $d) $(cat $d/product)"; done'`.

`usbip` is in `/usr/sbin` and root's PATH only — `sudo usbip …` or the absolute path.
The device arrives as `/dev/ttyUSB1` on `ftdi_sio`, 19200 8N1, which is what the
transport opens. `aimax.lan` resolves to an IPv6 ULA, which usbip handles fine.

Detach when finished: `sudo /usr/sbin/usbip detach -p 0`.

## Is it the tunnel, the browser, or the reader?

In the order that has actually saved time:

| What you see | What it is | How to tell |
| --- | --- | --- |
| Pill `RFID !`, error `Failed to open serial port` | **Another tab or window holds the reader.** Web Serial gives one holder at a time; two staff tabs both auto-connect once armed, and the second one loses on every reload. | `sudo fuser -v /dev/ttyUSB1` → `chromium`. Close the other tab (or `rfidM0.stop()` in it) and reload. |
| Same error, but only one tab | Chrome's remembered port no longer matches the device — the tunnel re-enumerated it under a new node. | The remembered grant is stale; `dmesg -T \| grep vhci_hcd` shows `urb->status -104` around the time it died. Re-attach, then re-pick the port (below). |
| It worked, then stopped mid-session, pill goes `!` | The tunnel reset. The device node stays; the bytes do not come. | `dmesg -T \| tail` → `vhci_hcd: urb->status -104` (ECONNRESET). The watch gives up after 3 read failures on purpose. |
| `usbip list -r aimax.lan` says *no exportable devices found* | Either a device already attached to a client (it leaves the export list), or, after a re-plug, a device on aimax that is not bound for export. | `sudo /usr/sbin/usbip port` on nuc: `<Port in Use>` means attached. If nothing is attached anywhere and `lsusb -d 0403:6001` on aimax shows it, bind it (above). |
| `Failed to open serial port` with the tunnel healthy and one tab open | Chrome still holds the fd from a page that navigated away — `sudo fuser -v /dev/ttyUSB1` says `chromium` while the visible tab sits on `mainpage.pl`. | Close that window (or `rfidM0.stop()` in it) and reload the page you want. |

Recovery, in order, cheapest first: close the other tab → reload → `rfidM0.stop()`
then click the pill → detach and re-attach → re-pick the port.

## Re-picking the port

If the device re-enumerates, the grant this origin holds points at a device that no
longer exists, and only a click can fix it: the Web Serial chooser requires a user
gesture, so no script or test can drive it. Click the `RFID` pill in the corner (or
press Ctrl+Alt+R), pick *FTDI FT232*/the new `/dev/ttyUSBx`, and the grant updates.

`rfidM0` says which of these you are in:

```js
await rfidM0.inventory()      // sids on the pad, or throws
rfidM0.gate                   // 'ready' | 'error' | 'needs-grant' | 'unsupported' …
rfidM0.log.slice(-10)         // every frame and every decision, newest last
```

## Testing without the tunnel

`koha-rfid-go` has a mock (`./koha-rfid -mock -allow-origin https://…`) for the old
Go client; the JS bundle does not talk to it (see README, "Provenance"). What the
mock cannot do anyway is exercise the chooser or a re-enumeration — those need the
real device and a hand on the keyboard, which is the honest reason this file exists.
