// Multi-server manager: keeps server profiles in config.json and one
// independent session (real SSH or mock) per server.
const fs = require('fs');
const crypto = require('crypto');
const { VpsSession, testProfile } = require('./ssh');
const { MockSession, mockProfiles } = require('./mock');

// categorical slots (dark-surface steps), assigned to new servers in fixed order
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const DEFAULTS = {
  name: '', host: '', port: 22, username: 'root', privateKeyPath: '',
  useSudo: false, interval: 2, db: '', modulesConf: '', autoConnect: false, hostKey: '',
};

class ServerManager {
  constructor({ configPath, script, mock, send }) {
    this.configPath = configPath;
    this.script = script;
    this.mock = mock;
    this.send = send;
    this.sessions = new Map();
    this.status = new Map();
    this.passphrases = new Map(); // in memory only, never written to disk
    this.config = this._load();
  }

  _load() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      if (Array.isArray(c.servers)) return c;
    } catch { /* first run */ }
    return { servers: this.mock ? mockProfiles() : [] };
  }

  _save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  _find(id) { return this.config.servers.find((s) => s.id === id); }

  list() {
    return this.config.servers.map((s) => ({ ...s, status: this.status.get(s.id) || { state: 'stopped', message: '' } }));
  }

  upsert(input) {
    const clean = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (input[k] !== undefined) clean[k] = input[k];
    clean.port = Number(clean.port) || 22;
    clean.interval = Math.min(60, Math.max(1, Number(clean.interval) || 2));
    clean.name = String(clean.name || clean.host || 'server').trim();
    let s = input.id && this._find(input.id);
    if (s) {
      const connChanged = ['host', 'port', 'username', 'privateKeyPath'].some((k) => s[k] !== clean[k]);
      if (connChanged) this.passphrases.delete(s.id);
      Object.assign(s, clean, { color: input.color || s.color });
    } else {
      s = { id: crypto.randomUUID(), ...clean, color: input.color || PALETTE[this.config.servers.length % PALETTE.length] };
      this.config.servers.push(s);
    }
    this._save();
    // restart a running session so the new settings apply
    if (this.sessions.has(s.id)) { this.disconnect(s.id); this.connect(s.id); }
    return this.list();
  }

  remove(id) {
    this.disconnect(id);
    this.sessions.delete(id);
    this.status.delete(id);
    this.passphrases.delete(id);
    this.config.servers = this.config.servers.filter((s) => s.id !== id);
    this._save();
    return this.list();
  }

  reorder(ids) {
    const byId = new Map(this.config.servers.map((s) => [s.id, s]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const s of this.config.servers) if (!ids.includes(s.id)) ordered.push(s);
    this.config.servers = ordered;
    this._save();
    return this.list();
  }

  _sessionOpts(profile) {
    return {
      script: this.script,
      getPassphrase: () => this.passphrases.get(profile.id),
      onHostKey: (fp) => {
        const s = this._find(profile.id);
        if (s) { s.hostKey = fp; this._save(); this.send('servers', this.list()); }
      },
    };
  }

  connect(id, passphrase) {
    const profile = this._find(id);
    if (!profile) return;
    if (passphrase) this.passphrases.set(id, passphrase);
    let sess = this.sessions.get(id);
    if (sess) sess.stop();
    sess = this.mock ? new MockSession(profile) : new VpsSession({ ...profile }, this._sessionOpts(profile));
    this.sessions.set(id, sess);
    sess.on('status', (st) => {
      if (this.sessions.get(id) !== sess) return;
      this.status.set(id, st);
      this.send('status', { serverId: id, ...st });
    });
    sess.on('sample', (data) => this.sessions.get(id) === sess && this.send('sample', { serverId: id, data }));
    sess.on('log', (line) => this.send('log', { serverId: id, line, t: Date.now() }));
    sess.start();
  }

  disconnect(id) {
    const sess = this.sessions.get(id);
    if (sess) sess.stop();
  }

  connectAll() { for (const s of this.config.servers) if (!this._running(s.id)) this.connect(s.id); }
  disconnectAll() { for (const id of this.sessions.keys()) this.disconnect(id); }
  connectAuto() { for (const s of this.config.servers) if (s.autoConnect) this.connect(s.id); }
  shutdown() { for (const sess of this.sessions.values()) sess.stop(); }

  _running(id) {
    const st = this.status.get(id);
    return st && ['connecting', 'streaming', 'reconnecting'].includes(st.state);
  }

  async test(input, passphrase) {
    const profile = { ...DEFAULTS, ...input };
    if (this.mock) {
      return { ok: true, sample: new MockSession(profile).sample() };
    }
    const existing = input.id && this._find(input.id);
    const pass = passphrase || (existing && this.passphrases.get(existing.id));
    try {
      const sample = await testProfile(profile, {
        script: this.script,
        getPassphrase: () => pass,
        onHostKey: (fp) => { profile.hostKey = fp; },
      });
      return { ok: true, sample, hostKey: profile.hostKey };
    } catch (e) {
      return { ok: false, error: e.message, state: e.state };
    }
  }
}

module.exports = { ServerManager };
