// One SSH session per VPS: connect with a private key, upload vpsmon-json.sh,
// run it and turn its NDJSON stdout into 'sample' events. Reconnects on drop.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const { Client, utils } = require('ssh2');

const MIN_BACKOFF = 2000;
const MAX_BACKOFF = 30000;

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fingerprint = (keyBuf) => 'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');

// Errors that won't fix themselves by retrying: stop instead of hammering the server.
class FatalError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res))));
}

// Read and parse the profile's private key; throws FatalError when retrying won't help.
function loadKey(p, passphrase) {
  if (!p.privateKeyPath) throw new FatalError('No private key file set', 'NO_KEY');
  let buf;
  try { buf = fs.readFileSync(p.privateKeyPath); } catch (e) {
    throw new FatalError(`Cannot read key file: ${e.message}`, 'NO_KEY');
  }
  const parsed = utils.parseKey(buf, passphrase);
  if (parsed instanceof Error) {
    if (/passphrase|encrypted|decrypt/i.test(parsed.message)) {
      throw new FatalError(passphrase ? 'Wrong key passphrase' : 'Key is encrypted: passphrase needed', 'NEED_PASSPHRASE');
    }
    throw new FatalError(`Unsupported key: ${parsed.message}`, 'BAD_KEY');
  }
  return { buf, passphrase };
}

class VpsSession extends EventEmitter {
  /**
   * @param {object} profile   server profile from config
   * @param {object} opts      { script: Buffer, getPassphrase(): string|undefined, onHostKey(fp) }
   */
  constructor(profile, opts) {
    super();
    this.profile = profile;
    this.opts = opts;
    this.state = 'stopped';
    this.stopped = true;
    this.conn = null;
    this.timer = null;
    this.attempt = 0;
    this.lastError = '';
    this.stderrTail = '';
  }

  setState(state, message = '') {
    this.state = state;
    this.emit('status', { state, message });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.conn) this.conn.end();
    this.conn = null;
    this.setState('stopped');
  }

  // --- internals ---------------------------------------------------------------
  _loadKey() { return loadKey(this.profile, this.opts.getPassphrase()); }

  _connect() {
    clearTimeout(this.timer);
    this.timer = null;
    this.setState('connecting', `${this.profile.username}@${this.profile.host}:${this.profile.port || 22}`);
    let key;
    try { key = this._loadKey(); } catch (e) { return this._fail(e); }

    const conn = new Client();
    this.conn = conn;
    this.stderrTail = '';
    let hostKeyError = null;
    conn
      .on('ready', () => this._onReady(conn))
      .on('error', (e) => {
        if (hostKeyError) e = hostKeyError;
        else if (e.level === 'client-authentication') e = new FatalError('Authentication failed (key not accepted)', 'AUTH');
        this._fail(e);
      })
      .on('close', () => this._onClose(conn))
      .connect({
        host: this.profile.host,
        port: Number(this.profile.port) || 22,
        username: this.profile.username,
        privateKey: key.buf,
        passphrase: key.passphrase,
        readyTimeout: 15000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        // trust on first use: remember the host key, refuse if it changes later
        hostVerifier: (hostKey) => {
          const fp = fingerprint(hostKey);
          if (!this.profile.hostKey) { this.opts.onHostKey(fp); this.profile.hostKey = fp; return true; }
          if (this.profile.hostKey === fp) return true;
          hostKeyError = new FatalError(`Host key changed! expected ${this.profile.hostKey}, got ${fp}. Forget the host key in the server settings only if you trust this change.`, 'HOSTKEY');
          return false;
        },
      });
  }

  async _onReady(conn) {
    if (conn !== this.conn) return;
    try {
      const paths = await this._deploy(conn);
      this._exec(conn, paths);
    } catch (e) {
      this._fail(e);
      conn.end();
    }
  }

  async _deploy(conn) {
    const sftp = await new Promise((res, rej) => conn.sftp((err, s) => (err ? rej(err) : res(s))));
    try {
      const home = await sftpCall(sftp, 'realpath', '.');
      const dir = `${home}/.vpsmon`;
      const script = `${dir}/vpsmon-json.sh`;
      const conf = `${dir}/modules.conf`;
      try { await sftpCall(sftp, 'mkdir', dir); } catch { /* already exists */ }
      let remote = null;
      try { remote = await sftpCall(sftp, 'readFile', script); } catch { /* not uploaded yet */ }
      if (!remote || !remote.equals(this.opts.script)) {
        await sftpCall(sftp, 'writeFile', script, this.opts.script);
        this.emit('log', `uploaded ${script}`);
      }
      await sftpCall(sftp, 'chmod', script, 0o755);
      // only write modules.conf when the profile has one, so a hand-made file on the server is respected
      const mc = (this.profile.modulesConf || '').trim();
      if (mc) await sftpCall(sftp, 'writeFile', conf, Buffer.from(mc + '\n'));
      return { script, conf };
    } finally {
      sftp.end();
    }
  }

  _command(paths, once) {
    const p = this.profile;
    const interval = Math.min(60, Math.max(1, Number(p.interval) || 2));
    const skip = (p.disabledModules || []).join(',');
    return `${p.useSudo ? 'sudo -n ' : ''}env VPSMON_DB=${shq(p.db ?? '')} VPSMON_SKIP=${shq(skip)} VPSMON_CONF=${shq(paths.conf)} bash ${shq(paths.script)} ${once ? '--once' : interval}`;
  }

  _exec(conn, paths) {
    conn.exec(this._command(paths, false), (err, stream) => {
      if (err) { this._fail(err); conn.end(); return; }
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let data;
          try { data = JSON.parse(line); } catch {
            this.emit('log', `unparsable line: ${line.slice(0, 200)}`);
            continue;
          }
          if (this.state !== 'streaming') { this.attempt = 0; this.setState('streaming'); }
          this.emit('sample', data);
        }
      });
      stream.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        this.stderrTail = (this.stderrTail + text).slice(-500);
        text.split('\n').filter(Boolean).forEach((l) => this.emit('log', `stderr: ${l}`));
      });
      stream.on('close', (code) => {
        if (this.stopped || conn !== this.conn) return;
        const tail = this.stderrTail.trim();
        if (/sudo:.*password/i.test(tail)) {
          this._fail(new FatalError('sudo needs a password: allow NOPASSWD for this user or turn off "Use sudo"', 'SUDO'));
        } else {
          this._fail(new Error(`script exited (code ${code})${tail ? ': ' + tail.split('\n').pop() : ''}`));
        }
        conn.end();
      });
    });
  }

  _fail(e) {
    this.lastError = e.message || String(e);
    this.emit('log', `error: ${this.lastError}`);
    if (e instanceof FatalError) {
      this.fatal = e.code;
      this.stopped = true;
      clearTimeout(this.timer);
      if (this.conn) this.conn.end();
      this.conn = null;
      this.setState(e.code === 'NEED_PASSPHRASE' ? 'needs-passphrase' : 'error', this.lastError);
    } else if (!this.conn) {
      this._scheduleReconnect();
    }
  }

  _onClose(conn) {
    if (conn !== this.conn) return;
    this.conn = null;
    if (!this.stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(MAX_BACKOFF, MIN_BACKOFF * 2 ** this.attempt);
    this.attempt++;
    this.setState('reconnecting', `retry in ${Math.round(delay / 1000)}s${this.lastError ? ' — ' + this.lastError : ''}`);
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, delay);
  }
}

// One-shot connection test: deploy, run `--once`, resolve with the parsed sample.
function testProfile(profile, opts) {
  return new Promise((resolve, reject) => {
    const s = new VpsSession({ ...profile }, opts);
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; s.stop(); fn(v); };
    s.on('sample', (d) => finish(resolve, d));
    s.on('status', ({ state, message }) => {
      if (state === 'error' || state === 'needs-passphrase' || state === 'reconnecting') {
        finish(reject, Object.assign(new Error(message.replace(/^retry in \d+s — /, '')), { state }));
      }
    });
    setTimeout(() => finish(reject, new Error('Timed out after 30s')), 30000);
    s.start();
  });
}

module.exports = { VpsSession, testProfile, fingerprint, loadKey, FatalError };
