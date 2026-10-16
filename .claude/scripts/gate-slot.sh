#!/usr/bin/env bash
# Host-wide gate semaphore: run one quality-gate command (lint / typecheck / the
# test suite / your QUALITY_GATES command) in a CPU-disjoint slot, so concurrent
# gate runs from several checkouts or agents never oversubscribe the machine.
#
# Slot planning (pure shell, Linux):
#   usable CPUs  = the CPU ids this process may run on (Cpus_allowed_list), capped
#                  by a cgroup CPU quota (cpu.max / cpu.cfs_quota_us) when one is set
#   memory bound = the cgroup memory limit, else MemTotal
#   width        = GATE_SLOT_CPUS CPUs per slot (default 4, never more than usable)
#   slots        = min(usable / width, memory / GATE_SLOT_MEM_MB), at least 1
# GATE_SLOTS overrides the slot count (the width then becomes usable / slots).
# A pinned slot is locked CPU by CPU (one lock file per CPU id), so two runs never
# hold an overlapping CPU even if they planned different layouts; the command then
# runs under `taskset` on exactly those CPUs. Under a CFS quota (fewer CPUs than
# the affinity set) a slot still claims CPU ids from the same pool but is not
# confined to them. When CPU ids are unknown, slots are locked by index.
#
# The command sees GATE_SLOT_WORKERS (the slot width) to size its own parallelism,
# e.g. `pytest -n "$GATE_SLOT_WORKERS"`, `jest --maxWorkers="$GATE_SLOT_WORKERS"`,
# `cargo test -j "$GATE_SLOT_WORKERS"`. PYTEST_XDIST_AUTO_NUM_WORKERS is also set
# (unless already set) so `pytest -n auto` sizes to the slot.
#
# Usage: .claude/scripts/gate-slot.sh <command...>
#   GATE_LOCK_DIR    per-host lock directory; every checkout and agent must share it
#                    (default: $HOME/.cache/gate-slot-locks)
#   GATE_WAIT        seconds to wait for a free slot (default 300); on timeout exits
#                    75 = "all slots busy, re-run the same command"
#   GATE_SLOTS       force the number of slots
#   GATE_SLOT_CPUS   CPUs per slot (default 4)
#   GATE_SLOT_MEM_MB memory budget per slot in MiB (default 4096)
# Exit codes: the gated command's own code; 75 = every slot busy; 125 = the wrapper
# itself cannot run (with a "gate-slot:" line on stderr) — distinct from the small
# codes test runners use, so a red gate is never mistaken for a broken wrapper.
# Requires: bash 4.3+, flock (util-linux); taskset to pin (without it runs unpinned, warned).
set -uo pipefail

[[ $# -eq 0 ]] && { echo "gate-slot: no command given" >&2; exit 125; }

LOCK_DIR="${GATE_LOCK_DIR:-${HOME:-/tmp}/.cache/gate-slot-locks}"
WAIT="${GATE_WAIT:-300}"
SLOT_WIDTH="${GATE_SLOT_CPUS:-4}"
SLOT_MEM_MB="${GATE_SLOT_MEM_MB:-4096}"
FORCED_SLOTS="${GATE_SLOTS:-}"

for v in WAIT SLOT_WIDTH SLOT_MEM_MB; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "gate-slot: $v must be a non-negative integer" >&2; exit 125; }
done
[[ -z "$FORCED_SLOTS" || "$FORCED_SLOTS" =~ ^[1-9][0-9]*$ ]] \
  || { echo "gate-slot: GATE_SLOTS must be a positive integer" >&2; exit 125; }
(( SLOT_WIDTH >= 1 )) || SLOT_WIDTH=1
(( SLOT_MEM_MB >= 1 )) || SLOT_MEM_MB=1

command -v flock >/dev/null 2>&1 || { echo "gate-slot: flock not found (install util-linux)" >&2; exit 125; }
if ! mkdir -p "$LOCK_DIR" 2>/dev/null || [[ ! -w "$LOCK_DIR" ]]; then
  echo "gate-slot: lock directory $LOCK_DIR is not writable" >&2; exit 125
fi
LOG="$LOCK_DIR/gate-runs.log"
ts() { date -u +%FT%TZ; }

# ---- Plan the slots ---------------------------------------------------------

# CPU ids this process may use, expanded from a list such as "0-3,8,10-11".
CPU_IDS=()
allowed=""
[[ -r /proc/self/status ]] && allowed="$(awk '/^Cpus_allowed_list:/ {print $2}' /proc/self/status)"
if [[ "$allowed" =~ ^[0-9,-]+$ ]]; then
  IFS=, read -ra parts <<< "$allowed"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then
      for ((c = ${part%-*}; c <= ${part#*-}; c++)); do CPU_IDS+=("$c"); done
    elif [[ -n "$part" ]]; then
      CPU_IDS+=("$part")
    fi
  done
fi
if (( ${#CPU_IDS[@]} )); then
  AFFINITY=${#CPU_IDS[@]}
else
  AFFINITY="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
  [[ "$AFFINITY" =~ ^[1-9][0-9]*$ ]] || AFFINITY=1
fi

# CPU quota (cgroup v2 cpu.max "quota period", or v1 cfs_quota_us / cfs_period_us), rounded up.
QUOTA_CPUS=""
if [[ -r /sys/fs/cgroup/cpu.max ]]; then
  read -r q p < /sys/fs/cgroup/cpu.max
  [[ "$q" =~ ^[0-9]+$ && "$p" =~ ^[1-9][0-9]*$ ]] && QUOTA_CPUS=$(( (q + p - 1) / p ))
elif [[ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us && -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]]; then
  q="$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us)"; p="$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"
  [[ "$q" =~ ^[0-9]+$ && "$p" =~ ^[1-9][0-9]*$ ]] && QUOTA_CPUS=$(( (q + p - 1) / p ))
fi
USABLE=$AFFINITY
PIN_MODE=pin
if [[ -n "$QUOTA_CPUS" ]] && (( QUOTA_CPUS >= 1 && QUOTA_CPUS < AFFINITY )); then
  USABLE=$QUOTA_CPUS
  PIN_MODE=claim
fi

# Memory bound in MiB: cgroup limit when set, else MemTotal.
MEM_MB=""
for f in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes; do
  if [[ -r "$f" ]]; then
    m="$(cat "$f")"
    # cgroup v1 reports "no limit" as a huge number; treat anything over 1 PiB as unlimited.
    if [[ "$m" =~ ^[0-9]+$ ]] && (( ${#m} < 16 )); then MEM_MB=$(( m / 1048576 )); fi
    break
  fi
done
if [[ -z "$MEM_MB" && -r /proc/meminfo ]]; then
  MEM_MB=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 ))
fi

if [[ -n "$FORCED_SLOTS" ]]; then
  SLOTS=$FORCED_SLOTS
  WORKERS=$(( USABLE / SLOTS )); (( WORKERS >= 1 )) || WORKERS=1
else
  (( SLOT_WIDTH > USABLE )) && SLOT_WIDTH=$USABLE
  WORKERS=$SLOT_WIDTH
  SLOTS=$(( USABLE / WORKERS ))
  if [[ -n "$MEM_MB" ]]; then
    MEM_SLOTS=$(( MEM_MB / SLOT_MEM_MB ))
    (( MEM_SLOTS < SLOTS )) && SLOTS=$MEM_SLOTS
  fi
  (( SLOTS >= 1 )) || SLOTS=1
fi

# Assign CPU ids to slots (empty = ids unknown, or more slots than ids: lock by index).
SLOT_CPUS=()
for ((i = 0; i < SLOTS; i++)); do
  cpus=""
  if (( ${#CPU_IDS[@]} >= (i + 1) * WORKERS )); then
    for ((j = i * WORKERS; j < (i + 1) * WORKERS; j++)); do cpus+="${cpus:+,}${CPU_IDS[$j]}"; done
  fi
  SLOT_CPUS+=("$cpus")
done

export GATE_SLOT_WORKERS="$WORKERS"
export PYTEST_XDIST_AUTO_NUM_WORKERS="${PYTEST_XDIST_AUTO_NUM_WORKERS:-$WORKERS}"
HAVE_TASKSET=1
command -v taskset >/dev/null 2>&1 || HAVE_TASKSET=0
if (( ! HAVE_TASKSET )) && [[ "$PIN_MODE" == pin && -n "${SLOT_CPUS[0]}" ]]; then
  echo "gate-slot: taskset not found; running unpinned (slots still bound concurrency)" >&2
fi

# ---- Take a slot --------------------------------------------------------------

# Lock files for slot $1: one per CPU id it claims (pinned or not), so every plan
# draws on one host-wide CPU pool; one per index only when the CPU ids are unknown.
slot_lock_files() {
  local cpus="${SLOT_CPUS[$1]}"
  if [[ -z "$cpus" ]]; then
    echo "$LOCK_DIR/.gate.unpinned$1"
  else
    local c
    for c in ${cpus//,/ }; do echo "$LOCK_DIR/.gate.cpu$c"; done
  fi
}

HELD=()
release_held() {
  local fd
  for fd in "${HELD[@]}"; do exec {fd}>&-; done
  HELD=()
}
# Take every lock of slot $1 without blocking, or none of them. Returns 1 when a
# lock is busy, 2 when a lock file cannot be opened (a wrapper failure, not "busy").
try_slot() {
  local f fd
  while read -r f; do
    # The brace group keeps the new fd but restores stderr afterwards.
    if ! { exec {fd}>>"$f"; } 2>/dev/null; then
      release_held
      OPEN_FAILED="$f"
      return 2
    fi
    if ! flock -n "$fd"; then
      exec {fd}>&-
      release_held
      return 1
    fi
    HELD+=("$fd")
  done < <(slot_lock_files "$1")
  return 0
}

echo "$(ts) WAIT  pid=$$ slots=$SLOTS $PWD :: $*" >> "$LOG"
deadline=$((SECONDS + WAIT)); slot=""
while [[ -z "$slot" ]]; do
  for ((i = 0; i < SLOTS; i++)); do
    try_slot "$i"; got=$?
    if (( got == 0 )); then slot=$i; break; fi
    if (( got == 2 )); then
      echo "gate-slot: cannot open lock file $OPEN_FAILED" >&2
      exit 125
    fi
  done
  [[ -n "$slot" ]] && break
  if (( SECONDS >= deadline )); then
    echo "$(ts) BUSY  pid=$$ $PWD" >> "$LOG"
    echo "gate-slot: all $SLOTS gate slots busy (waited ${WAIT}s). Re-run the exact same command to keep waiting." >&2
    exit 75
  fi
  sleep 2
done

# ---- Run the command ----------------------------------------------------------

CPUS="${SLOT_CPUS[$slot]}"
PIN=()
if [[ "$PIN_MODE" == pin && -n "$CPUS" ]] && (( HAVE_TASKSET )); then
  taskset -c "$CPUS" true 2>/dev/null \
    || { echo "gate-slot: cannot pin to CPUs $CPUS (offline or outside this cgroup)" >&2; release_held; exit 125; }
  PIN=(taskset -c "$CPUS")
fi
echo "$(ts) START pid=$$ slot=$slot cpus=${CPUS:-unknown} mode=$PIN_MODE workers=$WORKERS $PWD :: $*" >> "$LOG"
# The command must not inherit the lock fds: a backgrounded grandchild would
# otherwise keep the slot locked after this run ends. This shell keeps them, so it
# must not exit while the command runs: TERM/HUP/INT are forwarded to the command
# and the locks are released only once it has exited. (A SIGKILL of this shell
# cannot be intercepted; stop gate runs with TERM.)
child=""; pending=""
trap 'if [[ -n "$child" ]]; then kill -TERM "$child" 2>/dev/null; else pending=1; fi' TERM HUP INT
(
  for fd in "${HELD[@]}"; do exec {fd}>&-; done
  exec "${PIN[@]}" "$@"
) <&0 &
child=$!
# A signal that arrived before the command started is delivered to it now.
[[ -n "$pending" ]] && kill -TERM "$child" 2>/dev/null
wait "$child"; rc=$?
while kill -0 "$child" 2>/dev/null; do wait "$child"; rc=$?; done
trap - TERM HUP INT
echo "$(ts) END   pid=$$ slot=$slot rc=$rc $PWD" >> "$LOG"
release_held
exit $rc
