#!/usr/bin/env python3
"""Install this fixed program outside model writable roots; never execute an artifact script."""
import argparse
import hashlib
import hmac
import json
import os
import stat


def directory(path):
    if not os.path.isabs(path):
        raise ValueError('Absolute root required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise ValueError('Invalid directory component')
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_at(parent, name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError('Unsafe control file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        after = os.fstat(fd)
        if len(data) != before.st_size or (before.st_mtime_ns, before.st_ctime_ns) != (after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Control file changed')
        return data
    finally:
        os.close(fd)


def inside(file, root):
    return file != root and os.path.commonpath((file, root)) == root


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--control-dir', default='/var/lib/codex-telegram-bot-control')
    parser.add_argument('--id', required=True)
    args = parser.parse_args()
    if not all(c.isascii() and (c.isalnum() or c in '_-') for c in args.id):
        raise ValueError('Invalid record ID')
    control = directory(args.control_dir)
    opened = []
    try:
        envelope = json.loads(read_at(control, args.id + '.json', 16 * 1024 * 1024))
        key = read_at(control, 'approval.key', 32)
        body = envelope['body'].encode()
        if not hmac.compare_digest(hmac.new(key, body, hashlib.sha256).hexdigest(), envelope['mac']):
            raise ValueError('Restore approval authentication failed')
        record = json.loads(body)
        if record['kind'] != 'cleanup-restore-v1' or record['id'] != args.id:
            raise ValueError('Wrong restore approval')
        manifest_parent = directory(os.path.dirname(record['manifest']))
        try:
            manifest = read_at(manifest_parent, os.path.basename(record['manifest']), 16 * 1024 * 1024)
        finally:
            os.close(manifest_parent)
        if hashlib.sha256(manifest).hexdigest() != record['manifestSha256']:
            raise ValueError('Manifest changed after cleanup')
        # Validate every operation before the first mutation; permanent deletes
        # have no payload and cannot be restored.
        for op in record['operations']:
            if op['type'] != 'quarantine':
                continue
            if not inside(op['to'], op['quarantineRoot']) or not inside(op['from'], op['sessionsRoot']):
                raise ValueError('Restore path outside approved roots')
            source = directory(os.path.dirname(op['to']))
            opened.append(source)
            target = directory(os.path.dirname(op['from']))
            opened.append(target)
            name = os.path.basename(op['to'])
            before = os.stat(name, dir_fd=source, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or str(before.st_dev) != op['identity']['dev'] or str(before.st_ino) != op['identity']['ino']:
                raise ValueError('Quarantine identity changed')
            op['_source'], op['_target'] = source, target
        # This exclusive claim is retained even after a crash; inspect partial
        # restores explicitly rather than repeating uncertain file operations.
        claim = os.open(args.id + '.restore-claimed', os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600, dir_fd=control)
        os.close(claim)
        for op in record['operations']:
            if op['type'] != 'quarantine':
                continue
            source, target = op['_source'], op['_target']
            name, dest = os.path.basename(op['to']), os.path.basename(op['from'])
            os.link(name, dest, src_dir_fd=source, dst_dir_fd=target, follow_symlinks=False)
            after = os.stat(dest, dir_fd=target, follow_symlinks=False)
            if not stat.S_ISREG(after.st_mode) or str(after.st_dev) != op['identity']['dev'] or str(after.st_ino) != op['identity']['ino']:
                os.unlink(dest, dir_fd=target)
                raise ValueError('Quarantine changed during restore')
            current = os.stat(name, dir_fd=source, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
                raise ValueError('Quarantine entry replaced during restore')
            os.unlink(name, dir_fd=source)
        complete = os.open(args.id + '.restore-complete', os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o600, dir_fd=control)
        os.close(complete)
        print('Restore completed; receipt is single use.')
    finally:
        for fd in opened:
            os.close(fd)
        os.close(control)


if __name__ == '__main__':
    main()
