#!/usr/bin/env bash
# Bring the test reader back over USB/IP after a re-plug, a reboot, or a dead tunnel.
#
# Workstations plug the 3M 810 in directly; this is only for the dev rig where the
# reader hangs off another machine (see docs/usbip-reader.md for the topology and the
# symptom table). Run it on the machine that runs Chrome — not on the Koha server.
#
# Why a script and not a paragraph in the docs: every physical re-plug leaves the
# device *unbound* on the host, and `usbip attach` then fails with "Device not found",
# which reads like the reader is dead. Bind, then attach, in that order.
set -uo pipefail

HOST=${READER_HOST:-aimax.lan}
BUSID=${READER_BUSID:-3-2}
USBIP=${USBIP:-/usr/sbin/usbip}
NODE=/dev/serial/by-id/usb-FTDI_USB__-__Serial-if00-port0

# Already imported? Then the node should exist; do not attach a second time.
if sudo "$USBIP" port 2>/dev/null | grep -q "usbip://$HOST:3240/$BUSID"; then
	echo "already attached as $BUSID"
else
	# The host must export it. A re-plug unbinds it; usbipd itself keeps running.
	ssh "$HOST" "sudo /usr/sbin/usbip bind -b $BUSID" || {
		echo "could not bind $BUSID on $HOST — is the reader plugged in there?"
		echo "  ssh $HOST 'lsusb -d 0403:6001'   # present but unbound looks like this"
		exit 1
	}
	sudo "$USBIP" attach -r "$HOST" -b "$BUSID" || { echo "attach failed"; exit 1; }
	sleep 2
fi

if [ -e "$NODE" ]; then
	echo "reader is at $(readlink "$NODE") → $(readlink -f "$NODE")"
else
	echo "attached, but no $NODE yet — check dmesg for ftdi_sio"
	exit 1
fi

# Chrome's grant follows the device, not this script: if it re-enumerated under a new
# node, the pill will say RFID ! and only a click can re-pick it (docs/usbip-reader.md).
holder=$(sudo fuser "$NODE" 2>/dev/null || true)
[ -n "$holder" ] && echo "held by:$holder"
echo "now: load returns.pl and look for gate 'ready' — rfidM0.gate in devtools"
