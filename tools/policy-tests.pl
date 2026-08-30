#!/usr/bin/perl
#
# Gate policy tests for Koha::Plugin::Rot13::RFID.
#
# Run through tools/test-policy.sh, which stages this repo's RFID.pm on the Koha
# host and puts it first on PERL5LIB. Page matching and the rollout lists are
# tested with _is_super stubbed (they must not depend on the database); the real
# superlibrarian lookup is tested separately against the live borrowers table and
# skipped if there is no database.
use strict;
use warnings;
use Test::More;

require_ok('Koha::Plugin::Rot13::RFID') or BAIL_OUT('module did not load');

my $pkg      = 'Koha::Plugin::Rot13::RFID';
my $identity = do {
    no strict 'refs';
    {
        id  => \&{"${pkg}::_identity"},
        ids => \&{"${pkg}::_identities"},
        sup => \&{"${pkg}::_is_super"},
        pg  => \&{"${pkg}::_on_rfid_page"},
        enr => \&{"${pkg}::_enrolled"},
    }
};
ok( !( grep { !$_ } values %$identity ), 'all the gate subs are present' )
  or BAIL_OUT('gate subs renamed or removed');

# ---- page gate (pure) ----
my $cfg = { pages => [ 'returns.pl', 'mainpage.pl' ] };
is $identity->{pg}->( $cfg, '/intranet/circ/returns.pl' ),     1, 'returns.pl under the intranet prefix';
is $identity->{pg}->( $cfg, '/intranet/mainpage.pl' ),         1, 'mainpage.pl';
is $identity->{pg}->( $cfg, 'mainpage.pl' ),                   1, 'front page resolved from SCRIPT_FILENAME';
is $identity->{pg}->( $cfg, '/intranet/members/managers.pl' ), 0, 'unlisted page';
is $identity->{pg}->( $cfg, '/opac/opac-main.pl' ),            0, 'opac page';
is $identity->{pg}->( $cfg, '/intranet/circ/notreturns.pl' ),  0, 'suffix lookalike must not match';

my $pathcfg = { pages => ['circ/returns.pl'] };
is $identity->{pg}->( $pathcfg, '/intranet/circ/returns.pl' ), 1, 'legacy path style entry still matches';
is $identity->{pg}->( $pathcfg, '/intranet/returns.pl' ),      0, 'path style entry needs the directory';

# ---- identity (pure) ----
# This fork puts the login name in userenv->{id}; 'userid' is newer Koha.
is $identity->{id}->( { id => 'dpavlin', userid => 'other' } ), 'dpavlin', "'id' wins on this fork";
is $identity->{id}->( { userid => 'x@ffzg.hr' } ),              'x@ffzg.hr', "'userid' as fallback";
is $identity->{id}->( { number => 606 } ),                      606,         'borrowernumber as last resort';
is $identity->{id}->( {} ),                                     undef,       'nothing to identify by';
is_deeply [ $identity->{ids}->( { id => 'a', cardnumber => 'c', number => 1 } ) ],
  [ 'a', 'c', 1 ], 'all identities, in preference order';

# ---- rollout lists, with the superuser lookup stubbed out ----
sub enrol {
    my ( $cfg, $ue, $super ) = @_;
    no strict 'refs';
    no warnings 'redefine';
    local *{"${pkg}::_is_super"} = sub { $super ? 1 : 0 };
    my ( $ok, $why ) = $identity->{enr}->( $cfg, $ue );
    return { ok => $ok, why => $why };
}

is enrol( {}, { id => 'x', branch => 'FFZG' } )->{ok}, 1, 'empty lists are open to any logged-in user';

my $by_branch = enrol( { branches => ['FFZG'] }, { id => 'x', branch => 'FFZG' } );
is $by_branch->{ok}, 1, 'branch matches';
like $by_branch->{why}, qr/^branch:/, 'and says how';

is enrol( { users => ['jsmith'] }, { id => 'jsmith', branch => 'OTHER' } )->{ok}, 1, 'user matches';
is enrol( { users => ['42'] },     { id => 'other', number => 42, branch => 'OTHER' } )->{ok},
  1, 'borrowernumber counts as an identity';
is enrol( { users => ['jsmith'] }, { id => 'other', branch => 'OTHER' } )->{ok}, 0, 'someone else does not';
is enrol( { branches => ['FFZG'] }, { id => 'x', branch => 'OTHER' } )->{ok},     0, 'other branch is not enrolled';
is enrol( { users => ['jsmith'] }, { branch => 'OTHER' } )->{ok},                 0, 'no identity is not enrolled';

my $super = enrol( { branches => ['FFZG'] }, { id => 'boss', branch => 'OTHER' }, 1 );
is $super->{ok},  1,             'superlibrarian survives a branch-limited rollout';
is $super->{why}, 'superlibrarian', 'and says so';

# ---- the real superlibrarian lookup, against the live database ----
my $dbh = eval { require C4::Context; C4::Context->dbh };
if ( !$dbh ) {
  SKIP: { skip 'no database connection, skipping live permission lookup', 4; }
}
else {
    my $find = sub {
        my ($want_super) = @_;
        my ($row) = $dbh->selectrow_array(
            'SELECT userid, flags FROM borrowers WHERE flags '
          . ( $want_super ? '& 1' : "= 0" ) . " AND userid IS NOT NULL AND userid <> '' LIMIT 1"
        );
        return $row;
    };
    my ( $sup, $not ) = ( $find->(1), $find->(0) );

    SKIP: {
        skip 'no superlibrarian account in this database', 2 unless $sup;
        ok $identity->{sup}->( { id => $sup } ), "user '$sup' is superlibrarian to the plugin too";
        ok enrol_super($sup), "and stays enrolled when lists exclude them (via haspermission)";
    }
    SKIP: {
        skip 'no ordinary staff account in this database', 1 unless $not;
        ok !$identity->{sup}->( { id => $not } ), "staff user '$not' is not superlibrarian";
    }
    ok !$identity->{sup}->( {} ), 'no identity, no superuser lookup attempted';
}

sub enrol_super {
    my ($id) = @_;
    my ( $ok ) = $identity->{enr}->( { branches => ['THIS_BRANCH_DOES_NOT_EXIST'] }, { id => $id, branch => 'NOPE' } );
    return $ok;
}

done_testing();
