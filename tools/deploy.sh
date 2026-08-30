#!/usr/bin/env bash
# deploy.sh — put the plugin on the Koha server, with a rollback path.
#
# ffzg discovers plugins by filesystem scan (Module::Pluggable over pluginsdir),
# and has no `plugins` table, so there is no install UI: copy files, chown,
# restart plack. That is also why every deploy here takes a timestamped backup
# first — a bad .pm would break every staff page, not just ours.
#
#   ./tools/deploy.sh                 HOST=koha-dev.rot13.org INSTANCE=ffzg
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${HOST:-koha-dev.rot13.org}"
INSTANCE="${INSTANCE:-ffzg}"
# Koha turns the class name into a path: Koha/Plugin/Rot13/RFID.pm, with the
# plugin's own files in the RFID/ directory next to it (that is what
# get_plugin_dir/pluginsdir resolve to). Deploying flat broke both lookups.
PLUGDIR="/var/lib/koha/${INSTANCE}/plugins/Koha/Plugin/Rot13"
PLUGPM="${PLUGDIR}/RFID.pm"
ASSETS="${PLUGDIR}/RFID"
BACKUPS="/var/lib/koha/${INSTANCE}/plugins-backup/rot13-rfid"
KOHA_USER_OS="${INSTANCE}-koha"
LOCAL_PLUGIN="plugin/Koha/Plugin/Rot13/RFID.pm"
LOCAL_DIR="plugin/Koha/Plugin/Rot13/RFID"
BUNDLE="$LOCAL_DIR/koha-rfid.bundle.js"

[ -f "$BUNDLE" ] || { echo "FAIL: $BUNDLE missing — run 'make bundle' first"; exit 1; }

echo "=== 1/5 tests (hardware-free) ==="
make -s test

echo "=== 2/5 backup on $HOST ==="
STAMP=$(date +%Y%m%d-%H%M%S)
ssh "$HOST" "sudo mkdir -p '$BACKUPS' && sudo cp -a '$PLUGDIR' '$BACKUPS/$STAMP' && ls -1dt '$BACKUPS'/*/ | tail -n +11 | xargs -r sudo rm -rf && echo backed up to $BACKUPS/$STAMP"

echo "=== 3/5 upload to staging ==="
STAGE="/tmp/rfid-deploy.$$"
ssh "$HOST" "mkdir -p $STAGE"
scp -q "$LOCAL_PLUGIN" "$HOST:$STAGE/RFID.pm"
scp -q "$LOCAL_DIR/koha-rfid.json" "$HOST:$STAGE/koha-rfid.json"
scp -q "$BUNDLE" "$HOST:$STAGE/koha-rfid.bundle.js"
# The old Go-server script ships alongside the bundle while "legacy": true in
# koha-rfid.json; SKIP_LEGACY=1 leaves the server copy alone.
if [ "${SKIP_LEGACY:-}" != "1" ] && [ -f "$LOCAL_DIR/koha-rfid.js" ]; then
	scp -q "$LOCAL_DIR/koha-rfid.js" "$HOST:$STAGE/koha-rfid.js"
fi

echo "=== 4/5 perl syntax check on the server (plack NOT restarted yet) ==="
if ! ssh "$HOST" "sudo -u $KOHA_USER_OS perl -I/srv/koha_$INSTANCE -c $STAGE/RFID.pm"; then
	echo "FAIL: RFID.pm does not compile on the server — nothing was changed"
	ssh "$HOST" "rm -rf $STAGE"
	exit 1
fi

echo "=== 5/5 install + restart plack ==="
ssh "$HOST" "
	set -e
	sudo mkdir -p '$ASSETS'
	sudo cp '$STAGE/RFID.pm' '$PLUGPM'
	sudo cp '$STAGE/koha-rfid.json' '$ASSETS/koha-rfid.json'
	sudo cp '$STAGE/koha-rfid.bundle.js' '$ASSETS/koha-rfid.bundle.js'
	if [ -f '$STAGE/koha-rfid.js' ]; then sudo cp '$STAGE/koha-rfid.js' '$ASSETS/koha-rfid.js'; fi
	sudo chown -R $KOHA_USER_OS:$KOHA_USER_OS '$PLUGDIR'
	sudo rm -rf '$STAGE'
	# systemctl restart koha-plack is a no-op on this box (LSB unit reports
	# exited); the instance wrapper is what actually recycles the starman master.
	sudo koha-plack --restart '$INSTANCE'
	echo deployed
"

echo
echo "Verify (one page load as staff, then):"
echo "  ssh $HOST \"sudo grep 'RFID:' /var/log/koha/$INSTANCE/plack-error.log | tail\""
echo "Rollback: ./tools/rollback.sh"
