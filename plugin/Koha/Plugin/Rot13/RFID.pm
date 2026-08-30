package Koha::Plugin::Rot13::RFID;

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
    date_updated    => '2026-08-30',
    minimum_version => undef,
    maximum_version => undef,
    version         => $VERSION,
    description     => 'Drive a 3M 810 RFID reader straight from the browser over Web Serial. No local server. Injected only on RFID pages and only for enrolled libraries/users; dormant unless a reader was connected.',
    namespace       => 'rfid',
};

## Defaults used when the config file is missing or unreadable.
## "legacy" also injects the old Go-server polling script (kept during the M0
## spike so existing behaviour is untouched while the Web Serial path is tested).
my %DEFAULT_CONFIG = (
    pages       => [
        'circ/returns.pl', 'circ/circulation.pl', 'circ/circulation-home.pl',
        'circ/renew.pl', 'catalogue/moredetail.pl', 'mainpage.pl',
    ],
    branches    => [],          # empty = every branch
    users       => [],          # empty = every user (staff pages are gated anyway)
    legacy      => JSON::XS::true(),
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

sub _dir {
    return C4::Context->config('pluginsdir') . '/Koha/Plugin/Rot13/RFID/';
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

sub _on_rfid_page {
    my ( $cfg, $page ) = @_;
    my $file = ( $page =~ m{/([^/]+\.pl)} ) ? $1 : $page;

    for my $p ( @{ $cfg->{pages} || [] } ) {
        return 1 if index( $page, $p ) >= 0;
        return 1 if $file && $file eq $p;
    }
    return 0;
}

## Empty branches+users = everyone. superlibrarian is always allowed, so support
## can always reproduce a report from any desk.
sub _enrolled {
    my ( $cfg, $ue ) = @_;
    my @branches = @{ $cfg->{branches} || [] };
    my @users    = @{ $cfg->{users}    || [] };
    return ( 1, 'open' ) unless @branches || @users;

    my $flags = $ue->{flags} || {};
    return ( 1, 'superlibrarian' ) if $flags->{superlibrarian};
    return ( 1, "branch:$ue->{branch}" ) if grep { defined $_ && $_ eq ( $ue->{branch} // '' ) } @branches;

    for my $u ( $ue->{userid}, $ue->{cardnumber}, $ue->{number} ) {
        return ( 1, "user:$u" ) if defined $u && grep { defined $_ && $_ eq $u } @users;
    }
    return ( 0, 'not enrolled' );
}

sub _js {
    my ($bytes) = @_;
    utf8::decode($bytes);
    return $bytes;
}

## Inject the Web Serial bundle — and, during the transition, the old
## Go-server script as well. Wrapped so that a plugin bug can never take down
## a staff page: on any error we inject nothing.
sub intranet_js {
    my ( $self, $args ) = @_;

    my $out = eval {
        my $cfg  = _config();
        my $page = _page();
        return '' unless _on_rfid_page( $cfg, $page );

        my $ue      = C4::Context->userenv || {};
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
            userid        => $ue->{userid},
            number        => $ue->{number},
            superlibrarian=> ( $ue->{flags} && $ue->{flags}->{superlibrarian} ) ? JSON::XS::true() : JSON::XS::false(),
            enrolledVia   => $why,
        });

        # Only client-side keys go to the browser — pages/branches/users stay server side.
        my %client_config = map { exists $cfg->{$_} ? ($_ => $cfg->{$_}) : () }
            qw(hint debug bookPrefix legacy);

        my $html = sprintf(
            '<script>window.RFID_CONFIG=%s;window.RFID_CONTEXT=%s;</script>',
            _js( encode_json(\%client_config) ), _js($context)
        );

        if ( $cfg->{legacy} ) {
            my ( $legacy, $lerr ) = _cached_file( _dir() . 'koha-rfid.js' );
            warn "RFID: legacy script skipped ($lerr)\n" if $lerr;
            $html = "<script>" . _js($legacy) . "</script>\n" . $html if $legacy;
        }

        $html .= "\n<script>" . _js($bundle) . "</script>";

        warn sprintf(
            "RFID: page=%s branch=%s user=%s via=%s inject=%d bytes\n",
            $page, $ue->{branch} // '-', $ue->{userid} // '-', $why, length $html
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
