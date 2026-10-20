// Fake data source for `npm run mock`: emits the same NDJSON shape as
// vpsmon-json.sh so the UI can be developed without a real VPS.
const { EventEmitter } = require('events');

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MODULES = [
  ['smartsearch', 'smartsearch.service'], ['chatbot', 'petahukum-chatbot.service'],
  ['embed', 'petahukum-embed.service'], ['queue', 'petahukum-queue.service'],
  ['php-fpm', 'php8.4-fpm.service'], ['nginx', 'nginx.service'],
  ['postgres', 'postgresql@16-main.service'], ['redis', 'redis-server.service'],
  ['ollama', 'ollama.service'], ['netdata', 'netdata.service'],
  ['fail2ban', 'fail2ban.service'], ['ssh/users', ''],
];

function mockProfiles() {
  const base = { port: 22, username: 'root', privateKeyPath: '(mock)', useSudo: false, interval: 2, db: 'peta_hukum_qa', modulesConf: '', autoConnect: true, hostKey: '' };
  return [
    { id: 'mock-prod', name: 'prod-app', host: '10.0.0.11', color: '#3987e5', ...base },
    { id: 'mock-qa', name: 'qa-app', host: '10.0.0.12', color: '#d95926', ...base },
    { id: 'mock-flaky', name: 'worker (flaky)', host: '10.0.0.13', color: '#199e70', ...base, db: '' },
  ];
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;

class MockSession extends EventEmitter {
  constructor(profile) {
    super();
    this.profile = profile;
    this.flaky = /flaky/i.test(profile.name);
    this.timer = null;
    this.tick = 0;
    this.ncpu = this.flaky ? 2 : 4;
    this.memTotal = (this.flaky ? 4 : 16) * GB;
    this.walk = Object.fromEntries(MODULES.map(([n], i) => [n, { cpu: Math.random() * (i < 4 ? 8 : 3), mem: (50 + Math.random() * 900) * MB * (this.memTotal / (16 * GB)) }]));
    this.queue = 40;
  }

  start() {
    clearTimeout(this.timer);
    this.emit('status', { state: 'connecting', message: `${this.profile.username}@${this.profile.host}` });
    this.timer = setTimeout(() => {
      this.emit('status', { state: 'streaming', message: '' });
      this._loop();
    }, 700);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.emit('status', { state: 'stopped', message: '' });
  }

  _loop() {
    const ms = (Number(this.profile.interval) || 2) * 1000;
    this.timer = setTimeout(() => {
      this.tick++;
      // the flaky server drops its connection for ~6s every ~40s
      if (this.flaky && this.tick % 20 === 0) {
        this.emit('log', 'error: Connection lost (mock)');
        this.emit('status', { state: 'reconnecting', message: 'retry in 2s — Connection lost (mock)' });
        this.timer = setTimeout(() => this.start(), 6000);
        return;
      }
      this.emit('sample', this.sample());
      this._loop();
    }, ms);
  }

  sample() {
    let tracked = 0;
    const off = this.profile.disabledModules || [];
    const modules = MODULES.filter(([name]) => !off.includes(name)).map(([name, unit]) => {
      const w = this.walk[name];
      const spike = Math.random() < 0.03 ? 25 * Math.random() : 0;
      w.cpu = clamp(w.cpu + (Math.random() - 0.5) * 2, 0, 30);
      w.mem = clamp(w.mem + (Math.random() - 0.5) * 20 * MB, 20 * MB, this.memTotal / 6);
      const cpu = r1(Math.min(60, w.cpu + spike));
      tracked += cpu;
      const state = name === 'embed' && this.flaky ? 'inactive' : unit ? 'active' : '-';
      return { name, unit, state, cpu, mem: Math.round(w.mem), swap: name === 'ollama' ? 120 * MB : 0, tasks: 2 + Math.round(Math.random() * 30) };
    });
    const other = r1(1 + Math.random() * 3);
    const busy = r1(clamp(tracked + other, 0, 100));
    const iowait = r1(Math.random() * 3);
    const steal = r1(this.flaky ? 10 + Math.random() * 25 : Math.random() * 2);
    const used = modules.reduce((a, m) => a + m.mem, 0) + 0.8 * GB;
    this.queue = Math.max(0, Math.round(this.queue + (Math.random() - 0.45) * 15));
    const l1 = r1((busy / 100) * this.ncpu + Math.random() * 0.3);
    return {
      v: 1, t: Date.now(), host: this.profile.name, ncpu: this.ncpu, interval: Number(this.profile.interval) || 2,
      load: [l1, r1(l1 * 0.9), r1(l1 * 0.8)],
      cpu: { busy, iowait, idle: r1(Math.max(0, 100 - busy - iowait - steal)), steal },
      mem: { total: this.memTotal, used: Math.min(used, this.memTotal), avail: Math.max(0, this.memTotal - used) },
      swap: { total: 2 * GB, used: 140 * MB },
      disk: { size: 80 * GB, used: 41 * GB, pct: 52 },
      modules, other,
      queue: this.profile.db ? { pending: this.queue, running: Math.min(this.queue, 2), top: `SendMail x${Math.round(this.queue * 0.6)}, IndexDocument x${Math.round(this.queue * 0.3)}` } : null,
    };
  }
}

module.exports = { MockSession, mockProfiles };
