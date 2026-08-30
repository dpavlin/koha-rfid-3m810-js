#!/usr/bin/env bash
# rollback.sh — restore the most recent plugins/Rot13 backup taken by deploy.sh.
#
# A bad RFID.pm takes down every staff page (the hook runs on all of them), so
# this has to be a two-second operation, not a forensic exercise.
#
#   ./tools/rollback.sh            # newest backup
#   ./tools/rollback.sh 20260830-1730
set -euo pipefail

HOST="${HOST:-koha-dev.rot13.org}"
INSTANCE="${INSTANCE:-ffzg}"
PLUGDIR="/var/lib/koha/${INSTANCE}/plugins/Koha/Plugin/Rot13"
BACKUPS="/var/lib/koha/${INSTANCE}/plugins-backup/rot13-rfid"
KOHA_USER_OS="${INSTANCE}-koha"
STAMP="${1:-}"

if [ -z "$STAMP" ]; then
	STAMP=$(ssh "$HOST" "ls -1dt $BACKUPS/*/ 2>/dev/null | head -1" | sed 's:/*$::; s:.*/::')
fi
[ -n "$STAMP" ] || { echo "FAIL: no backups under $BACKUPS on $HOST"; exit 1; }
SRC="$BACKUPS/$STAMP"

echo "=== restoring $SRC ==="
ssh "$HOST" "
	set -e
	test -d '$SRC'
	sudo cp -a '$SRC/.' '$PLUGDIR/'
	sudo chown -R $KOHA_USER_OS:$KOHA_USER_OS '$PLUGDIR'
	sudo koha-plack --restart '$INSTANCE' 
	echo restored from $STAMP
"
echo "Check: ssh $HOST \"sudo grep 'RFID:' /var/log/koha/$INSTANCE/plack-error.log | tail\""
