#!/usr/bin/env python3
"""RDev Academy v0.3.0 database tests (SQLite, foreign keys ON).
   Usage: python3 database/tests/test_db.py     (npm run test:db)     Requires: Python 3.9+, Node >= 22.6.
   Uses synthetic fixtures by default (tests/fixtures/content); set RDEV_DB_TEST_CONTENT=real to test database/bootstrap.
   Paths are relative to the repository. SQLite is not Cloudflare D1: re-run against `wrangler dev` / D1 before trusting it."""
import glob, json, os, re, sqlite3, subprocess, sys, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
P = lambda *a: os.path.join(ROOT, *a)
NOW = '2026-11-22T10:00:00.000Z'
results = []
def ok(name, cond, extra=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
def new_db(init=True, preload=None):
    c = sqlite3.connect(':memory:'); c.isolation_level = None; c.execute('PRAGMA foreign_keys=ON')
    for f in (preload or []): c.executescript(open(f).read())
    if init: c.executescript(open(P('database', 'init.sql')).read())
    return c
def run_file(c, f): c.executescript(open(f).read())
def rejects(c, name, sql, args=(), contains=None):
    """A rejection only counts if the error message names the intended reason (so SQL typos can never pass)."""
    assert contains, f'test "{name}" must state the expected error text'
    alts = [contains] if isinstance(contains, str) else list(contains)
    try: c.execute(sql, args); ok(name + ' -> rejected', False, 'statement was accepted')
    except sqlite3.Error as e:
        m = str(e); ok(name + ' -> rejected', any(a.lower() in m.lower() for a in alts), f'wrong error: {m}')
        if os.environ.get('VERBOSE'): print('      ·', m[:110])
def one(c, q, a=()): return c.execute(q, a).fetchone()[0]

def checksum(d):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f: json.dump(d, f); name = f.name
    try: return subprocess.check_output(['node', P('database', 'tests', 'checksum.mjs'), name], text=True).strip()
    finally: os.unlink(name)
def make_body(pkg, version, contents, title='t'):
    d = {'format': 'rlf', 'formatVersion': 1, 'id': pkg, 'title': title, 'description': 'd', 'version': version, 'license': 'l',
         'entries': [json.loads(x) for x in contents], 'sources': [], 'relationships': []}
    d['checksum'] = checksum(d)
    return json.dumps(d, separators=(',', ':')), d['checksum']

def snapshot(c):
    return tuple(one(c, f'select count(*) from {t}') for t in ('package_versions', 'package_version_entries', 'publications', 'publication_proposals', 'entry_versions', 'entries', 'proposal_events')) + (
        tuple(c.execute('select id,current_version from packages order by id').fetchall()), tuple(c.execute('select id,status from proposals order by id').fetchall()))

def approve(c, pid, note='reviewed'):
    c.execute("update proposals set status='approved', reviewed_at=?, review_note=? where id=?", (NOW, note, pid))
def content_for(payload, ver, status='published'):
    e = dict(payload); e['status'] = status; e['version'] = f'{ver}.0.0'; return json.dumps(e, separators=(',', ':'))

def publish(c, pkg, version, specs, *, retire=(), prev='auto', attach='auto', mark=True, membership='auto', body=None, action='publish',
            drop_member=None, omit_from_body=None, declared=None, tamper_body=False, status='published', dup_body=False, skip_pointer=False, extra_proposals=()):
    """Mimics one atomic D1 batch. specs: [(entry_id, entry_version, proposal_id, payload_dict, is_new)] for versions CREATED by this publication;
       `carry` entries come from membership='auto' = previous membership (minus retire) + created versions."""
    c.execute('BEGIN')
    try:
        before = c.execute('select current_version from packages where id=?', (pkg,)).fetchone()[0]
        carried = [] if before is None else [r for r in c.execute('select entry_id, entry_version from package_version_entries where package_id=? and package_version=?', (pkg, before))
                                              if r[0] not in retire and r[0] not in [s[0] for s in specs]]
        contents = {}
        for eid, ev, pid, payload, is_new in specs:
            ct = content_for(payload, ev, status)
            if is_new: c.execute('insert into entries(id,kind) values(?,?)', (eid, payload['kind']))
            c.execute('insert into entry_versions(entry_id,version,path,category,title,summary,level,minutes,tags,content_json,search_text,status,origin,review_json,content_hash,proposal_id) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                      (eid, ev, payload['path'], payload['category'], payload['title'], payload['summary'], payload['level'], payload['minutes'], ','.join(payload['tags']), ct, payload['title'].lower(), status, payload['origin'], None, 'h', pid))
            contents[eid] = ct
        for eid, ev in carried: contents[eid] = c.execute('select content_json from entry_versions where entry_id=? and version=?', (eid, ev)).fetchone()[0]
        members = [(e, v) for e, v in carried] + [(s[0], s[1]) for s in specs] if membership == 'auto' else membership
        ordered = [contents[e] for e, _ in members if e in contents]
        if omit_from_body is not None: ordered.pop(omit_from_body)
        if tamper_body: ordered[0] = ordered[0].replace('"title":"', '"title":"TAMPERED ', 1)
        if dup_body: ordered = [ordered[0]] + [ordered[0]] * (len(ordered) - 1)
        bdy, chk = body if body else make_body(pkg, version, ordered)
        n_decl = declared if declared is not None else len(json.loads(bdy)['entries'])
        c.execute('insert into package_versions(package_id,version,checksum,entry_count,body) values(?,?,?,?,?)', (pkg, version, chk, n_decl, bdy))
        for i, (e, v) in enumerate(members):
            if drop_member is not None and i == drop_member: continue
            c.execute('insert into package_version_entries values(?,?,?,?)', (pkg, version, e, v))
        pv = before if prev == 'auto' else prev
        pub = c.execute('insert into publications(package_id,version,previous_version,action,note) values(?,?,?,?,?)', (pkg, version, pv, action, 'test')).lastrowid
        if attach == 'auto':
            attach_ids = [s[2] for s in specs] + [r[0] for r in c.execute("select id from proposals where kind='retire' and status='approved' and target_entry_id in (%s)" % ','.join('?' * len(retire)), tuple(retire))] if retire else [s[2] for s in specs]
        else: attach_ids = attach
        for pid in list(attach_ids) + list(extra_proposals): c.execute('insert into publication_proposals values(?,?)', (pub, pid))
        if mark:
            for pid in attach_ids: c.execute("update proposals set status='published' where id=? and status='approved'", (pid,))
        if not skip_pointer: c.execute('update packages set current_version=? where id=?', (version, pkg))
        c.execute('COMMIT'); return True
    except sqlite3.Error as e:
        c.execute('ROLLBACK'); return str(e)

PUBLIC_ENTRIES = """select ev.entry_id, ev.title from packages p join package_version_entries m on m.package_id=p.id and m.package_version=p.current_version
  join entry_versions ev on ev.entry_id=m.entry_id and ev.version=m.entry_version"""

def expect_abort(c, name, contains, fn):
    alts = [contains] if isinstance(contains, str) else list(contains)
    snap = snapshot(c); r = fn(); same = snapshot(c) == snap
    ok(name + ' -> aborted, state unchanged', r is not True and any(a.lower() in str(r).lower() for a in alts) and same, f'result={r!r} unchanged={same}')

# ============ 1. Semantic version validation ============
c = new_db()
valid = ['0.0.0', '1.0.0', '10.20.30', '123456789.0.1', '1.10.2']
invalid = ['', '1', '1.0', '1.0.0.0', '1..0', '.1.0', '1.0.', '01.0.0', '1.00.0', '1.0.00', '1.0.0-beta', '1.0.0+build', 'v1.0.0', '1.0.x', '1.0.0 ', ' 1.0.0', '1.0.0\n', '١.٠.٠', '1,0,0', '+1.0.0', '-1.0.0', '1.0.0' + '0' * 40]
def body0(pkg, v): return json.dumps({'id': pkg, 'version': v, 'checksum': 'c', 'entries': []})
for v in valid:
    try: c.execute('insert into package_versions values(?,?,?,?,?,?)', ('rdev-art', v, 'c', 0, body0('rdev-art', v), NOW)); ok(f'semver accepts {v!r}', True)
    except sqlite3.Error as e: ok(f'semver accepts {v!r}', False, str(e))
for v in invalid:
    rejects(c, f'semver rejects {v!r}', 'insert into package_versions values(?,?,?,?,?,?)', ('rdev-pro', v, 'c', 0, body0('rdev-pro', v), NOW), 'CHECK')
rejects(c, "packages.current_version CHECK rejects '1.0'", "insert into packages(id,title,description,current_version) values('x','t','d','1.0')", (), 'CHECK')
rejects(c, "publications.version rejects '1.0.0.0'", "insert into publications(package_id,version,action) values('rdev-art','1.0.0.0','publish')", (), 'CHECK')

# ============ 2. Delete ordering / delete over every older schema ============
delete_sql = open(P('database', 'delete.sql')).read()
drops = re.findall(r'^DROP TABLE IF EXISTS (\w+);', delete_sql, re.M)
c = new_db(); tables = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
edges = [(t, fk[2]) for t in tables for fk in c.execute(f'PRAGMA foreign_key_list({t})')]  # (child, parent)
ok('delete.sql drops every table that init creates', set(tables) <= set(drops), str(set(tables) - set(drops)))
bad = [(ch, pa) for ch, pa in edges if drops.index(ch) > drops.index(pa)]
ok(f'delete order: all {len(edges)} foreign-key edges drop child before parent', not bad, str(bad))
for label, pre in [('v0.1.0', ['legacy/v0.1.0-schema.sql']), ('v0.2.0 (populated)', ['legacy/v0.2.0-schema.sql', 'legacy/v0.2.0-seed-sample.sql'])]:
    d = new_db(init=False, preload=[P('database', 'tests', f) for f in pre])
    ok(f'{label}: legacy schema declares no foreign keys', all(not list(d.execute(f'PRAGMA foreign_key_list({r[0]})')) for r in d.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")))
    try: d.executescript(open(P('database', 'init.sql')).read()); ok(f'{label}: init without delete fails loudly', False, 'init succeeded on a legacy db')
    except sqlite3.Error as e: ok(f'{label}: init without delete fails loudly', 'already a table' in str(e) or 'already exists' in str(e), str(e))
    d = new_db(init=False, preload=[P('database', 'tests', f) for f in pre]); d.executescript(delete_sql)
    ok(f'{label}: delete leaves an empty database', one(d, "select count(*) from sqlite_master where name not like 'sqlite_%'") == 0)
    d.executescript(open(P('database', 'init.sql')).read()); ok(f'{label}: init after delete succeeds, FK check clean', d.execute('PRAGMA foreign_key_check').fetchall() == [])
d = new_db(init=False); d.executescript(delete_sql); ok('delete on an empty database is harmless', True)

# ============ 3. Bootstrap ============
c = new_db()
if os.environ.get('RDEV_DB_TEST_CONTENT') == 'real':
    files = sorted(glob.glob(P('database', 'bootstrap', '*.sql')))
else:
    out = tempfile.mkdtemp(prefix='rdev-boot-')
    subprocess.check_call(['node', '--experimental-strip-types', '--no-warnings', P('scripts', 'gen-bootstrap.ts'), '--project', ROOT, '--content', P('tests', 'fixtures', 'content'), '--out', out], stdout=subprocess.DEVNULL)
    files = sorted(glob.glob(os.path.join(out, '*.sql')))
ok('bootstrap files present (sources + per-path)', len(files) >= 2, str(len(files)))
for f in files: run_file(c, f)
N = one(c, "select count(*) from proposals")
ok('all bootstrap proposals are pending, unreviewed, origin bootstrap', N >= 6 and one(c, "select count(*) from proposals where status='pending' and origin='bootstrap' and kind='new' and reviewed_at is null") == N, str(N))
PATH_NAME = c.execute("select json_extract(payload_json,'$.path') p, count(*) n from proposals group by p order by n desc limit 1").fetchone()[0]
PKG = one(c, 'select id from packages where title=?', (PATH_NAME,))
ok('bootstrap created no entries, versions, packages versions or publications', all(one(c, f'select count(*) from {t}') == 0 for t in ('entries', 'entry_versions', 'package_versions', 'publications')))
ok('public view is empty and no package has a current version', c.execute(PUBLIC_ENTRIES).fetchall() == [] and one(c, 'select count(*) from packages where current_version is not null') == 0)
ok('payloads: ai-assisted, unreviewed, source attribution kept', all((lambda e: e['status'] == 'ai-assisted' and e['review'] is None and e['origin'] == 'ai-assisted' and e['sourceIds'])(json.loads(r[0])) for r in c.execute('select payload_json from proposals')))
ok('every source id referenced by a payload exists in sources', all(s in {r[0] for r in c.execute('select id from sources')} for r in c.execute('select payload_json from proposals') for s in json.loads(r[0])['sourceIds']))
ok('one audit event per bootstrap proposal', one(c, "select count(*) from proposal_events where to_status='pending' and from_status is null") == N)
for f in files: run_file(c, f)
ok('bootstrap re-run is idempotent (no duplicates, no extra audit events)', one(c, 'select count(*) from proposals') == N and one(c, 'select count(*) from proposal_events') == N)

# ============ 4. Proposal lifecycle and audit trail ============
pid = one(c, "select min(id) from proposals")
ev = lambda p: c.execute('select from_status,to_status from proposal_events where proposal_id=? order by id', (p,)).fetchall()
rejects(c, 'new proposal cannot start approved', "insert into proposals(kind,target_entry_id,title,payload_json,payload_hash,origin,status,reviewed_at) values('new','x','t','{}','hx','owner','approved','2026-01-01T00:00:00Z')", (), 'start pending')
rejects(c, 'pending -> published is invalid', "update proposals set status='published' where id=?", (pid,), 'invalid proposal status transition')
rejects(c, 'approving requires reviewed_at', "update proposals set status='approved' where id=?", (pid,), 'CHECK')
rejects(c, 'rejecting requires a note', "update proposals set status='rejected', reviewed_at=? where id=?", (NOW, pid), 'CHECK')
rejects(c, 'review metadata cannot change without a decision', "update proposals set review_note='sneaky' where id=?", (pid,), 'review metadata')
approve(c, pid, 'looks good')
ok('approval is audited', ev(pid) == [(None, 'pending'), ('pending', 'approved')] and c.execute('select note, decided_at from proposal_events where to_status=? and proposal_id=?', ('approved', pid)).fetchone() == ('looks good', NOW))
rejects(c, 'approved metadata cannot be silently edited (note)', "update proposals set review_note='changed' where id=?", (pid,), 'review metadata')
rejects(c, 'approved metadata cannot be silently edited (date)', "update proposals set reviewed_at='2027-01-01T00:00:00Z' where id=?", (pid,), 'review metadata')
rejects(c, 'approved -> pending is not allowed', "update proposals set status='pending' where id=?", (pid,), 'invalid proposal status transition')
rejects(c, 'published transition cannot rewrite review metadata', "update proposals set status='published', reviewed_at='2030-01-01T00:00:00Z' where id=?", (pid,), 'review metadata')
rejects(c, 'proposal content is frozen (title)', "update proposals set title='x' where id=?", (pid,), 'immutable')
rejects(c, 'proposal content is frozen (payload)', "update proposals set payload_json='{}' where id=?", (pid,), 'immutable')
rejects(c, 'proposals cannot be deleted', "delete from proposals where id=?", (pid,), 'cannot be deleted')
rejects(c, 'audit events cannot be edited', "update proposal_events set note='x'", (), 'append-only')
rejects(c, 'audit events cannot be deleted', "delete from proposal_events", (), 'append-only')
pid2 = one(c, "select id from proposals where status='pending' order by id limit 1")
c.execute("update proposals set status='rejected', reviewed_at=?, review_note='needs a source check' where id=?", (NOW, pid2))
ok('rejection is audited with its note', ev(pid2)[-1] == ('pending', 'rejected') and one(c, "select note from proposal_events where proposal_id=? and to_status='rejected'", (pid2,)) == 'needs a source check')
rejects(c, 'rejected is terminal', "update proposals set status='approved', reviewed_at=? where id=?", (NOW, pid2), 'invalid proposal status transition')
pid3 = one(c, "select id from proposals where status='pending' order by id limit 1")
c.execute("update proposals set status='superseded' where id=?", (pid3,)); ok('pending -> superseded allowed and audited', ev(pid3)[-1] == ('pending', 'superseded'))
rejects(c, 'superseded is terminal', "update proposals set status='pending' where id=?", (pid3,), 'invalid proposal status transition')
ok('foreign key check clean after lifecycle tests', c.execute('PRAGMA foreign_key_check').fetchall() == [])

# ============ 5. Publication integrity ============
c = new_db()
for f in files: run_file(c, f)
studio = c.execute("select id, target_entry_id, payload_json from proposals where json_extract(payload_json,'$.path')=? order by id", (PATH_NAME,)).fetchall()
S = [(pid, eid, json.loads(pj)) for pid, eid, pj in studio]
specs = lambda xs: [(eid, 1, pid, pl, True) for pid, eid, pl in xs]
# a. unapproved content is refused at the entry-version level
c.execute('BEGIN'); c.execute("insert into entries values(?,?,?)", (S[0][1], 'lesson', NOW))
try: c.execute('insert into entry_versions(entry_id,version,path,category,title,summary,level,minutes,content_json,status,origin,content_hash,proposal_id) values(?,1,"p","c","t","s","Beginner",1,"{}","published","original","h",?)', (S[0][1], S[0][0])); ok('pending proposal cannot create an entry version', False)
except sqlite3.Error as e: ok('pending proposal cannot create an entry version', 'approved' in str(e))
c.execute('ROLLBACK')
for pid_, _, _ in S: approve(c, pid_)
base = snapshot(c)
# b. negative publications (each must abort atomically and leave NO state behind)
full = [content_for(pl, 1) for _, _, pl in S]
expect_abort(c, 'declared entry_count != body entries', 'CHECK', lambda: publish(c, PKG, '1.0.0', specs(S), declared=len(S) - 1))
expect_abort(c, 'body differs from membership (tampered entry text)', 'does not match its membership', lambda: publish(c, PKG, '1.0.0', specs(S), tamper_body=True))
expect_abort(c, 'new entry membership row missing', ('membership count', 'only approved proposals that match'), lambda: publish(c, PKG, '1.0.0', specs(S), drop_member=2))
expect_abort(c, 'duplicate ids in body with correct count', 'duplicate or missing', lambda: publish(c, PKG, '1.0.0', specs(S), dup_body=True))
expect_abort(c, 'entry version status not publishable (ai-assisted)', 'status published or verified', lambda: publish(c, PKG, '1.0.0', specs(S), status='ai-assisted'))
expect_abort(c, 'new entries not attached to the publication', 'attached to the publication', lambda: publish(c, PKG, '1.0.0', specs(S), attach=[]))
expect_abort(c, 'attached proposals not marked published', 'marked published', lambda: publish(c, PKG, '1.0.0', specs(S), mark=False))
expect_abort(c, 'stale compare-and-set (pointer read earlier)', 'stale publication', lambda: publish(c, PKG, '1.0.0', specs(S), prev='9.9.9'))
pending_one = one(c, "select min(id) from proposals where status='pending'")
expect_abort(c, 'attaching a proposal that is not approved', 'only approved proposals', lambda: publish(c, PKG, '1.0.0', specs(S), extra_proposals=[pending_one]))
ok('no negative case leaked any state', snapshot(c) == base)
# checksum: column must equal the body's own checksum field
bdy, chk = make_body(PKG, '1.0.0', [content_for(pl, 1) for _, _, pl in S])
rejects(c, 'checksum column must match body checksum field', 'insert into package_versions(package_id,version,checksum,entry_count,body) values(?,?,?,?,?)', (PKG, '1.0.0', 'f' * 64, len(S), bdy), 'CHECK')
# c. valid first publication
r = publish(c, PKG, '1.0.0', specs(S)); ok('valid first publication commits', r is True, str(r))
ok('public view now shows exactly the approved entries', len(c.execute(PUBLIC_ENTRIES).fetchall()) == len(S) and one(c, "select count(*) from packages where current_version is not null") == 1)
ok('all proposals in the publication are published; others untouched', one(c, "select count(*) from proposals where status='published'") == len(S) and one(c, "select count(*) from proposals where status='pending'") == N - len(S))
ok('published entries remain AI-assisted origin with no review record', one(c, "select count(*) from entry_versions where origin='ai-assisted' and review_json is null and status='published'") == len(S))
ok('proposal audit shows pending->approved->published', ev(S[0][0]) == [(None, 'pending'), ('pending', 'approved'), ('approved', 'published')])
rejects(c, 'pointer cannot be unset', "update packages set current_version=NULL where id=?", (PKG,), 'cannot be unset')
rejects(c, 'pointer cannot jump to a version with no publication record', "update packages set current_version='1.0.0' where id='rdev-ui'", (), 'must follow')
# d. updates, staleness, rollback, retirement
first = S[0][1]
def add_proposal(kind, eid, base, title, payload, h, origin='owner'):
    c.execute('insert into proposals(kind,target_entry_id,base_version,title,payload_json,payload_hash,origin) values(?,?,?,?,?,?,?)', (kind, eid, base, title, json.dumps(payload), h, origin)); return c.execute('select last_insert_rowid()').fetchone()[0]
up = add_proposal('update', first, 1, 'Reword intro', {**S[0][2], 'title': S[0][2]['title'] + ' (v2)'}, 'u1'); approve(c, up)
stale = add_proposal('update', first, 1, 'Another edit on v1', {**S[0][2], 'title': 'other'}, 'u2'); approve(c, stale)
ok('both updates were based on v1 (one will become stale)', True)
expect_abort(c, 'carried-over membership row missing', ('membership count', 'does not match its membership', 'every removed entry'), lambda: publish(c, PKG, '1.0.1', [(first, 2, up, {**S[0][2], 'title': S[0][2]['title'] + ' (v2)'}, False)], drop_member=0))
expect_abort(c, 'extra membership row with no body entry (count gate in isolation)', 'membership count', lambda: publish(c, PKG, '1.0.1', [(first, 2, up, {**S[0][2], 'title': S[0][2]['title'] + ' (v2)'}, False)], omit_from_body=0))
expect_abort(c, 'version gap (v5) refused', 'contiguous', lambda: publish(c, PKG, '1.0.1', [(first, 5, up, {**S[0][2], 'title': S[0][2]['title'] + ' (v2)'}, False)]))
r = publish(c, PKG, '1.0.1', [(first, 2, up, {**S[0][2], 'title': S[0][2]['title'] + ' (v2)'}, False)]); ok('update publishes as a new package version', r is True, str(r))
rejects(c, 'cannot publish the same version twice (unique index)', "insert into publications(package_id,version,previous_version,action) values(?,'1.0.0','1.0.1','publish')", (PKG,), 'UNIQUE')
expect_abort(c, 'stale update (entry already at v2) refused', 'stale proposal', lambda: publish(c, PKG, '1.0.2', [(first, 3, stale, {**S[0][2], 'title': 'other'}, False)]))
c.execute('BEGIN'); c.execute("insert into package_versions values(?,'7.7.7','c',0,?,?)", (PKG, json.dumps({'id': PKG, 'version': '7.7.7', 'checksum': 'c', 'entries': []}), NOW))
try: c.execute("insert into publications(package_id,version,previous_version,action) values(?,'7.7.7','1.0.1','rollback')", (PKG,)); ok('rollback to a never-published version refused', False)
except sqlite3.Error as e: ok('rollback to a never-published version refused', 'previously published' in str(e))
c.execute('ROLLBACK')
c.execute('BEGIN'); c.execute("insert into publications(package_id,version,previous_version,action,note) values(?,'1.0.0','1.0.1','rollback','revert')", (PKG,)); c.execute("update packages set current_version='1.0.0' where id=?", (PKG,)); c.execute('COMMIT')
ok('rollback restores the earlier public content, history retained', not [t for e, t in c.execute(PUBLIC_ENTRIES) if t.endswith('(v2)')] and one(c, "select count(*) from package_versions where package_id=?", (PKG,)) == 2 and one(c, "select count(*) from publications where action='rollback'") == 1 and one(c, 'select count(*) from entry_versions where entry_id=?', (first,)) == 2)
rejects(c, 'rolling back to the version already current is refused', "insert into publications(package_id,version,previous_version,action) values(?,'1.0.0','1.0.0','rollback')", (PKG,), 'CHECK')
np_ = add_proposal('new', first, None, 'duplicate new', S[0][2], 'n1'); approve(c, np_)
expect_abort(c, "'new' proposal for an entry that already exists refused", 'stale proposal', lambda: publish(c, PKG, '1.0.2', [(first, 3, np_, S[0][2], False)]))
# retire: removal requires an approved retire proposal
retire_eid = S[1][1]
expect_abort(c, 'removing an entry without a retire proposal', 'approved retire proposal', lambda: publish(c, PKG, '1.0.2', [], retire=(retire_eid,)))
rp = add_proposal('retire', retire_eid, 1, 'Retire entry', {'reason': 'obsolete'}, 'r1'); approve(c, rp)
r = publish(c, PKG, '1.0.2', [], retire=(retire_eid,)); ok('retire proposal publishes and removes the entry from public view', r is True and not [e for e, _ in c.execute(PUBLIC_ENTRIES) if e == retire_eid], str(r))
ok('retired entry history is kept', one(c, 'select count(*) from entry_versions where entry_id=?', (retire_eid,)) == 1)
# A publication row committed WITHOUT the pointer move (a Worker bug) cannot be prevented by SQL; the audit must catch it.
d = sqlite3.connect(':memory:'); d.isolation_level = None; c.backup(d); d.execute('PRAGMA foreign_keys=ON')
r = publish(d, 'rdev-ui', '1.0.0', [], skip_pointer=True)
ok('SQL cannot force the pointer update to accompany a publication row (documented limitation)', r is True, str(r))
dangling = None
# worker-level: independent audit of everything published (what the Worker/CLI verifier must do)
def audit(c):
    problems = []
    for pkg, ver, chk, n, body in c.execute('select package_id,version,checksum,entry_count,body from package_versions'):
        d = json.loads(body); real = checksum(d)
        if real != chk: problems.append(f'{pkg}@{ver}: checksum is not the true SHA-256 of the body')
        mem = {r[0]: r[1] for r in c.execute('select entry_id,entry_version from package_version_entries where package_id=? and package_version=?', (pkg, ver))}
        if len(d['entries']) != n or len(mem) != n or {e['id'] for e in d['entries']} != set(mem): problems.append(f'{pkg}@{ver}: body/membership/count mismatch')
        for e in d['entries']:
            if one(c, 'select json(content_json) from entry_versions where entry_id=? and version=?', (e['id'], mem[e['id']])) != json.dumps(e, separators=(',', ':')) and json.loads(one(c, 'select content_json from entry_versions where entry_id=? and version=?', (e['id'], mem[e['id']]))) != e: problems.append(f'{pkg}@{ver}:{e["id"]} content differs')
    for pkg, cur in c.execute('select id,current_version from packages where current_version is not null'):
        last = c.execute('select version from publications where package_id=? order by id desc limit 1', (pkg,)).fetchone()
        if not last or last[0] != cur: problems.append(f'{pkg}: pointer {cur} != latest publication {last}')
    for pkg, in c.execute('select distinct package_id from publications'):
        cur = c.execute('select current_version from packages where id=?', (pkg,)).fetchone()[0]
        last = c.execute('select version from publications where package_id=? order by id desc limit 1', (pkg,)).fetchone()[0]
        if cur != last: problems.append(f'{pkg}: latest publication {last} but pointer is {cur}')
    return problems
dangling_problems = audit(d)
ok('...but the worker-level audit detects a publication that never moved the pointer', any('latest publication' in p for p in dangling_problems), str(dangling_problems))
ok('worker-level audit: every stored package version verifies (true SHA-256, membership, counts, content)', audit(c) == [], str(audit(c)))
# division of responsibility: SQL cannot detect a self-consistent but FALSE checksum; the audit must
fake = {'id': 'rdev-ui', 'version': '1.0.0', 'checksum': 'a' * 64, 'entries': []}
c.execute('BEGIN'); c.execute("insert into package_versions values('rdev-ui','1.0.0',?,0,?,?)", ('a' * 64, json.dumps(fake), NOW)); ok('SQL accepts a self-consistent fake checksum (it cannot compute SHA-256)', True)
ok('...and the worker-level audit detects it', any('true SHA-256' in p for p in audit(c))); c.execute('ROLLBACK')
# next-version rule the Worker must implement (SQL cannot order semver)
def next_patch(vs): return '.'.join(map(str, (lambda t: (t[0], t[1], t[2] + 1))(max(tuple(map(int, v.split('.'))) for v in vs))))
ok('worker rule: next version uses numeric ordering (1.0.9 -> 1.0.10, not string max)', next_patch(['1.0.2', '1.0.9']) == '1.0.10' and max(['1.0.2', '1.0.9', '1.0.10']) != '1.0.10')
ok('foreign key check clean after the full lifecycle', c.execute('PRAGMA foreign_key_check').fetchall() == [])

# ============ 6. Admin tables ============
c.execute("insert into admin_sessions(id,token_fingerprint,last_seen_at,idle_expires_at,absolute_expires_at) values('h','fp','2026-11-22T00:00:00Z','2026-11-22T00:30:00Z','2026-11-22T08:00:00Z')")
c.execute("update admin_sessions set revoked_at='2026-11-22T00:10:00Z', revoked_reason='logout' where id='h'"); ok('sessions store a token fingerprint and can be revoked', True)
c.execute("insert into security_events(event,severity,detail) values('publish','info','1.0.0')"); c.execute("insert into login_attempts(ip_hash,success) values('x',0)")
rejects(c, 'security events are append-only', "update security_events set detail='x'", (), 'append-only')
rejects(c, 'security events cannot be deleted', "delete from security_events", (), 'append-only')

# ============ 7. Reset a fully populated v0.3.0 database; ordering negative control ============
rejects(c, 'negative control: dropping a parent table first violates foreign keys', 'DROP TABLE packages', (), 'FOREIGN KEY')
c.executescript(delete_sql); ok('delete removes a fully populated v0.3.0 database (history, triggers, indexes)', one(c, "select count(*) from sqlite_master where name not like 'sqlite_%'") == 0)
print(f'\n{sum(results)}/{len(results)} passed   (SQLite {sqlite3.sqlite_version}; NOT Cloudflare D1)'); sys.exit(0 if all(results) else 1)
