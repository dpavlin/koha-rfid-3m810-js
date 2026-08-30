/*
 * RFID support for Koha
 *
 * Written by Dobrica Pavlinusic <dpavlin@rot13.org> under GPL v2 or later
 *
 * This provides example how to implement the HTTP API from
 *
 * koha-rfid-go (Go server)
 *
 * to provide overlay for tags in range and emulate form fill for Koha Library System
 * which allows check-in and checkout-operations without touching html interface
 *
 * This file is injected by the Koha plugin (Koha::Plugin::Rot13::RFID)
 * only on RFID-relevant pages (circulation, returns, renew, mainpage).
 *
 */

// Bump RFID_VERSION when localStorage format changes (e.g., new fields in AFI map).
// Old data will be invalidated on next page load automatically.
var RFID_VERSION = '2.2';  // version number for tracking; v2.2 = tag-leave detection (last_seen sweep)
var rfid_base_url = 'https://localhost:9000'; // override for mock-server testing
var rfid_timeout = null;
var rfid_poll_pending = false;
var rfid_no_reader = localStorage.getItem('rfid_no_reader') == 'true'; // user opted out

// Named constants (not magic numbers)
var RFID_SCAN_TIMEOUT = 15000;   // max wait for /scan/ response
var RFID_SCAN_RETRY_MS = 5000;   // delay before retrying scan after error
var RFID_POLL_INTERVAL_MS = 1000;// delay between polls after successful scan
var RFID_DEDUP_MS = 10000;       // time window for dedup (same book re-submit guard)

var rfid_spinner_idx = 0;  // spinner frame counter

var rfid_error_active = false;   // prevents recursive error/timeout popups

// Debug namespace — exposed on window for rodney inspection
window.rfidDebug = {};

// Expose key variables for rodney inspection
window.rfidDebug.afiMap = function() { return rfid_storage_get('rfid_afi', {}); };
window.rfidDebug.localStorage = function() { return JSON.parse(JSON.stringify(localStorage)); };

window.rfidDebug.pollPending = function() { return rfid_poll_pending; };
window.rfidDebug.timeout = function() { return rfid_timeout; };
window.rfidDebug.noReader = function() { return rfid_no_reader; };

function rfid_storage_get(key, def) {
	var v = localStorage.getItem(key);
	return v ? JSON.parse(v) : (def || {});
}
function rfid_storage_set(key, obj) {
	localStorage.setItem(key, JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// AFI map — per-barcode state in localStorage (single source of truth)
//
// Key: rfid_afi
// Value: { barcode: { sec: string, pending: string|null, submit: number|null, time: number, last_seen: number|null } }
//
//   sec       — last known AFI from tag (DA = checked in, D7 = on loan)
//   pending   — target AFI to write after a submit (null = no pending write)
//   submit    — timestamp of last submit (used for time-based dedup on returns)
//   time      — timestamp of last update (ms)
//   last_seen — timestamp when tag was last seen by reader (ms); null for legacy entries
// ---------------------------------------------------------------------------

// Get the AFI entry for a barcode, or null if not found
function rfid_afi_get(barcode) {
	var map = rfid_storage_get('rfid_afi', {});
	return map[barcode] || null;
}

// Set/update the AFI entry for a barcode
function rfid_afi_set(barcode, sec, pending) {
	var map = rfid_storage_get('rfid_afi', {});
	var now = Date.now();
	var e = map[barcode] || {};
	map[barcode] = { sec: sec, pending: pending || null, submit: e.submit || null, time: now, last_seen: e.last_seen || now };
	rfid_storage_set('rfid_afi', map);
}

// Update last_seen for a barcode (called when tag is visible in scan)
function rfid_afi_set_last_seen(barcode) {
	var map = rfid_storage_get('rfid_afi', {});
	if (map[barcode]) {
		map[barcode].last_seen = Date.now();
		rfid_storage_set('rfid_afi', map);
	}
}

// Sweep stale entries: delete AFI map entries where last_seen is >3 seconds old,
// except for entries that are still visible in the current scan (visibleBarcodes set).
// Also deletes legacy entries (no last_seen) if time is >3 seconds old.
function rfid_afi_sweep_stale(visibleBarcodes) {
	var map = rfid_storage_get('rfid_afi', {});
	var now = Date.now();
	var changed = false;
	var limit = 3000; // 3 seconds
	for (var key in map) {
		if (visibleBarcodes && visibleBarcodes.indexOf(key) >= 0) continue;
		var e = map[key];
		// Don't delete entries that were recently submitted — the tag may still
		// be on the reader during the dedup window (e.g., checkin form navigating
		// to returns.pl). Deleting it would cause a re-submit on next scan.
		if (e.submit && (now - e.submit) < RFID_DEDUP_MS) continue;
		var age = now - (e.last_seen || e.time || 0);
		if (age > limit) {
			delete map[key];
			changed = true;
		}
	}
	if (changed) rfid_storage_set('rfid_afi', map);
}

// Mark a barcode as just submitted (sets submit timestamp for dedup)
function rfid_afi_set_submit(barcode) {
	var map = rfid_storage_get('rfid_afi', {});
	if (map[barcode]) {
		map[barcode].submit = Date.now();
		rfid_storage_set('rfid_afi', map);
	}
}

function rfid_afi_clear_pending(barcode) {
	var map = rfid_storage_get('rfid_afi', {});
	if (map[barcode]) {
		map[barcode].pending = null;
		map[barcode].time = Date.now();
		rfid_storage_set('rfid_afi', map);
	}
}

// Remove entries older than 1 hour
function rfid_afi_cleanup() {
	var map = rfid_storage_get('rfid_afi', {});
	var now = Date.now();
	var changed = false;
	for (var key in map) {
		if (now - map[key].time > 3600000) { // 1 hour retention
			delete map[key];
			changed = true;
		}
	}
	if (changed) rfid_storage_set('rfid_afi', map);
}

// ---------------------------------------------------------------------------
// Spinner — ASCII progress indicator / | \ -
// ---------------------------------------------------------------------------

function rfid_spinner() {
	var chars = ['/', '|', '\\', '-'];
	rfid_spinner_idx = (rfid_spinner_idx + 1) % 4;
	return chars[rfid_spinner_idx];
}

function rfid_spinner_show() {
	var s = $('#rfid-spinner');
	if ( s.length ) s.text( rfid_spinner() );
}

function rfid_spinner_hide() {
	var s = $('#rfid-spinner');
	if ( s.length ) s.text('');
}

// ---------------------------------------------------------------------------
// AFI values from RFID server (always uppercase hex):
//   DA = secured (checked in), door ignores
//   D7 = unsecured (checked out), door beeps
// For checkout we need DA (item is in library), for checkin we need D7 (item was on loan)
function afi_label(sec) {
	var s = (sec || '').toUpperCase();
	return s == 'DA' ? 'checked in' : s == 'D7' ? 'on loan' : 'unknown';
}
function afi_color(sec) {
	var s = (sec || '').toUpperCase();
	return s == 'DA' ? 'red' : s == 'D7' ? 'green' : 'blue';
}

// ---------------------------------------------------------------------------
// RFID secure — write AFI to tag via RFID server
// ---------------------------------------------------------------------------

function rfid_secure(barcode, sid, target) {
	var body = new URLSearchParams();
	body.append(sid, target);
	rfid_fetch(rfid_base_url + '/secure', 15000, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-RFID-Client': 'koha-rfid' },
		body: body.toString()
	}).then(function(r) {
		if ( r.status == 200 ) {
			rfid_afi_clear_pending(barcode);
		}
	}).catch(function(e) {
		// write failed — pending stays set, next scan will retry
	});
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

function rfid_popup_update() {
	// If an error is active, don't overwrite the error message with AFI content
	if (rfid_error_active) return;
	var log = $('#rfid-afi-log');
	var map = rfid_storage_get('rfid_afi', {});
	var now = Date.now();
	var visible = [], gone = [];
	for (var key in map) {
		var e = map[key];
		var age = now - (e.last_seen || 0);
		if (e.last_seen && age < 2000) {
			visible.push({ key: key, e: e, last_seen: e.last_seen });
		} else {
			gone.push({ key: key, e: e, age: age });
		}
	}
	visible.sort(function(a, b) { return b.last_seen - a.last_seen; });
	var html = '';
	for (var vi = 0; vi < visible.length; vi++) {
		var v = visible[vi];
		html += '<div style="color:#fff">' + v.key + ' ' + v.e.sec +
			(v.e.pending ? ' &rarr; ' + v.e.pending : '') + '</div>';
	}
	for (var gi = 0; gi < gone.length; gi++) {
		var g = gone[gi];
		var secs = Math.round(g.age / 1000);
		var remaining = 3 - secs;
		if (remaining <= 0) continue;
		html += '<div style="color:#888">' + g.key + ' ' + g.e.sec +
			(g.e.pending ? ' &rarr; ' + g.e.pending : '') +
			' (' + remaining + 's)</div>';
	}
	if (html == '') html = '<span style="color:#888">(no tags)</span>';
	// Skip DOM update if content hasn't changed — avoids unnecessary reflows
	// and keeps the DOM stable for rodney queries.
	if ( log.length > 0 ) {
		var cur = log.html();
		if ( cur === html ) return;
		log.html(html);
	}
}

function rfid_create_popup() {
	var saved = localStorage.getItem('rfid_popup_pos');
	var pos = saved ? JSON.parse(saved) : { top: 10, right: 10 };
	var html =
		'<div id="rfid-popup" style="' +
			'position:fixed; z-index:9999;' +
			'top:' + pos.top + 'px; right:' + pos.right + 'px;' +
			'background:#333; color:#fff; padding:10px 14px;' +
			'border-radius:6px; font-size:13px; font-family:monospace;' +
			'cursor:move; box-shadow:2px 2px 8px rgba(0,0,0,0.4);' +
			'min-width:200px;' +
		'">' +
			'<div id="rfid-popup-header" style="font-weight:bold; margin-bottom:4px;">RFID v' + RFID_VERSION +
				' <span id="rfid-spinner" style="color:#888"></span></div>' +
			'<div id="rfid-popup-body">—</div>' +
			'<div id="rfid-afi-log" style="font-size:11px; line-height:1.4; max-height:200px; overflow-y:auto; border-top:1px solid #555; padding-top:4px; margin-top:4px"></div>' +
			'<div style="font-size:10px; margin-top:4px; opacity:0.6">' +
				'<button id="rfid-reset-btn" title="Clear all scanned tags (force re-scan)" style="cursor:pointer;background:#555;color:#fff;border:none;padding:1px 6px;border-radius:3px;font-size:11px">↻ reset</button>' +
			'</div>' +
		'</div>';

	$('body').append(html);

	var popup = $('#rfid-popup');
	var header = $('#rfid-popup-header');
	var drag = false, offsetX, offsetY;

	header.on('mousedown', function(e) {
		drag = true;
		var p = popup.position();
		offsetX = e.clientX - p.left;
		offsetY = e.clientY - p.top;
	});

	$(document).on('mouseup', function() {
		if (drag) {
			drag = false;
			var p = popup.position();
			var w = $(window).width();
			var h = $(window).height();
			var pw = popup.outerWidth();
			localStorage.setItem('rfid_popup_pos', JSON.stringify({
				top: Math.min(p.top, h - 60),
				right: Math.max(w - p.left - pw, 0)
			}));
		}
	});

	$(document).on('mousemove', function(e) {
		if (drag) {
			popup.css({ top: e.clientY - offsetY, left: e.clientX - offsetX });
		}
	});

	// Reset button — clear all AFI map entries so tags can be re-scanned
	$('#rfid-reset-btn').on('click', function() {
		localStorage.removeItem('rfid_afi');
		rfid_popup_update();
	});

	return $('#rfid-popup-body');
}

function rfid_show_error(msg, hint) {
	var body = $('#rfid-popup-body');
	if ( body.length == 0 ) body = rfid_create_popup();
	var link = ' — <a href="https://localhost:9000" target="_blank" style="color:orange;text-decoration:underline">open https://localhost:9000</a> in a new tab and accept self-signed certificate';
	var buttons = '';
	if (hint) {
		buttons =
			'<div style="margin-top:6px">' +
				'<button id="rfid-retry-btn" style="cursor:pointer;background:#555;color:#fff;border:none;padding:3px 8px;border-radius:3px;margin-right:4px">retry</button>' +
				'<button id="rfid-no-reader-btn" style="cursor:pointer;background:#555;color:#fff;border:none;padding:3px 8px;border-radius:3px">no reader</button>' +
			'</div>';
	}
	body.html(msg + (hint ? link : '') + buttons).css('color', 'orange');
	rfid_error_active = true;
	if (hint) {
		$('#rfid-retry-btn').on('click', function() {
			rfid_no_reader = false;
			localStorage.removeItem('rfid_no_reader');
			rfid_poll();
		});
		$('#rfid-no-reader-btn').on('click', function() {
			rfid_no_reader = true;
			localStorage.setItem('rfid_no_reader', 'true');
			body.html('RFID disabled — <a href="#" id="rfid-enable-btn" style="color:orange;text-decoration:underline">enable</a>').css('color', '#888');
			$('#rfid-enable-btn').on('click', function() {
				rfid_no_reader = false;
				localStorage.removeItem('rfid_no_reader');
				rfid_poll();
			});
		});
	}
	// Do NOT call rfid_popup_update() here — it would overwrite the error message
	// with AFI map content. The next poll cycle will update the popup.
}

function rfid_fetch(url, timeout_ms, options) {
	var controller = new AbortController();
	var timer = setTimeout(function() { controller.abort(); }, timeout_ms);
	options = options || {};
	options.signal = controller.signal;
	return fetch(url, options).then(function(r) {
		clearTimeout(timer);
		return r;
	}).catch(function(e) {
		clearTimeout(timer);
		throw e;
	});
}



function rfid_poll() {
	console.log('rfid_poll: pending=' + rfid_poll_pending + ' noReader=' + rfid_no_reader);
	if ( rfid_poll_pending ) return;
	if ( rfid_no_reader ) return;
	rfid_poll_pending = true;
	console.log('rfid_poll: poll_pending set to true');

	var body = $('#rfid-popup-body');
	if ( body.length == 0 ) body = rfid_create_popup();

	// Show spinner
	rfid_spinner_show();

	rfid_fetch(rfid_base_url + '/scan/', RFID_SCAN_TIMEOUT).then(function(r) {
		rfid_poll_pending = false;
		rfid_spinner_hide();
		if ( r.ok ) return r.json();
		throw new Error('HTTP ' + r.status);
	}).then(function(data) {
		rfid_poll_pending = false;
		rfid_spinner_hide();
		console.log('rfid_poll: scan response, pending=false, calling rfid_scan');
		rfid_scan(data);
	}).catch(function(e) {
		rfid_poll_pending = false;
		rfid_spinner_hide();
		var msg = 'RFID scan error: ' + e.message;
		if (e.message.indexOf('abort') >= 0 || e.message.indexOf('timeout') >= 0 || e.message.indexOf('504') >= 0) {
			msg = 'RFID scan error: timeout';
		}
		rfid_show_error(msg, true);
		rfid_timeout = window.setTimeout( rfid_poll, RFID_SCAN_RETRY_MS );
	});
}

// ---------------------------------------------------------------------------
// rfid_scan — the main RFID scan handler
//
// Order of operations (AFI map is the single source of truth):
//
// 1. PENDING AFI RESOLUTION:
//    If the AFI map has a pending target for this barcode and the tag AFI
//    doesn't match, write the pending AFI now and return.
//
// 2. STATE CHECK:
//    If the tag AFI matches the stored AFI in the map, no state change
//    occurred — skip submission.
//
// 3. NEW SUBMISSION:
//    Otherwise, submit the form and update the AFI map.
//    If the action changes the AFI (checkin/checkout), set pending target.
//
// ACROSS PAGE RELOADS:
//    The AFI map persists in localStorage. After page reload, the scan loop
//    will detect pending writes or unchanged AFIs and act accordingly.
// ---------------------------------------------------------------------------

function rfid_scan(data) {
	console.log('rfid_scan: called with ' + (data.tags ? data.tags.length + ' tags' : 'no tags') + ', pending=' + rfid_poll_pending);

	// Clear error flag on successful scan — error messages should only show
	// while the server is failing. Once we get a successful response, show tags.
	rfid_error_active = false;

	var body = $('#rfid-popup-body');
	if ( body.length == 0 ) body = rfid_create_popup();
	var now, shouldSubmit, pending;
	var url = document.location.toString();
	// SYNC: keep in sync with @rfid_pages in RFID.pm
	var circulation = url.indexOf('circulation.pl') >= 0 || url.indexOf('circulation-home.pl') >= 0;
	var circulation_home = url.indexOf('circulation-home.pl') >= 0;

	// Tab detection — different Koha pages use different tab ids.
	// On circulation-home.pl: checkout tab is #circ_search, renew tab is #renew_search.
	var checkin_active  = $('#checkin_search').attr('aria-hidden') == 'false';
	var renew_active    = $('#renew_search').attr('aria-hidden') == 'false';
	var checkout_active = $('#checkout_search').attr('aria-hidden') == 'false' ||
	$('#circ_search').attr('aria-hidden') == 'false' ||
	(circulation && !checkin_active && !renew_active);
	window.rfidDebugLogs = window.rfidDebugLogs || [];
	window.rfidDebugLogs.push('rfid_scan: diagnosis: ' + JSON.stringify({ url: url, circ: circulation, checkout: checkout_active, checkin: checkin_active, renew: renew_active }));
	console.log('rfid_scan: diagnosis:', { url: url, circ: circulation, checkout: checkout_active, checkin: checkin_active, renew: renew_active });

	if ( data.tags && data.tags.length > 0 ) {
		// Update last_seen for all visible tags — sweep will clear stale ones
		var visibleBarcodes = [];
		for (var vi = 0; vi < data.tags.length; vi++) {
			var bc = data.tags[vi].content;
			visibleBarcodes.push(bc);
			rfid_afi_set_last_seen(bc);
		}

		if ( data.tags.length === 1 ) {
			var t = data.tags[0];

			var returns = url.indexOf('returns.pl') >= 0;
			var renew = url.indexOf('renew.pl') >= 0;

			if ( t.content.length == 0 ) { // empty tag

				body.text( t.sid + ' empty' ).css('color', 'red' );

			} else if ( t.content.substr(0,3) == '130' ) { // books

				var sec = (t.security || '').toUpperCase();
				var label = afi_label(sec);
				var color = afi_color(sec);

				// -----------------------------------------------------------
				// Step 1: resolve any pending AFI write from a previous page load
				// -----------------------------------------------------------
				var entry = rfid_afi_get(t.content);
				if ( entry && entry.pending ) {
					if ( entry.pending != sec ) {
						// Tag still has the old AFI — perform the write now
						body.text( t.content + ' (writing ' + entry.pending + '...)' ).css('color', '#888');
						rfid_secure( t.content, t.sid, entry.pending );
						rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
						return;
					} else {
						// The write already happened — clear pending and update stored sec
						rfid_afi_set(t.content, sec, null);
						rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
						return;
					}
				}

				// -----------------------------------------------------------
				// Step 2: skip if AFI hasn't changed since last submission
				// (returns page has its own time-based dedup — see Step 4)
				// -----------------------------------------------------------
				if ( entry && entry.sec == sec && !returns && !renew && !checkin_active && !renew_active ) {
					rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
					return;
				}

				body.text( t.content + ' (' + label + ')' ).css('color', color);

				// -----------------------------------------------------------
				// Step 3: Renew page — #ren_barcode form, no AFI write
				// -----------------------------------------------------------
				if ( renew ) {
					if ( sec == 'D7' ) {
						var i = $('#barcode');
						if ( i.is(':visible') && i.val() != t.content ) {
							i.val( t.content );
							rfid_afi_set(t.content, sec, null); // no AFI change needed
							i.closest('form').submit();
						}
					} else {
						body.text( t.content + ' (not on loan — cannot renew)' ).css('color', 'blue');
						rfid_afi_set(t.content, sec, null);
					}
					rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
					return;
				}

				// -----------------------------------------------------------
				// Step 4: Checkin (returns.pl)
				//
				// Workflow: library staff processes ALL returned books on this page
				// regardless of AFI state. Koha updates the date-last-seen for every
				// book placed on the reader — this is essential for shelf management.
				//
				// Both DA (checked in) and D7 (on loan) books are submitted:
				//   - D7 → Koha performs a real check-in (state change)
				//   - DA → Koha shows "already checked in" but still updates date-last-seen
				//
				// Dedup: each book is submitted only once per 10-second window.
				// The submit timestamp is persisted in localStorage so it survives
				// page reloads. If the same book is placed again after 10s, it will
				// re-submit — which is fine (date-last-seen refresh).
				//
				// The pending AFI write (D7→DA) is set only for books that were
				// on loan (D7), so the tag gets updated after a real check-in.
				// -----------------------------------------------------------
				if ( returns ) {
					// Time-based dedup: skip if last submit was within 10 seconds
					now = Date.now();
					shouldSubmit = !entry || !entry.submit || (now - entry.submit > RFID_DEDUP_MS);
					if ( shouldSubmit ) {
						var barcodeInput = $('#barcode');
						if ( barcodeInput.is(':visible') && barcodeInput.val() != t.content ) {
							barcodeInput.val( t.content );
							// Set pending only if book was on loan (D7 → need to write DA)
							pending = (sec == 'D7') ? 'DA' : null;
							rfid_afi_set(t.content, sec, pending);
							rfid_afi_set_submit(t.content);
							barcodeInput.closest('form').submit();
						}
					} else {
						body.text( t.content + ' (already submitted)' ).css('color', 'blue');
						rfid_afi_set(t.content, sec, null);
					}
					rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
					return;
				}

				// -----------------------------------------------------------
				// Step 5: Circulation (checkout/checkin tabs)
				//
				// circulation.pl       — #mainform with #barcode for checkout
				// circulation-home.pl  — tabbed: checkin (#ret_barcode) or checkout (patron search)
				// -----------------------------------------------------------
				if ( circulation || circulation_home ) {
					// Both circulation.pl and circulation-home.pl share the same search tabs
					if ( checkin_active ) {
						// Checkin tab → returns form (#ret_barcode), same logic as Step 4
						now = Date.now();
						shouldSubmit = !entry || !entry.submit || (now - entry.submit > RFID_DEDUP_MS);
						if ( shouldSubmit ) {
							var retInput = $('#ret_barcode');
							if ( retInput.is(':visible') && retInput.val() != t.content ) {
								retInput.val( t.content );
								pending = (sec == 'D7') ? 'DA' : null;
								rfid_afi_set(t.content, sec, pending);
								rfid_afi_set_submit(t.content);
								retInput.closest('form').submit();
							}
						} else {
							body.text( t.content + ' (already submitted)' ).css('color', 'blue');
						}
					} else if ( renew_active && sec == 'D7' ) {
						// Renew tab — #ren_barcode, same logic as Step 3
						var renInput = $('#ren_barcode');
						if ( renInput.is(':visible') && renInput.val() != t.content ) {
							renInput.val( t.content );
							rfid_afi_set(t.content, sec, null);
							renInput.closest('form').submit();
						}
					} else if ( checkout_active && sec == 'DA' ) {
						// Checkout tab — use #barcode if visible (after patron selection)
						var checkoutInput = $('#barcode');
						if ( checkoutInput.length > 0 && checkoutInput.is(':visible') && checkoutInput.val() != t.content ) {
							checkoutInput.val( t.content );
							rfid_afi_set(t.content, sec, 'D7');
							checkoutInput.closest('form').submit();
						} else {
							body.text( t.content + ' (' + label + ')' ).css('color', color);
						}
					} else {
						window.rfidDebugLogs = window.rfidDebugLogs || [];
						window.rfidDebugLogs.push('rfid_scan: Step 5 fallback. checkout_active: ' + checkout_active + ' sec: ' + sec);
						console.log('rfid_scan: Step 5 fallback. checkout_active:', checkout_active, 'sec:', sec);
						if ( checkout_active && sec != 'DA' ) {
							window.rfidDebugLogs.push('rfid_scan: Step 5 warning shown');
							console.log('rfid_scan: Step 5 warning shown');
							body.text( t.content + ' (not checked in — cannot checkout)' ).css('color', 'blue');
							rfid_afi_set(t.content, sec, null);
						} else {
							window.rfidDebugLogs.push('rfid_scan: Step 5 fallback label shown');
							console.log('rfid_scan: Step 5 fallback label shown');
							body.text( t.content + ' (' + label + ')' ).css('color', color);
						}
					}
					rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
					return;
				}

				// -----------------------------------------------------------
				// Fallback: not on a known Koha page — show info
				// -----------------------------------------------------------
				window.rfidDebugLogs = window.rfidDebugLogs || [];
				window.rfidDebugLogs.push('rfid_scan: Step 6 fallback shown');
				console.log('rfid_scan: Step 6 fallback shown');
				body.text( t.content + ' (' + label + ')' ).css('color', color);
				rfid_afi_set(t.content, sec, null);

			} else {
				// Non-book barcode (patron card) — allow resubmission after dedup window
				body.text( t.content ).css('color', 'blue' );
				var patronEntry = rfid_afi_get(t.content);
				now = Date.now();
				var canResubmit = !patronEntry || (patronEntry.sec == 'patron' && now - (patronEntry.submit || 0) > RFID_DEDUP_MS) || patronEntry.sec != 'patron';
				if ( canResubmit ) {
					var pb = $('input[name=findborrower]');
					if ( pb.is(':visible') ) {
						// Record the submission only when it actually happened —
						// otherwise dedup would block retries for 10 seconds on
						// pages that have no borrower-search form.
						rfid_afi_set(t.content, 'patron', null);
						rfid_afi_set_submit(t.content);
						var el = pb[0]; el.value = t.content; el.closest('form').submit();
					} else {
						body.text( t.content + ' (no borrower search form)' ).css('color', 'blue' );
					}
				}
			}

		} else {
			// Multiple tags — iterate and process the first unprocessed book
			var is_checkout_tab = checkout_active || (!checkin_active && (circulation || circulation_home));
			var is_patron_loaded = $('#circ_circulation_issue').length > 0;
			if ( is_checkout_tab && !is_patron_loaded ) {
				for ( var pi = 0; pi < data.tags.length; pi++ ) {
					var tp = data.tags[pi];
					if ( tp.content.length > 0 && tp.content.substr(0,3) != '130' ) {
						// Process this patron card first
						data.tags = [ tp ];
						rfid_scan(data);
						return;
					}
				}
			}

			for ( var ti = 0; ti < data.tags.length; ti++ ) {
				var t2 = data.tags[ti];
				if ( t2.content.length == 0 ) continue;
				if ( t2.content.substr(0,3) == '130' ) {
					var entry2 = rfid_afi_get(t2.content);
					var sec2 = (t2.security || '').toUpperCase();
					if ( !entry2 || entry2.sec != sec2 || entry2.pending ) {
						// Process this single book; remaining tags will be picked up on next poll
						data.tags = [ t2 ];
						rfid_scan(data);
						return;
					}
				}
			}
			// All tags already processed — just show count
			var error = data.tags.length + ' tags (all processed)';
			$.each( data.tags, function(i,tag) { error += ' ' + tag.content; } );
			body.text( error ).css( 'color', '#888' );
		}

	} else {
		body.text( 'no tags in range' ).css('color','gray');
	}

	// Sweep stale entries — tags that left the reader >3 seconds ago are cleared
	// so they can be re-scanned immediately when placed again.
	rfid_afi_sweep_stale(visibleBarcodes || []);
	console.log('rfid_scan: calling rfid_popup_update');
	rfid_popup_update();
	console.log('rfid_scan: scheduling next poll in 1s, pending=' + rfid_poll_pending);
	rfid_timeout = window.setTimeout( rfid_poll, RFID_POLL_INTERVAL_MS );
	console.log('rfid_scan: done');
}

$(document).ready( function() {
	// Check storage version — invalidate AFI map if code format changed
	var storedVer = localStorage.getItem('rfid_storage_version');
	if ( storedVer != RFID_VERSION ) {
		localStorage.removeItem('rfid_afi');
		localStorage.setItem('rfid_storage_version', RFID_VERSION);
	}
	rfid_afi_cleanup();
	// Remove old event log key (migrated to AFI map in v2.0)
	localStorage.removeItem('rfid_events');
	rfid_timeout = null;
	rfid_poll_pending = false;
	rfid_poll();
});
