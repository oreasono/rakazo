import { INCUS_EXEC_CHILD_SCRIPT } from "./incus-sandbox-guest.js";

/**
 * Root-only guest journal. A start record is an irrevocable reservation, even if
 * the receiver dies before forking. Only a detached lock holder may execute it.
 * No command/payload is accepted from a journal during reconciliation.
 *
 * Trust boundary: the configured guest account must have no route to guest root
 * (including passwordless sudo, privileged groups/helpers, or alternate admin
 * credentials). Root filesystem ownership cannot protect receipts from a VM
 * administrator. Provisioning must enforce this; this adapter does not change
 * image accounts, sudoers, or running instance policy.
 */
export const INCUS_DURABLE_EXEC_SCRIPT = `
import base64, fcntl, hashlib, json, os, pwd, re, selectors, signal, stat, subprocess, sys, time, urllib.parse, uuid

JOURNAL_ROOT = '/var/lib/rakazo-executions/v1'
ROOT_UID = 0
MAX_REQUEST_BYTES = 8 * 1024 * 1024
MAX_OUTPUT_BYTES = 128 * 1024 * 1024
CHILD_SCRIPT = ${JSON.stringify(INCUS_EXEC_CHILD_SCRIPT)}

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def check_owner(fd, directory=False, private=True):
    s = os.fstat(fd)
    valid_type = stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)
    if (not valid_type or s.st_uid != ROOT_UID or s.st_mode & (0o077 if private else 0o022)
            or (not directory and s.st_nlink != 1)):
        raise ValueError('unsafe execution journal')

def directory_at(parent, name, create=False, private=True):
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        # Also sync a directory created by a concurrent receiver before using it.
        os.fsync(parent)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        check_owner(fd, directory=True, private=private)
        return fd
    except BaseException:
        os.close(fd)
        raise

def journal(scope, operation, create=False):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        check_owner(fd, directory=True, private=False)
        for part in JOURNAL_ROOT.strip('/').split('/'):
            # System parents must already exist; only our private hierarchy is created.
            private = part not in ('var', 'lib')
            child = directory_at(fd, part, create=create and private, private=private)
            os.close(fd)
            fd = child
        for part in (scope, operation):
            child = directory_at(fd, part, create=create)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def open_file(parent, name, flags):
    fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
    try:
        check_owner(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise

def read_json(parent, name, limit):
    try:
        fd = open_file(parent, name, os.O_RDONLY)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as f:
        if os.fstat(f.fileno()).st_size > limit:
            raise ValueError('oversized execution journal')
        data = f.read(limit + 1)
        if len(data) > limit:
            raise ValueError('oversized execution journal')
        return json.loads(data)

def atomic_json(parent, name, value):
    temporary = '.write-' + uuid.uuid4().hex
    try:
        fd = open_file(parent, temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        with os.fdopen(fd, 'wb') as f:
            f.write(canonical(value))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass

def try_lock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False

def started_record(parent, key):
    value = read_json(parent, 'started.json', 16384)
    if value is not None:
        if (not isinstance(value, dict) or value.get('key') != key
                or not isinstance(value.get('fingerprint'), str)
                or len(value['fingerprint']) != 64):
            raise ValueError('execution journal identity mismatch')
    return value

def receipt(parent, started):
    value = read_json(parent, 'result.json', 6 * MAX_OUTPUT_BYTES + 16384)
    if value is None:
        return None
    if (started is None or not isinstance(value, dict) or value.get('started') != started
            or not isinstance(value.get('result'), dict)):
        raise ValueError('execution receipt identity mismatch')
    # Old helpers may have persisted raw output. Query has no original environment
    # with which to sanitize it; retain the reservation and require review instead.
    if value.get('redactionVersion') != 1:
        return None
    result = value['result']
    if (set(result) != {'stdout', 'stderr', 'code'}
            or not isinstance(result['stdout'], str) or not isinstance(result['stderr'], str)
            or type(result['code']) is not int or not 0 <= result['code'] <= 255
            or len(result['stdout'].encode()) + len(result['stderr'].encode()) > MAX_OUTPUT_BYTES):
        raise ValueError('invalid execution receipt')
    # A reader can observe rename before the writer's directory fsync (or after
    # that writer died). Seal that rename before acknowledging the receipt.
    os.fsync(parent)
    return {'status': 'completed', 'result': result}

def query(parent, key):
    # Opening a lock read-only and trying flock changes no persistent state.
    # Read both records under the same lock: creation/completion may race a query.
    try:
        lock = open_file(parent, 'lock', os.O_RDONLY)
    except FileNotFoundError:
        return {'status': 'unknown'}
    try:
        if not try_lock(lock):
            return {'status': 'pending'}
        return receipt(parent, started_record(parent, key)) or {'status': 'unknown'}
    finally:
        os.close(lock)

def validate_command(command):
    if not isinstance(command, dict):
        raise ValueError('invalid execution command')
    if (not isinstance(command.get('argv'), list) or not command['argv']
            or not command['argv'][0]
            or any(not isinstance(v, str) or '\\0' in v for v in command['argv'])):
        raise ValueError('invalid execution argv')
    if type(command.get('timeoutMs')) is not int or not 0 < command['timeoutMs'] <= 3600000:
        raise ValueError('invalid execution timeout')
    if type(command.get('maxOutputBytes')) is not int or not 0 < command['maxOutputBytes'] <= MAX_OUTPUT_BYTES:
        raise ValueError('invalid execution output limit')
    account = pwd.getpwnam(command['guestUser'])
    if account.pw_uid == 0:
        raise ValueError('execution requires an unprivileged guest user')
    return account

def redact_output(result, environment, limit):
    # Only values already intentionally supplied to this command enter the guest.
    # Derive the controller's plain / encodeURIComponent / UTF-8 base64 forms in
    # root memory; never persist this list or pass extra secrets to the child.
    forms = set()
    for value in environment.values():
        if isinstance(value, str) and value:
            forms.update((value, urllib.parse.quote(value, safe="-_.!~*'()"),
                          base64.b64encode(value.encode()).decode('ascii')))
    if not forms:
        return result
    text = result['stdout'] + result['stderr']
    boundary = len(result['stdout'])
    pieces = {'stdout': [], 'stderr': []}
    size = 0
    def append(kind, value):
        nonlocal size
        size += len(value.encode())
        if size > limit:
            raise ValueError('oversized redacted execution output')
        pieces[kind].append(value)
    # Look ahead to cover overlapping matches, including across the stream join.
    pattern = re.compile('(?=(' + '|'.join(re.escape(v) for v in sorted(forms, key=lambda v: (-len(v), v))) + '))')
    def plain(start, end):
        if start < boundary:
            append('stdout', text[start:min(end, boundary)])
        if end > boundary:
            append('stderr', text[max(start, boundary):end])
    cursor = 0
    span = None
    def replace(start, end):
        nonlocal cursor
        plain(cursor, start)
        append('stdout' if start < boundary else 'stderr', '[redacted]')
        cursor = end
    for match in pattern.finditer(text):
        start, end = match.start(), match.start() + len(match.group(1))
        if span is not None and start < span[1]:
            span = (span[0], max(span[1], end))
        else:
            if span is not None:
                replace(*span)
            span = (start, end)
    if span is not None:
        replace(*span)
    plain(cursor, len(text))
    return {kind: ''.join(parts) for kind, parts in pieces.items()}

def supervise(parent, lock, started, command, account):
    # The receiver/transport may disappear. Never inherit their pipes or session.
    os.setsid()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    null = os.open('/dev/null', os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    if null > 2:
        os.close(null)
    process = None
    selector = selectors.DefaultSelector()
    try:
        env = dict(os.environ)
        env.update(HOME=account.pw_dir, SHELL=account.pw_shell, USER=account.pw_name,
                   LOGNAME=account.pw_name, DISPLAY=command['display'])
        def demote():
            os.initgroups(account.pw_name, account.pw_gid)
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
        # An unlinked private input file cannot block supervision on a pipe write.
        name = '.input-' + uuid.uuid4().hex
        fd = open_file(parent, name, os.O_RDWR | os.O_CREAT | os.O_EXCL)
        os.unlink(name, dir_fd=parent)
        with os.fdopen(fd, 'w+b') as payload:
            payload.write(canonical(command) + b'\\n')
            payload.flush()
            payload.seek(0)
            process = subprocess.Popen(['/usr/bin/python3', '-I', '-c', CHILD_SCRIPT],
                stdin=payload, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=env, start_new_session=True, preexec_fn=demote, close_fds=True)
        buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        for stream, kind in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, kind)
        deadline = time.monotonic() + command['timeoutMs'] / 1000
        total = 0
        exited = False
        while selector.get_map() or process.poll() is None:
            if time.monotonic() >= deadline:
                return  # Partial/cancelled results are never completed receipts.
            if process.poll() is not None and not exited:
                exited = True
                kill_group(process)
            for event, _ in selector.select(0.02):
                data = os.read(event.fd, 65536)
                if not data:
                    selector.unregister(event.fileobj)
                    event.fileobj.close()
                    continue
                total += len(data)
                if total > command['maxOutputBytes']:
                    return
                buffers[event.data].extend(data)
        code = process.wait()
        if code < 0:
            return
        result = {kind: bytes(value).decode('utf-8', errors='replace') for kind, value in buffers.items()}
        result = redact_output(result, command['env'], command['maxOutputBytes'])
        if sum(len(value.encode()) for value in result.values()) > command['maxOutputBytes']:
            return
        result['code'] = code
        atomic_json(parent, 'result.json', {'started': started, 'redactionVersion': 1, 'result': result})
    finally:
        if process is not None:
            kill_group(process)
            process.wait()
        selector.close()
        os.close(lock)
        os.close(parent)

def kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

def execute(parent, key, command):
    account = validate_command(command)
    fingerprint = digest(command)
    lock = open_file(parent, 'lock', os.O_RDWR | os.O_CREAT)
    child = None
    try:
        locked = try_lock(lock)
        started = started_record(parent, key)
        if started is not None and started['fingerprint'] != fingerprint:
            raise ValueError('execution operationId command mismatch')
        if not locked:
            return {'status': 'pending'}
        done = receipt(parent, started)
        if done is not None:
            return done
        if started is not None:
            return {'status': 'unknown'}
        started = {'key': key, 'fingerprint': fingerprint}
        atomic_json(parent, 'started.json', started)
        # The lock, directories and start record are durable BEFORE any command can run.
        os.fsync(lock)
        os.fsync(parent)
        child = os.fork()
        if child == 0:
            try:
                supervise(parent, lock, started, command, account)
            finally:
                os._exit(0)
    finally:
        # Closing the receiver's copy does not unlock the detached child's shared flock.
        os.close(lock)
    deadline = time.monotonic() + command['timeoutMs'] / 1000 + 5
    while time.monotonic() < deadline:
        state = query(parent, key)
        if state['status'] != 'pending':
            os.waitpid(child, 0)
            return state
        time.sleep(0.02)
    return {'status': 'pending'}

def main():
    if os.geteuid() != ROOT_UID:
        raise ValueError('execution journal requires root')
    os.umask(0o077)
    os.chdir('/')
    raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError('oversized execution request')
    request = json.loads(raw)
    operation = request['operationId']
    if not isinstance(operation, str) or not operation or '\\0' in operation or len(operation.encode()) > 1024:
        raise ValueError('invalid execution operationId')
    if request['op'] not in ('execute', 'query'):
        raise ValueError('invalid execution operation')
    key = {'version': 1, 'scope': digest(request['identity']), 'operation': digest(operation)}
    try:
        parent = journal(key['scope'], key['operation'], create=request['op'] == 'execute')
    except FileNotFoundError:
        return {'status': 'unknown'}
    try:
        if request['op'] == 'query':
            return query(parent, key)
        return execute(parent, key, request['command'])
    finally:
        os.close(parent)

try:
    print(json.dumps(main()), flush=True)
except Exception as error:
    # Diagnostics never include a command, environment or captured guest output.
    print('execution operationId command mismatch' if isinstance(error, ValueError)
          and str(error) == 'execution operationId command mismatch'
          else 'durable execution journal unavailable', file=sys.stderr)
    sys.exit(1)
`;
