#!/usr/bin/env python3
"""Exact-ID cleanup of supported Codex SQLite schemas; JSON on stdin/stdout."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
from urllib.parse import quote

TABLES = {
    'state_5.sqlite': ('thread_dynamic_tools', 'thread_attachments'),
    'thread_history_1.sqlite': ('thread_items', 'thread_realtime_items', 'thread_history_projection_state', 'thread_turns'),
}
UUID = re.compile(r'[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}', re.I)


def normalized_sql(sql):
    return re.sub(r'\s+', ' ', sql.strip()).lower()


# Exact native trigger bodies, not merely trusted names. Unknown or altered
# triggers fail closed before any payload or row deletion.
NATIVE_TRIGGERS = {'state_5.sqlite': set(), 'thread_history_1.sqlite': set()}
for field in ('created_at', 'updated_at'):
    for event in ('insert', 'update'):
        when = f'NEW.{field}_ms IS NULL' if event == 'insert' else f'NEW.{field} != OLD.{field} AND NEW.{field}_ms IS OLD.{field}_ms'
        operation = 'INSERT' if event == 'insert' else f'UPDATE OF {field}'
        NATIVE_TRIGGERS['state_5.sqlite'].add(normalized_sql(f'''CREATE TRIGGER threads_{field}_ms_after_{event}
AFTER {operation} ON threads WHEN {when}
BEGIN UPDATE threads SET {field}_ms = NEW.{field} * 1000 WHERE id = NEW.id; END'''))
NATIVE_TRIGGERS['state_5.sqlite'].add(normalized_sql('''CREATE TRIGGER threads_recency_at_after_insert
AFTER INSERT ON threads WHEN NEW.recency_at_ms = 0
BEGIN UPDATE threads SET recency_at = NEW.updated_at,
recency_at_ms = COALESCE(NEW.updated_at_ms, NEW.updated_at * 1000) WHERE id = NEW.id; END'''))
NATIVE_TRIGGERS['thread_history_1.sqlite'].add(normalized_sql('''CREATE TRIGGER thread_realtime_items_projection_cleanup
AFTER DELETE ON thread_history_projection_state
BEGIN DELETE FROM thread_realtime_items WHERE thread_id = OLD.thread_id; END'''))


def anchored_directory(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('absolute account home required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        if os.fstat(fd).st_uid != os.getuid():
            raise ValueError('account home owner mismatch')
        return fd
    except Exception:
        os.close(fd); raise


def regular(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid():
        raise ValueError('database must be owned, regular and not linked')
    return (s.st_dev, s.st_ino)


def open_databases(root, readonly):
    databases = {}
    try:
        for path in root.glob('*.sqlite'):
            if re.match(r'(?:state_|thread_history_)', path.name) and path.name not in TABLES:
                raise ValueError('unsupported Codex database version')
        for name, allowed in TABLES.items():
            path = root / name
            if not os.path.lexists(path):
                continue
            identity = regular(path)
            for suffix in ('-wal', '-shm', '-journal'):
                sibling = Path(str(path)+suffix)
                if os.path.lexists(sibling): regular(sibling)
            connection = sqlite3.connect(f'file:{quote(str(path))}?mode={"ro" if readonly else "rw"}', uri=True, timeout=.25)
            databases[name] = connection
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('PRAGMA trusted_schema=OFF')
            if regular(path) != identity:
                raise ValueError('database identity changed')
            known = {}
            for table, in connection.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                if not re.fullmatch(r'[A-Za-z0-9_]+', table): raise ValueError('unsupported table name')
                columns = {r[1] for r in connection.execute(f'PRAGMA table_info("{table}")')}
                if 'thread_id' in columns and table not in allowed:
                    raise ValueError('unsupported thread table')
                if table not in allowed and any(r[2] == 'threads' for r in connection.execute(f'PRAGMA foreign_key_list("{table}")')):
                    raise ValueError('unsupported thread relationship')
                known[table] = columns
            for (sql,) in connection.execute("SELECT sql FROM sqlite_master WHERE type='trigger'"):
                if normalized_sql(sql) not in NATIVE_TRIGGERS[name]:
                    raise ValueError('unsupported database trigger')
            if name == 'state_5.sqlite':
                if not {'id','rollout_path','is_pinned','updated_at'} <= known.get('threads', set()):
                    raise ValueError('unsupported threads schema')
                if not {'parent_thread_id','child_thread_id'} <= known.get('thread_spawn_edges', set()):
                    raise ValueError('unsupported thread relationships schema')
            elif not {'thread_id','status'} <= known.get('thread_turns',set()):
                raise ValueError('unsupported history schema')
            for table in allowed:
                if table in known and 'thread_id' not in known[table]:
                    raise ValueError('unsupported thread table schema')
        return databases
    except Exception:
        for connection in databases.values(): connection.close()
        raise


def counts(databases, tid):
    result = {}
    for name, connection in databases.items():
        existing = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in TABLES[name]:
            if table in existing:
                result[f'{name}:{table}'] = connection.execute(f'SELECT count(*) FROM "{table}" WHERE thread_id=?',(tid,)).fetchone()[0]
        if name == 'state_5.sqlite':
            result[f'{name}:threads'] = connection.execute('SELECT count(*) FROM threads WHERE id=?',(tid,)).fetchone()[0]
    return result


def validate_target(request, databases):
    tid = request['threadId']
    if not UUID.fullmatch(tid) or tid in request.get('protectedIds',[]):
        raise ValueError('invalid or protected thread')
    original = Path(request['originalPath'])
    sessions = Path(request['sessionsRoot'])
    if not original.is_absolute() or '..' in original.parts or original == sessions or not original.is_relative_to(sessions):
        raise ValueError('original session outside configured root')
    deleting = request.get('phase') != 'quarantine'
    if deleting and os.path.lexists(original):
        raise ValueError('session restored or resumed')
    if request['action'] == 'delete' and os.path.lexists(request['quarantinePath']):
        raise ValueError('quarantine payload has not been deleted')
    state = databases.get('state_5.sqlite')
    row = None
    if state:
        columns = {r[1] for r in state.execute('PRAGMA table_info(threads)')}
        updated = 'MAX(COALESCE(updated_at_ms,0),updated_at*1000)' if 'updated_at_ms' in columns else 'updated_at*1000'
        row = state.execute(f'SELECT rollout_path,is_pinned,{updated} FROM threads WHERE id=?',(tid,)).fetchone()
    current = counts(databases,tid)
    if not row and any(current.values()):
        raise ValueError('history has no verifiable state binding')
    if row:
        if row[0] != str(original) or row[1]:
            raise ValueError('thread path changed or pinned')
        if deleting and row[2] > request['quarantinedAtMs']:
            raise ValueError('thread changed after quarantine')
        if state.execute('SELECT 1 FROM thread_spawn_edges WHERE parent_thread_id=? OR child_thread_id=? LIMIT 1',(tid,tid)).fetchone():
            raise ValueError('linked thread is protected')
    history = databases.get('thread_history_1.sqlite')
    if history and history.execute("SELECT 1 FROM thread_turns WHERE thread_id=? AND (status IS NULL OR status NOT IN ('completed','interrupted','failed','cancelled')) LIMIT 1",(tid,)).fetchone():
        raise ValueError('non-terminal thread turn is protected')
    return current


def compact(root, databases):
    results=[]
    for name, connection in databases.items():
        path=root/name
        before=path.stat().st_size
        deferred=False
        try:
            checkpoint=connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
            deferred=checkpoint[0]!=0
            free=connection.execute('PRAGMA freelist_count').fetchone()[0]*connection.execute('PRAGMA page_size').fetchone()[0]
            if free>=64*1024**2 and not deferred:
                if shutil.disk_usage(root).free < 2*before+1024**3:
                    deferred=True
                else:
                    connection.execute('VACUUM')
                    deferred=connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]!=0
            if connection.execute('PRAGMA quick_check').fetchone()[0]!='ok':
                raise ValueError('database integrity check failed')
        except sqlite3.OperationalError as error:
            if 'locked' not in str(error) and 'busy' not in str(error): raise
            deferred=True
        results.append({'database':name,'reclaimedBytes':max(0,before-path.stat().st_size),'deferred':deferred})
    return {'ok':True,'databases':results,'deferred':any(r['deferred'] for r in results)}


def run(request):
    action=request['action']
    if action not in {'inspect','delete','compact'}: raise ValueError('unsupported action')
    fd=anchored_directory(request['home'])
    root=Path(f'/proc/self/fd/{fd}')
    lock=None; databases={}
    try:
        if action!='inspect':
            lock=os.open('.cleanup-database.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=fd)
            s=os.fstat(lock)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid(): raise ValueError('unsafe cleanup lock')
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        databases=open_databases(root,action=='inspect')
        if action=='compact': return compact(root,databases)
        if action=='delete':
            # Hold state first: history is committed before removing the state binding.
            for connection in databases.values(): connection.execute('BEGIN IMMEDIATE')
        current=validate_target(request,databases)
        if action=='inspect': return {'ok':True,'rows':sum(current.values()),'counts':current}
        for name in reversed(tuple(TABLES)):
            connection=databases.get(name)
            if connection is None: continue
            for key in current:
                db,table=key.split(':')
                if db!=name: continue
                column='id' if table=='threads' else 'thread_id'
                connection.execute(f'DELETE FROM "{table}" WHERE {column}=?',(request['threadId'],))
            if connection.execute('PRAGMA foreign_key_check').fetchone(): raise ValueError('foreign key check failed')
            connection.commit()
        return {'ok':True,'deletedRows':sum(current.values()),'counts':current}
    finally:
        for connection in databases.values(): connection.close()
        if lock is not None: os.close(lock)
        os.close(fd)


if __name__=='__main__':
    try:
        request=json.loads(sys.stdin.read(2*1024*1024))
        print(json.dumps(run(request)))
    except Exception as error:
        print(json.dumps({'ok':False,'error':str(error)}));sys.exit(1)
