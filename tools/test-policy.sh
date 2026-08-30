#!/usr/bin/env bash
#
# Unit test the gate policy on the server, where Koha's libraries exist.
#
# The subs under test are pure — page matching, enrollment, superlibrarian — but
# they live in a module whose base class only exists on a Koha host. So this runs
# the tests remotely against the *source in this repo*, not against what is
# deployed: it catches a broken gate before deploy does, and pins the bitfield
# rule that took the plugin out live once already.
#
# Usage: ./tools/test-policy.sh [host]
set -euo pipefail

HOST="${1:-koha-dev.rot13.org}"
INSTANCE="${INSTANCE:-ffzg}"
cd "$(dirname "$0")/.."

STAGE=$(ssh "$HOST" "mktemp -d")
trap 'ssh "$HOST" "sudo rm -rf $STAGE" || true' EXIT
ssh "$HOST" "sudo mkdir -p '$STAGE/Koha/Plugin/Rot13' && sudo chmod 755 '$STAGE' '$STAGE/Koha' '$STAGE/Koha/Plugin' '$STAGE/Koha/Plugin/Rot13'"
ssh "$HOST" "sudo tee '$STAGE/Koha/Plugin/Rot13/RFID.pm' >/dev/null && sudo chmod 644 '$STAGE/Koha/Plugin/Rot13/RFID.pm'" < plugin/Koha/Plugin/Rot13/RFID.pm

echo "=== policy tests (module from repo, run on $HOST) ==="
set +e
# KOHA_CONF picks the instance: without it C4::Context falls back to whatever
# koha-conf.xml the box defaults to and the database connection fails.
ssh -T "$HOST" "sudo -u ${KOHA_USER_OS:-ffzg-koha} KOHA_CONF=/etc/koha/sites/$INSTANCE/koha-conf.xml PERL5LIB=/usr/share/koha/lib:$STAGE perl -" < tools/policy-tests.pl
rc=$?
set -e
exit "$rc"
