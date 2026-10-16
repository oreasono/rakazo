/** Ubuntu guest helpers. Payloads travel over stdin, never via a shell or host-side file. */
const WORKSPACE = `
import os, stat

def directory(root, relative, create=False):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, flags)
    try:
        for part in relative.split('/'):
            if not part:
                continue
            if part in ('.', '..'):
                raise ValueError('path escapes the computer workspace')
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise
`;

export const INCUS_FILE_SCRIPT = `${WORKSPACE}
import base64, json, sys, uuid
r = json.load(sys.stdin)
path = r['path']
parts = path.split('/') if path else []
if any(p in ('.', '..', '') for p in parts) or path.startswith('/'):
    raise ValueError('path escapes the computer workspace')
op = r['op']
if op == 'prepare':
    fd = directory(r['root'], '')
    os.close(fd)
    result = {}
elif op == 'list':
    fd = directory(r['root'], path)
    try:
        result = []
        for name in sorted(os.listdir(fd)):
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):
                continue
            result.append({'path': '/'.join(parts + [name]),
                'kind': 'dir' if stat.S_ISDIR(s.st_mode) else 'file',
                'size': s.st_size, 'executable': bool(s.st_mode & 0o111)})
    finally:
        os.close(fd)
else:
    if not parts:
        raise ValueError('file path is required')
    parent = directory(r['root'], '/'.join(parts[:-1]), create=op == 'write')
    try:
        if op == 'read':
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            with os.fdopen(fd, 'rb') as f:
                s = os.fstat(f.fileno())
                if not stat.S_ISREG(s.st_mode):
                    raise ValueError('not a regular file')
                if s.st_size > r['maxBytes']:
                    raise ValueError('file exceeds maxBytes')
                data = f.read(r['maxBytes'] + 1)
                if len(data) > r['maxBytes']:
                    raise ValueError('file exceeds maxBytes')
                result = {'base64': base64.b64encode(data).decode()}
        elif op == 'write':
            data = base64.b64decode(r['base64'], validate=True)
            if len(data) > r['maxBytes']:
                raise ValueError('file exceeds maxBytes')
            temp = '.rakazo-' + uuid.uuid4().hex
            try:
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o700 if r.get('executable') else 0o600, dir_fd=parent)
                with os.fdopen(fd, 'wb') as f:
                    f.write(data)
                # Replacement cannot follow a symlink or overwrite an existing hard-link target.
                os.replace(temp, parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
            finally:
                try:
                    os.unlink(temp, dir_fd=parent)
                except FileNotFoundError:
                    pass
            result = {}
        else:
            raise ValueError('unsupported file operation')
    finally:
        os.close(parent)
print(json.dumps(result))
`;

export const INCUS_EXEC_SCRIPT = `${WORKSPACE}
import json, signal, subprocess, sys, threading, time
r = json.loads(sys.stdin.readline())
fd = directory(r['root'], r['cwd'])
os.fchdir(fd)
os.close(fd)
env = dict(os.environ)
env.update(r['env'])
for name in r['unsetEnv']:
    env.pop(name, None)
p = subprocess.Popen(r['argv'], stdin=subprocess.DEVNULL, env=env, start_new_session=True)
cancelled = threading.Event()
def cancel(*_):
    cancelled.set()
def stdin_closed():
    # A daemon thread must not hold BufferedReader's lock during interpreter shutdown.
    os.read(sys.stdin.fileno(), 1)
    cancelled.set()
def kill_group(sig):
    try:
        os.killpg(p.pid, sig)
    except ProcessLookupError:
        pass
signal.signal(signal.SIGTERM, cancel)
signal.signal(signal.SIGINT, cancel)
threading.Thread(target=stdin_closed, daemon=True).start()
deadline = time.monotonic() + r['timeoutMs'] / 1000
code = None
try:
    while p.poll() is None:
        if cancelled.wait(0.02):
            code = 130
            break
        if time.monotonic() >= deadline:
            print('command timed out', file=sys.stderr, flush=True)
            code = 124
            break
    if code is None:
        code = p.returncode if p.returncode >= 0 else 128 - p.returncode
finally:
    # Stop descendants as well, including when the immediate command exits first.
    kill_group(signal.SIGKILL)
    p.wait()
sys.exit(code)
`;

/** Runs only after the durable supervisor has dropped all root credentials. */
export const INCUS_EXEC_CHILD_SCRIPT = `${WORKSPACE}
import json, sys
r = json.loads(sys.stdin.readline())
fd = directory(r['root'], r['cwd'])
os.fchdir(fd)
os.close(fd)
env = dict(os.environ)
env.update(r['env'])
for name in r['unsetEnv']:
    env.pop(name, None)
fd = os.open('/dev/null', os.O_RDONLY)
os.dup2(fd, 0)
if fd != 0:
    os.close(fd)
os.execvpe(r['argv'][0], r['argv'], env)
`;
