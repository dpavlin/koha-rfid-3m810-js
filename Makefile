# koha-rfid-3m810-js — 3M 810 RFID from the browser, no local server
#
#   make bundle      — esbuild → plugin/Koha/Plugin/Rot13/RFID/koha-rfid.js
#   make test        — hardware-free tests (node --test, live capture replay)
#   make test-policy — gate tests, run on the server against this repo's RFID.pm
#   make check       — bundle + test + test-policy
#   make deploy      — backup on server, deploy plugin + bundle, restart plack
#   make rollback    — restore the newest backup on the server
#   make log         — tail the RFID decisions from the Koha error log
#   make reader      — dev rig only: re-bind + re-attach the reader over USB/IP
#   make clean       — remove build artifacts

NODE ?= node
HOST ?= koha-dev.rot13.org
INSTANCE ?= ffzg
BUNDLE := plugin/Koha/Plugin/Rot13/RFID/koha-rfid.js
SRCS   := $(shell find src build package.json -type f 2>/dev/null)

.PHONY: bundle test test-policy check deploy rollback log reader clean help

help:
	@sed -n '3,11p' Makefile | sed 's/^# \{0,1\}//'

bundle: $(BUNDLE)

$(BUNDLE): $(SRCS)
	$(NODE) build/bundle.mjs

test:
	$(NODE) --test tests/*.test.mjs

# The gate policy lives in Perl and needs Koha's libraries, so it runs on the
# server against the module in this working tree. It is not part of `test`, which
# stays offline; deploy depends on it, which is where it earns its keep.
test-policy:
	INSTANCE=$(INSTANCE) ./tools/test-policy.sh $(HOST)

check: bundle test test-policy

deploy: check
	HOST=$(HOST) INSTANCE=$(INSTANCE) ./tools/deploy.sh

rollback:
	HOST=$(HOST) INSTANCE=$(INSTANCE) ./tools/rollback.sh

log:
	ssh $(HOST) "sudo tail -n 40 /var/log/koha/$(INSTANCE)/plack-error.log 2>/dev/null | grep RFID || sudo grep -rh 'RFID:' /var/log/koha/$(INSTANCE)/intranet-error.log | tail -20"

# what the plugin decides, as it decides it (plack logs to files here, not journald)
live-log:
	ssh $(HOST) "sudo tail -f /var/log/koha/$(INSTANCE)/plack-error.log | grep --line-buffered 'RFID'"

# The test reader hangs off another machine; a physical re-plug leaves it unbound on the
# host and Chrome then says "Failed to open serial port". Workstations plug it in
# directly — this target is for the dev rig only (docs/usbip-reader.md).
reader:
	./tools/reader-up.sh

clean:
	rm -f $(BUNDLE) $(BUNDLE).rejected
