// Interactive SSH shell for one server, shown in its own terminal window.
// Uses its own connection so it never disturbs the monitoring stream.
const { EventEmitter } = require('events');
const { Client } = require('ssh2');
const { loadKey, fingerprint, FatalError } = require('./ssh');

class TerminalSession extends EventEmitter {
  /**
   * @param {object} profile   server profile from config
   * @param {object} opts      { getPassphrase(): string|undefined, onHostKey(fp) }
   * Events: 'ready', 'data' (string), 'exit' ({ message, code }) — emitted once.
   */
  constructor(profile, opts) {
    super();
    this.profile = profile;
    this.opts = opts;
    this.conn = null;
    this.stream = null;
    this.size = { cols: 80, rows: 24 };
    this.ended = false;
  }

  start(cols, rows) {
    this.size = { cols: cols || 80, rows: rows || 24 };
    const p = this.profile;
    let key;
    try { key = loadKey(p, this.opts.getPassphrase()); } catch (e) { return this._end(e.message, e.code); }

    this.emit('data', `\x1b[90mConnecting to ${p.username}@${p.host}:${p.port || 22}…\x1b[0m\r\n`);
    const conn = new Client();
    this.conn = conn;
    let hostKeyError = null;
    conn
      .on('ready', () => {
        conn.shell({ term: 'xterm-256color', ...this.size }, (err, stream) => {
          if (err) { this._end(`Cannot open shell: ${err.message}`); return; }
          this.stream = stream;
          this.emit('ready');
          stream.on('data', (d) => this.emit('data', d.toString('utf8')));
          stream.stderr.on('data', (d) => this.emit('data', d.toString('utf8')));
          stream.on('close', () => this._end('Session closed'));
        });
      })
      .on('error', (e) => {
        if (hostKeyError) e = hostKeyError;
        else if (e.level === 'client-authentication') e = new FatalError('Authentication failed (key not accepted)', 'AUTH');
        this._end(e.message, e.code);
      })
      .on('close', () => this._end('Connection closed'))
      .connect({
        host: p.host,
        port: Number(p.port) || 22,
        username: p.username,
        privateKey: key.buf,
        passphrase: key.passphrase,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        // same trust-on-first-use rule as the monitoring session
        hostVerifier: (hostKey) => {
          const fp = fingerprint(hostKey);
          if (!p.hostKey) { this.opts.onHostKey(fp); p.hostKey = fp; return true; }
          if (p.hostKey === fp) return true;
          hostKeyError = new FatalError(`Host key changed! expected ${p.hostKey}, got ${fp}. Refusing to connect.`, 'HOSTKEY');
          return false;
        },
      });
  }

  write(data) {
    if (this.stream) this.stream.write(data);
  }

  resize(cols, rows) {
    this.size = { cols, rows };
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }

  stop() {
    this.ended = true;
    if (this.conn) this.conn.end();
    this.conn = null;
    this.stream = null;
  }

  _end(message, code) {
    if (this.ended) return;
    this.ended = true;
    if (this.conn) this.conn.end();
    this.conn = null;
    this.stream = null;
    this.emit('exit', { message, code });
  }
}

module.exports = { TerminalSession };
