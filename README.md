# VPS Monitor

**Live CPU and RAM charts for each systemd service on several VPSes, with nothing to install on the servers.**

VPS Monitor is a small desktop app (Electron + Chart.js). It connects to your servers over plain SSH and runs one fork-free bash script. Every few seconds it charts:

- CPU busy / iowait / steal, load, RAM, swap and disk
- CPU, RAM, swap and task count for **each systemd service**, read from cgroups so worker processes count too (php-fpm, uvicorn, postgres, …)
- the Laravel queue backlog (optional)

You don't install an agent or a database, open any port, or set up a web dashboard on the server. The app uploads a ~9 KB script to `~/.vpsmon/`, and the script stops as soon as you disconnect.

## Footprint

Measured over 2 minutes with 14 services at the default 2s interval:

| | VPS Monitor (`vpsmon-json.sh`) |
|---|---|
| CPU | **≈1.4% of one core** (≈27 ms per sample). Add ≈0.3–0.6% if the queue check (psql every 10s) is on |
| RAM | **≈8 MB** (bash), plus ≈5–10 MB for the sshd session |
| Network | ≈1 KB/s to your desktop |
| Disk on server | ≈9 KB (the script). No history is stored on the server; history lives in the app |
| Runs when | Only while the app is connected |

At a 5s interval the CPU use drops to ≈0.6% of one core. On a 2-vCPU VPS, ≈1.4% of one core shows up as ≈0.7% total CPU.

### Compared with other popular open-source monitors

These are approximate figures from public docs, guides and reviews. They vary with the version, the configuration and the number of metrics collected, so measure on your own host before relying on them.

| Tool | What runs on the VPS | Typical RAM | Typical CPU | Always running | Per-service breakdown |
|---|---|---|---|---|---|
| **VPS Monitor** | bash script over SSH | ~8 MB (+ sshd) | ~1–2% of 1 core | No, only while connected | Yes, by systemd unit (cgroup) |
| [Netdata](https://www.netdata.cloud/) | Agent with built-in database and web UI | 100–200 MB idle, 250–350 MB in production¹ | 1–5% of 1 core, up to 5–20% in production¹ | Yes | Yes (cgroups, apps) |
| [Beszel](https://beszel.dev/) | Go agent (+ a hub somewhere) | ~10–25 MB² | low, <2% reported² | Yes | Docker containers |
| [Glances](https://nicolargo.github.io/glances/) (`-w` web mode) | Python process + web server | ~25–60 MB³ | a few % of 1 core | Yes | Processes, containers |
| [Prometheus node_exporter](https://github.com/prometheus/node_exporter) | Go exporter (+ Prometheus + Grafana elsewhere) | a few tens of MB⁴ | low single-digit % | Yes | Host-level only by default |

¹ Netdata hardware requirements summary ([source](https://shop.zimaspace.com/de/pages/netdata-hardware-requirements)). Default retention also uses roughly 4 GiB of disk.
² RamNode Beszel guide and user reports ([1](https://ramnode.com/guides/beszel), [2](https://akashrajpurohit.com/blog/beszel-selfhosted-server-monitoring-solution/)).
³ Process RSS shown in a systemd setup guide ([source](https://www.howtoforge.com/how-to-install-glances-monitoring-tool-on-ubuntu-22-04)). Grows with plugins and connected clients.
⁴ Typical community numbers. The exporter reports its own usage via `process_resident_memory_bytes`.

**What this tool trades away:** nothing is collected while the app is closed. There are no alerts, and no history beyond the last hour held in the desktop app. If you need 24/7 history or alerting, use Netdata, Beszel or Prometheus. VPS Monitor is for "show me right now which service is eating my small VPS" with close to zero overhead.

## Quick start

```bash
npm install
npm start        # real servers
npm run mock     # 3 fake servers, no SSH (UI development)
npm run dist     # Windows installer in dist/
```

## How it works
- Each server gets its own SSH session (private-key auth). On connect the app uploads `vpsmon-json.sh` to `~/.vpsmon/` (only when it changed) and runs it. The script prints one JSON line per tick, and the app plots every line it receives.
- If the connection drops, that server reconnects on its own (2s → 30s backoff). The other servers keep running.
- The first host key seen for a server is saved (trust on first use). If the key changes later, the app refuses to connect until you click **Forget** in the server settings.
- A key passphrase is kept in memory only and is never written to disk.
- Profiles are saved in `%APPDATA%/vps-monitor/config.json`.

## Server settings
- **Use sudo**: the queue count reads Postgres via `runuser -u postgres`, which needs root. Either connect as root, or turn this on for a user with passwordless sudo. The app runs `sudo -n env VPSMON_DB=… VPSMON_CONF=… bash ~/.vpsmon/vpsmon-json.sh <interval>`. Don't allow `NOPASSWD` for `env` or `bash` in general: either one lets the user run any command as root. Without root, every other metric still works; only the queue shows n/a.
- **Queue database**: the Laravel database that holds the `jobs` table. Leave it empty on servers without a queue.
- **Modules**: one `label|unit.service` per line. This replaces the built-in module list and is written to `~/.vpsmon/modules.conf`. Leave it empty to use the built-in list. Units that aren't installed on a server are skipped automatically.

## Script on its own
```bash
ssh user@vps 'bash -s 2' < scripts/vpsmon-json.sh      # stream, 2s interval
ssh user@vps 'bash -s -- --once' < scripts/vpsmon-json.sh
```
