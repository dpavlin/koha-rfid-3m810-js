#!/usr/bin/env bash
# Re-establish the test reader over USB/IP, whatever state the two machines are in.
#
# Workstations plug the 3M 810 in directly; this rig exists so the reader can be tested
# from a desk it is not on (topology and symptom table: docs/usbip-reader.md).
#
# It walks the list of things that have actually broken, cheapest first, because every one
# of them surfaces as "the RFID reader is broken":
#
#   1. reader not plugged in / wrong socket on the host   → say so, show the busids
#   2. host rebooted: usbip-core/usbip-host not loaded     → modprobe (this is what a
#      reboot leaves behind; `usbip bind` fails with "unable to bind device")
#   3. host rebooted: nothing serving :3240               → start usbipd -D
#      There is no unit for it, on purpose: a reader that answers with nobody having
#      asked is not what anyone wants on a machine that also gets used as a desktop.
#   4. re-plug or reboot unbound the device               → usbip bind (not persisted;
#      no udev rule either, deliberately — the tunnel is meant to be a deliberate act)
#   5. client rebooted: vhci_hcd not loaded                → modprobe
#   6. an import whose device died (node missing)          → detach it, then attach fresh
#
# The busid is the physical socket, so it is read from sysfs rather than trusted;
# READER_BUSID=... overrides when a machine has two FT232s.
#
# Chrome still has to agree: if the device re-enumerated, the origin's grant points at a
# device that no longer exists and only a click on the pill can re-pick it — the Web Serial
# chooser needs a user gesture, which is why no script here can finish the job.
set -uo pipefail

HOST=${READER_HOST:-aimax.lan}
# "-" rather than empty: ssh joins its command arguments with spaces, so an empty one
# would vanish and the remote script would read $3 out of a two-argument list.
BUSID=${READER_BUSID:--}
USBIP=${USBIP:-/usr/sbin/usbip}
VID=0403
PID=6001
NODE=${READER_NODE:-/dev/serial/by-id/usb-FTDI_USB__-__Serial-if00-port0}
say() { printf '%s\n' "$*"; }
die() { printf 'reader-up: %s\n' "$*" >&2; exit 1; }

ssh "$HOST" true >/dev/null 2>&1 || die "cannot ssh $HOST"

# ---- host side: present → modules → daemon → bound ----
# One ssh, one heredoc: the checks share state (the busid found in sysfs is needed by
# bind), and running them separately is how you end up binding a stale busid.
# Args go through `sh -s --` rather than the environment: ssh does not forward arbitrary
# variables, and a quoted heredoc that references $VID is a remote "unbound variable".
HOST_STATE=$(
	ssh -T "$HOST" sh -s -- "$BUSID" "$VID" "$PID" <<'REMOTE'
		set -u
		want=$1; vid=$2; pid=$3
		# 1. is it there, and on which socket ("-" means "find it yourself")
		if [ "$want" != "-" ]; then
			busid=$want
		else
			found=""
			for d in /sys/bus/usb/devices/*-*; do
				[ -f "$d/idVendor" ] || continue
				[ "$(cat "$d/idVendor")" = "$vid" ] && [ "$(cat "$d/idProduct")" = "$pid" ] || continue
				found="$found $(basename "$d")"
			done
			set -- $found
			if [ $# -eq 0 ]; then
				echo "ERR no $vid:$pid device on $(hostname) — is the reader plugged in? (lsusb -d $vid:$pid)"
				exit 1
			fi
			if [ $# -gt 1 ]; then
				echo "ERR several candidates:$found — rerun with READER_BUSID=<busid>"
				exit 1
			fi
			busid=${1#/}
		fi

		# 2. modules: a reboot does not load these, and `usbip bind` then reports a bind
		#    failure ("unable to bind device") instead of "module missing", which sends you
		#    looking at the cable
		sudo modprobe usbip-core 2>/dev/null || true
		sudo modprobe usbip-host 2>/dev/null || true
		grep -q "^usbip_host " /proc/modules || { echo "ERR usbip-host would not load on $(hostname)"; exit 1; }

		# 3. daemon
		if ! ss -ltn | grep -q :3240; then
			sudo /usr/sbin/usbipd -D || { echo "ERR usbipd would not start on $(hostname)"; exit 1; }
			i=0
			until ss -ltn | grep -q :3240; do
				i=$((i + 1)); [ $i -gt 10 ] && { echo "ERR usbipd started but :3240 never listened"; exit 1; }
				sleep 1
			done
			echo "daemon started on $(hostname)"
		fi

		# 4. export it: the device is bound to usbip-host, and nothing else. Already bound
		#    is not an error, so bind is only a step and never the test.
		if ! ls /sys/bus/usb/drivers/usbip-host/ 2>/dev/null | grep -qx "$busid"; then
			sudo /usr/sbin/usbip bind -b "$busid" >/dev/null 2>&1 || true
		fi
		ls /sys/bus/usb/drivers/usbip-host/ 2>/dev/null | grep -qx "$busid" || {
			echo "ERR would not bind $busid on $(hostname) (driver now: $(readlink -f /sys/bus/usb/devices/$busid/driver 2>/dev/null | xargs basename 2>/dev/null))"
			exit 1
		}
		echo "OK $busid"
REMOTE
) || die "${HOST_STATE#ERR }"

echo "$HOST_STATE" | grep -v '^OK ' | grep -v '^$' || true
BUSID=${HOST_STATE##*OK }
[ -n "$BUSID" ] || die "no busid came back from $HOST"

# ---- client side: modules, stale import, attach ----
say "here ($(hostname)): usbip-core $(grep -q '^usbip_core ' /proc/modules && echo loaded || echo missing), vhci_hcd $(grep -q '^vhci_hcd ' /proc/modules && echo loaded || echo missing)"
if ! grep -q "^vhci_hcd " /proc/modules; then
	sudo modprobe vhci_hcd || die "vhci_hcd would not load here"
	say "loaded vhci_hcd"
fi

# `usbip port` prints the url on its own line, two below the `Port NN:` header, so the
# port number is taken from the line before the match rather than from the match.
PORTS=$(sudo "$USBIP" port 2>/dev/null || true)
if printf '%s' "$PORTS" | grep -q "usbip://$HOST:3240/"; then
	if [ -e "$NODE" ]; then
		say "already attached: $(printf '%s' "$PORTS" | grep -A2 "Port .* <Port in Use>" | grep "usbip://" | head -1 | sed 's/^ *//')"
		say "reader is at $(readlink "$NODE") → $(readlink -f "$NODE")"
		exit 0
	fi
	# an import whose device is gone keeps holding the slot; attach refuses it as busy
	port=$(printf '%s' "$PORTS" | grep -B2 "usbip://$HOST" | grep -oE 'Port +[0-9]+' | grep -oE '[0-9]+' | head -1)
	say "dropping the stale import on port $port (attached, but $NODE is gone)"
	sudo "$USBIP" detach -p "$port" || true
	sleep 1
fi

sudo "$USBIP" attach -r "$HOST" -b "$BUSID" || die "attach failed for $BUSID on $HOST (usbip list -r $HOST shows: $(sudo "$USBIP" list -r "$HOST" 2>&1 | tail -2 | tr "\n" " "))"
sleep 2

[ -e "$NODE" ] || die "attached but no $NODE — dmesg | grep ftdi_sio (nothing on the bus is a host-side problem)"
say "reader is at $(readlink "$NODE") → $(readlink -f "$NODE")"

holder=$(sudo fuser "$NODE" 2>/dev/null | tr -s " " || true)
[ -n "$holder" ] && say "held by PID(s):$holder  (sudo fuser -v $NODE) — Web Serial gives one holder at a time"
say "next: load returns.pl. gate 'ready' means done; gate 'needs-grant' or"
say "Failed to open serial port means Chrome forgot this device — click the RFID pill"
say "(or Ctrl+Alt+R) and pick the FT232 again. rfidM0.gate in devtools."
