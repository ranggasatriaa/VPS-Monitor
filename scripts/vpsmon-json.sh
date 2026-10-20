#!/usr/bin/env bash
# vpsmon-json.sh — same collection as vpsmon.sh, but prints one JSON object per
# line (NDJSON) every tick, for the VPS Monitor desktop app.
#
#   vpsmon-json.sh            one line every 2 seconds until stdout closes
#   vpsmon-json.sh 5          one line every 5 seconds
#   vpsmon-json.sh --once     a single line, then exit
#
# Environment:
#   VPSMON_DB    Laravel queue database (table jobs). Empty = skip the queue check.
#   VPSMON_SKIP  comma-separated module labels to not monitor.
#   VPSMON_CONF  modules file with "label|systemd unit" lines; replaces the
#                built-in list. Default: ~/.vpsmon/modules.conf
#
# CPU% = percent of the WHOLE VPS (all cores): busy + iowait + idle + steal ≈ 100.
# Memory/swap/disk values are raw bytes.
#
# Same low-CPU approach as vpsmon.sh: the main loop only uses bash builtins and
# reads /proc + cgroup files directly. Unit state/disk refresh every SLOW_EVERY
# seconds, the queue (psql) every QUEUE_EVERY seconds.

set -u
INTERVAL=2; ONCE=0
if [[ "${1:-}" == "--once" ]]; then ONCE=1; elif [[ -n "${1:-}" ]]; then INTERVAL="$1"; fi
[[ $INTERVAL =~ ^[0-9]+(\.[0-9]+)?$ ]] || INTERVAL=2
SLOW_EVERY=10             # seconds: unit state + disk
QUEUE_EVERY=10            # seconds: queued job count (psql)
DB=${VPSMON_DB-peta_hukum_qa}
CONF=${VPSMON_CONF:-$HOME/.vpsmon/modules.conf}
CG=/sys/fs/cgroup
SKIP=",${VPSMON_SKIP-},"   # comma-separated module labels to leave out
NCPU=0; while read -r k _; do [[ $k == cpu[0-9]* ]] && NCPU=$((NCPU + 1)); done < /proc/stat
((NCPU > 0)) || NCPU=1

# label | systemd unit  (units missing on this server are skipped automatically)
MODULES=(
  "smartsearch|smartsearch.service"
  "chatbot|petahukum-chatbot.service"
  "embed|petahukum-embed.service"
  "queue|petahukum-queue.service"
  "php-fpm|php8.4-fpm.service"
  "nginx|nginx.service"
  "postgres|postgresql@16-main.service"
  "redis|redis-server.service"
  "ollama|ollama.service"
  "netdata|netdata.service"
  "docker|docker.service"
  "monarx|monarx-agent.service"
  "postfix|postfix@-.service"
  "fail2ban|fail2ban.service"
)
if [[ -r $CONF ]]; then
  CONF_MODULES=()
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%%#*}; line=${line//[[:space:]]/}
    [[ $line == ?*'|'?* ]] && CONF_MODULES+=("$line")
  done < "$CONF"
  ((${#CONF_MODULES[@]})) && MODULES=("${CONF_MODULES[@]}")
fi

trap 'exit 0' HUP INT TERM

# --- resolve each module's cgroup once (one systemctl call) -------------------
ALL_UNITS=(); for m in "${MODULES[@]}"; do ALL_UNITS+=("${m#*|}"); done
declare -A LOADED CGROUP
id='' ls='' cgv=''
while IFS='=' read -r k v || [[ -n $id ]]; do
  case $k in
    Id) id=$v;; LoadState) ls=$v;; ControlGroup) cgv=$v;;
    '') [[ -n $id ]] && { LOADED[$id]=$ls; CGROUP[$id]=$cgv; }; id='' ls='' cgv='';;
  esac
done < <(systemctl show -p Id -p LoadState -p ControlGroup "${ALL_UNITS[@]}" 2>/dev/null; echo)
LABELS=() UNITS=() PATTERNS=()
for m in "${MODULES[@]}"; do
  label=${m%%|*} unit=${m#*|}
  [[ $SKIP == *",$label,"* ]] && continue
  [[ ${LOADED[$unit]:-} == loaded ]] || continue
  # a stopped unit has no ControlGroup; keep the default path so its numbers
  # come back as soon as the unit starts again.
  cg=${CGROUP[$unit]:-}; [[ -n $cg ]] || cg="/system.slice/$unit"
  LABELS+=("$label") UNITS+=("$unit") PATTERNS+=("$CG$cg")
done
# pseudo-modules: docker containers & SSH/user sessions
[[ $SKIP == *",containers,"* ]] || { LABELS+=("containers") UNITS+=("") PATTERNS+=("$CG/system.slice/docker-*.scope"); }
[[ $SKIP == *",ssh/users,"* ]]  || { LABELS+=("ssh/users")  UNITS+=("") PATTERNS+=("$CG/user.slice"); }
UNIT_LIST=(); for u in "${UNITS[@]}"; do [[ -n $u ]] && UNIT_LIST+=("$u"); done

# --- fork-free helpers: results go to globals ---------------------------------
cpu_usec() {  # $1 = glob -> V = total usage_usec
  local d k v; V=0
  for d in $1; do
    [[ -r $d/cpu.stat ]] || continue
    while read -r k v; do [[ $k == usage_usec ]] && { V=$((V + v)); break; }; done < "$d/cpu.stat"
  done
}
cg_val() {    # $1 = glob, $2 = file -> V = sum of values
  local d v; V=0
  for d in $1; do
    [[ -r $d/$2 ]] || continue
    read -r v < "$d/$2"; [[ $v =~ ^[0-9]+$ ]] && V=$((V + v))
  done
}
read_stat() { # cpu line of /proc/stat -> S_TOT S_IDLE S_IO S_ST
  local _ us ni sy id io irq sirq st
  read -r _ us ni sy id io irq sirq st _ < /proc/stat
  S_TOT=$((us + ni + sy + id + io + irq + sirq + st)) S_IDLE=$id S_IO=$io S_ST=$st
}
pct() { printf -v PV '%d.%d' $(($1 / 10)) $(($1 % 10)); }   # tenths -> PV "12.3"
json_str() {  # $1 -> JS (quoted JSON string)
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/ }; s=${s//$'\n'/ }; s=${s//$'\r'/}
  JS="\"$s\""
}

# total jobs, running jobs, and the 3 most common job types
JOBS_SQL="select (select count(*) from jobs), (select count(*) from jobs where reserved_at is not null),
  coalesce((select string_agg(n || ' x' || c, ', ') from (select substring(payload::json->>'displayName' from '[^\\\\]+\$') n, count(*) c
  from jobs group by 1 order by 2 desc limit 3) t), '')"

# --- slow data (forks, but rarely) --------------------------------------------
declare -A STATE
DISK_SIZE=0 DISK_USED=0 DISK_PCT=0
refresh_slow() {
  local i=0 s
  if ((${#UNIT_LIST[@]})); then
    while read -r s; do STATE[${UNIT_LIST[$i]}]=$s; i=$((i + 1)); done < <(systemctl is-active "${UNIT_LIST[@]}" 2>/dev/null)
  fi
  local _ size used pc
  { read -r _; read -r _ size used _ pc _; } < <(df -B1 / 2>/dev/null)
  [[ ${size:-} =~ ^[0-9]+$ ]] && DISK_SIZE=$size
  [[ ${used:-} =~ ^[0-9]+$ ]] && DISK_USED=$used
  pc=${pc%\%}; [[ ${pc:-} =~ ^[0-9]+$ ]] && DISK_PCT=$pc
}
QN=''
refresh_queue() {
  QN=''
  [[ -n $DB ]] || return
  local q; q=$(timeout 3 runuser -u postgres -- psql -d "$DB" -AtF'|' -c "$JOBS_SQL" 2>/dev/null)
  [[ -n $q ]] && IFS='|' read -r QN QR QTOP <<< "$q"
  [[ $QN =~ ^[0-9]+$ ]] || QN=''
}

# --- loop ---------------------------------------------------------------------
declare -a C_NOW C_PREV
snapshot() {
  T_NOW=${EPOCHREALTIME/./}
  read_stat
  local i; for i in "${!PATTERNS[@]}"; do cpu_usec "${PATTERNS[$i]}"; C_NOW[$i]=$V; done
}

json_str "${HOSTNAME:-$(uname -n)}"; HOST_JS=$JS
# fd for waiting without forking `sleep`: read -t on an empty pipe is a plain pause
exec {WFD}<> <(:)

snapshot
refresh_slow; refresh_queue
LAST_SLOW=$SECONDS LAST_QUEUE=$SECONDS
read -rt 1 -u "$WFD"            # 1s warm-up sample for the first delta

while true; do
  T_PREV=$T_NOW P_TOT=$S_TOT P_IDLE=$S_IDLE P_IO=$S_IO P_ST=$S_ST
  C_PREV=("${C_NOW[@]}")
  snapshot
  ((SECONDS - LAST_SLOW  >= SLOW_EVERY))  && { refresh_slow;  LAST_SLOW=$SECONDS; }
  ((SECONDS - LAST_QUEUE >= QUEUE_EVERY)) && { refresh_queue; LAST_QUEUE=$SECONDS; }

  dt=$((T_NOW - T_PREV)); ((dt > 0)) || dt=1
  dtot=$((S_TOT - P_TOT)); ((dtot > 0)) || dtot=1
  idle10=$(( (S_IDLE - P_IDLE) * 1000 / dtot ))
  io10=$((   (S_IO   - P_IO)   * 1000 / dtot ))
  st10=$((   (S_ST   - P_ST)   * 1000 / dtot ))
  busy10=$(( 1000 - idle10 - io10 - st10 )); ((busy10 < 0)) && busy10=0

  # modules
  MJ='' tracked10=0
  for i in "${!PATTERNS[@]}"; do
    c10=$(( (C_NOW[$i] - C_PREV[$i]) * 1000 / (dt * NCPU) )); ((c10 < 0)) && c10=0
    p=${PATTERNS[$i]}
    cg_val "$p" pids.current; tasks=$V
    [[ ${LABELS[$i]} == containers ]] && ((tasks == 0)) && continue
    tracked10=$((tracked10 + c10))
    if [[ -n ${UNITS[$i]} ]]; then state=${STATE[${UNITS[$i]}]:-unknown}; else state=-; fi
    cg_val "$p" memory.current; mem=$V
    cg_val "$p" memory.swap.current; swp=$V
    pct $c10
    json_str "${LABELS[$i]}"; nm=$JS
    json_str "${UNITS[$i]}"; un=$JS
    json_str "$state"; stj=$JS
    MJ+="${MJ:+,}{\"name\":$nm,\"unit\":$un,\"state\":$stj,\"cpu\":$PV,\"mem\":$mem,\"swap\":$swp,\"tasks\":$tasks}"
  done
  other10=$((busy10 - tracked10)); ((other10 < 0)) && other10=0

  read -r l1 l5 l15 _ < /proc/loadavg
  mt=0 ma=0 stt=0 sf=0
  while read -r k v _; do
    case $k in MemTotal:) mt=$v;; MemAvailable:) ma=$v;; SwapTotal:) stt=$v;; SwapFree:) sf=$v;; esac
  done < /proc/meminfo

  pct $busy10; pb=$PV; pct $io10; pio=$PV; pct $idle10; pid=$PV; pct $st10; pst=$PV; pct $other10; po=$PV
  if [[ -n $QN ]]; then
    json_str "${QTOP:-}"
    QJ="{\"pending\":$QN,\"running\":${QR:-0},\"top\":$JS}"
  else
    QJ=null
  fi

  printf '{"v":1,"t":%d,"host":%s,"ncpu":%d,"interval":%s,"load":[%s,%s,%s],"cpu":{"busy":%s,"iowait":%s,"idle":%s,"steal":%s},"mem":{"total":%d,"used":%d,"avail":%d},"swap":{"total":%d,"used":%d},"disk":{"size":%d,"used":%d,"pct":%d},"modules":[%s],"other":%s,"queue":%s}\n' \
    $((T_NOW / 1000)) "$HOST_JS" "$NCPU" "$INTERVAL" "$l1" "$l5" "$l15" \
    "$pb" "$pio" "$pid" "$pst" \
    $((mt * 1024)) $(((mt - ma) * 1024)) $((ma * 1024)) \
    $((stt * 1024)) $(((stt - sf) * 1024)) \
    "$DISK_SIZE" "$DISK_USED" "$DISK_PCT" \
    "$MJ" "$po" "$QJ" || exit 0

  ((ONCE)) && exit 0
  read -rt "$INTERVAL" -u "$WFD"
done
