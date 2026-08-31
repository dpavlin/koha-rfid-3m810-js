package Koha::Plugin::Rot13::RFID;

# Copyright (C) 2026 Dobrica Pavlinusic <dpavlin@rot13.org>
#
# This program is free software; you can redistribute it and/or modify it under
# the terms of the GNU General Public License as published by the Free Software
# Foundation; either version 2 of the License, or (at your option) any later
# version. See LICENSE in the repository root.

use Modern::Perl;

## Required for all plugins
use base qw(Koha::Plugins::Base);

use C4::Context;
use File::Slurp qw(read_file);
use JSON::XS qw(decode_json encode_json);
use utf8;

## Plugin version
our $VERSION = "0.1.0";

## Metadata
our $metadata = {
    name            => 'RFID Integration (Web Serial)',
    author          => 'Dobrica Pavlinusic',
    date_authored   => '2026-07-06',
    date_updated    => '2026-08-31',
    minimum_version => undef,
    maximum_version => undef,
    version         => $VERSION,
    description     => 'Drive a 3M 810 RFID reader straight from the browser over Web Serial. No local server. Injected only on RFID pages and only for enrolled libraries/users; dormant unless a reader was connected.',
    namespace       => 'rfid',
};

## Defaults used when the config file is missing or unreadable.
## There is deliberately no way to make this plugin talk to the old localhost Go
## server: this plugin is the Web Serial path, and the Go path stays in
## koha-rfid-go (as its own plugin — same class name, so the two cannot coexist).
my %DEFAULT_CONFIG = (
    pages       => [
        'circ/returns.pl', 'circ/circulation.pl', 'circ/circulation-home.pl',
        'circ/renew.pl', 'catalogue/moredetail.pl', 'mainpage.pl',
    ],
    branches    => [],          # empty = every branch
    users       => [],          # empty = every user (staff pages are gated anyway)
    hint        => JSON::XS::true(),
    bookPrefix  => '130',
    debug       => JSON::XS::false(),
);

sub new {
    my ( $class, $args ) = @_;

    $args->{'metadata'}          = $metadata;
    $args->{'metadata'}->{'class'} = $class;

    my $self = $class->SUPER::new($args);

    return $self;
}

## plugins/<class path as directories>/ — the same thing get_plugin_dir returns.
## Note the double slash pluginsdir may end in; File::Slurp will not forgive it.
sub _dir {
    my $base = C4::Context->config('pluginsdir') || '';
    $base =~ s{/+$}{};
    return "$base/Koha/Plugin/Rot13/RFID/";
}

## Cached file reader: stat + read only when the file actually changed.
## Returns ( $content, $error ).
my %CACHE;
sub _cached_file {
    my ($path) = @_;

    my @stat = stat($path);
    return ( undef, "missing $path" ) unless @stat;
    return ( $CACHE{$path}->{content}, undef )
      if $CACHE{$path} && $CACHE{$path}->{mtime} == $stat[9];

    my $content = eval { read_file( $path, binmode => ':raw' ) };
    return ( undef, "unreadable $path: $@" ) if $@ || !defined $content;

    $CACHE{$path} = { mtime => $stat[9], content => $content };
    return ( $content, undef );
}

sub _config {
    my ($json, $err) = _cached_file( _dir() . 'koha-rfid.json' );
    my %cfg = %DEFAULT_CONFIG;
    if ($err) {
        warn "RFID: $err — using defaults\n";
    }
    else {
        my $loaded = eval { decode_json($json) };
        if ( my $e = $@ ) { warn "RFID: bad koha-rfid.json: $e\n" }
        else              { %cfg = ( %cfg, %$loaded ) }
    }
    return \%cfg;
}

## Which page are we rendering? Under this fork SCRIPT_NAME carries an
## /intranet prefix (e.g. /intranet/circ/returns.pl) and the site front page
## arrives as SCRIPT_NAME=/index.html, so SCRIPT_FILENAME is the fallback.
sub _page {
    my $name = $ENV{SCRIPT_NAME} || $ENV{REQUEST_URI} || '';
    if ( $name eq '/index.html' && ( $ENV{SCRIPT_FILENAME} || '' ) =~ m{/([^/]+\.pl)$} ) {
        return $1;
    }
    return $name;
}

## Match a config entry as whole trailing path segments: both 'circ/returns.pl'
## and 'returns.pl' match '/intranet/circ/returns.pl'. A plain substring test
## would also match 'notreturns.pl', which is a poor way to decide where to open a
## serial port — the gate has to fail closed.
sub _on_rfid_page {
    my ( $cfg, $page ) = @_;
    my $file = ( $page =~ m{/([^/]+\.pl)} ) ? $1 : $page;

    for my $p ( grep { defined $_ && length $_ } @{ $cfg->{pages} || [] } ) {
        return 1 if $page =~ m{(?:\A|/)\Q$p\E\z};
        return 1 if $file && $file eq $p;
    }
    return 0;
}

## Which keys identify this user in userenv. This fork stores the login name under
## 'id' — circ/returns.pl and circ/circulation.pl both do
## C4::Auth::haspermission( C4::Context->userenv->{id}, ... ) — while newer Koha
## uses 'userid'; cardnumber/borrowernumber are last so the log stays readable
## whatever the version. An allowlist keyed on a key that does not exist would
## match nobody and read as the plugin being broken.
sub _identities {
    my ($ue) = @_;
    return grep { defined $_ && /\S/ } map { $ue->{$_} } qw(id userid userID cardnumber number);
}

## The one to show a human: first of the above. Undef (rather than '') when
## userenv has no usable id is worth seeing in the log.
sub _identity {
    my ($ue) = @_;
    my ($first) = _identities($ue);
    return $first;
}

## Superlibrarian, asked of Koha itself. haspermission returns the normalised flag
## hash (userenv->{flags} here is a raw bitfield; there is also a subpermissions
## table), so nothing here parses permissions. Used only to let support reach a
## page during a branch-limited rollout — the pages themselves still decide what a
## given librarian may actually do. RFID is an accelerator, so a helper that fails
## means "not super", never a dead hook.
sub _is_super {
    my ($ue) = @_;
    my $id = _identity($ue);
    return 0 unless defined $id;

    require C4::Auth;
    my $flags = eval { C4::Auth::haspermission($id) };
    return 0 if $@ || ref $flags ne 'HASH';
    return $flags->{superlibrarian} ? 1 : 0;
}

## Optional narrowing of the rollout, not a permission system: empty lists (the
## default) mean every logged-in staff page visitor gets RFID, and the Koha page
## itself keeps deciding what that user is allowed to do. When branches/users are
## set they only ever remove pages.
sub _enrolled {
    my ( $cfg, $ue ) = @_;
    my @branches = @{ $cfg->{branches} || [] };
    my @users    = @{ $cfg->{users}    || [] };
    return ( 1, 'open' ) unless @branches || @users;

    return ( 1, 'superlibrarian' ) if _is_super($ue);
    return ( 1, "branch:$ue->{branch}" ) if grep { defined $_ && $_ eq ( $ue->{branch} // '' ) } @branches;

    for my $u ( _identities($ue) ) {
        return ( 1, "user:$u" ) if grep { defined $_ && $_ eq $u } @users;
    }
    return ( 0, 'not enrolled' );
}

sub _js {
    my ($bytes) = @_;
    utf8::decode($bytes);
    return $bytes;
}

## Inject the Web Serial bundle, and nothing else. Wrapped so that a plugin bug
## can never take down a staff page: on any error we inject nothing.
sub intranet_js {
    my ( $self, $args ) = @_;

    my $out = eval {
        my $cfg  = _config();
        my $page = _page();
        return '' unless _on_rfid_page( $cfg, $page );

        # Not a permission check — just refusing to ship a reader handshake to an
        # anonymous page. The staff page that follows does its own auth.
        my $ue = C4::Context->userenv;
        if ( !defined $ue || ref $ue ne 'HASH' ) {
            warn "RFID: page=$page not injected (no logged-in user)\n";
            return '';
        }

        my ( $ok, $why ) = _enrolled( $cfg, $ue );
        if ( !$ok ) {
            warn "RFID: page=$page skipped ($why)\n";
            return '';
        }

        my ( $bundle, $err ) = _cached_file( _dir() . 'koha-rfid.bundle.js' );
        if ($err) {
            warn "RFID: page=$page not injected ($err)\n";
            return '';
        }

        my $context = encode_json({
            pluginVersion => $VERSION,
            page          => $page,
            branch        => $ue->{branch},
            userid        => _identity($ue),
            number        => $ue->{number},
            enrolledVia   => $why,
        });

        # Only client-side keys go to the browser — pages/branches/users stay server side.
        my %client_config = map { exists $cfg->{$_} ? ($_ => $cfg->{$_}) : () }
            qw(hint debug bookPrefix);

        my $html = sprintf(
            '<script>window.RFID_CONFIG=%s;window.RFID_CONTEXT=%s;</script>',
            _js( encode_json(\%client_config) ), _js($context)
        );

        $html .= "\n<script>" . _js($bundle) . "</script>";

        warn sprintf(
            "RFID: page=%s branch=%s user=%s via=%s inject=%d bytes\n",
            $page, $ue->{branch} // '-', _identity($ue) // '-', $why, length $html
        );
        return $html;
    };

    if ( my $e = $@ ) {
        warn "RFID: hook failed, injecting nothing: $e";
        return '';
    }
    return $out;
}

## Clean up on uninstall
sub uninstall {
    my ( $self, $args ) = @_;
}

## Upgrade handler
sub upgrade {
    my ( $self, $args ) = @_;

    return 1;
}

1;
