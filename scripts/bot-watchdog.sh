#!/usr/bin/env bash
# Cron-driven watchdog for the Discord social-preview bot (西寶).
# Runs as user kojiek every minute. If the node process is gone, restart it.
# If more than one instance is running, keep the oldest and kill the rest.
#
# Install:
#   chmod +x .../scripts/bot-watchdog.sh
#   ( crontab -l 2>/dev/null; echo "* * * * * .../scripts/bot-watchdog.sh" ) | crontab -

set -u

REPO=/home/kojiek/side_projects/apps/discord-social-preview-bot
WD_LOG=/tmp/bot_watchdog.log
LOCK=/tmp/bot_watchdog.lock

cd "$REPO" || exit 1

# A manual run and the cron tick can land in the same second; without a lock
# neither sees the other's child yet and both launch a bot.
exec 9>"$LOCK"
flock -n 9 || exit 0

# PIDs of the bot itself: cwd is the repo, the executable is node, and argv is
# exactly `node src/index.js`. Matching a substring of the command line also
# caught any shell whose command merely mentioned "node src/index.js" (e.g. a
# Claude tool shell running pgrep) — it counted as a live bot, so a dead bot
# was never restarted, and with the real bot up it got killed as a "duplicate".
list_bot_pids() {
  local pid cwd exe
  local -a argv
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    cwd=$(readlink "$dir/cwd" 2>/dev/null) || continue
    [ "$cwd" = "$REPO" ] || continue
    exe=$(readlink "$dir/exe" 2>/dev/null) || continue
    [ "${exe##*/}" = "node" ] || continue
    mapfile -d '' -t argv < "$dir/cmdline" 2>/dev/null || continue
    [ "${#argv[@]}" -eq 2 ] || continue
    [ "${argv[0]##*/}" = "node" ] && [ "${argv[1]}" = "src/index.js" ] || continue
    printf "%s\n" "$pid"
  done
}

pids=$(list_bot_pids)
count=$(printf "%s" "$pids" | grep -c . || true)

if [ "$count" -gt 1 ]; then
  # Keep the oldest; field 22 of /proc/pid/stat is starttime (lower = older)
  keep=$(
    for pid in $pids; do
      start=$(awk "{print \$22}" "/proc/$pid/stat" 2>/dev/null) || continue
      printf "%s %s\n" "$start" "$pid"
    done | sort -n | head -1 | awk "{print \$2}"
  )
  ts=$(date "+%Y-%m-%dT%H:%M:%S%z")
  for pid in $pids; do
    if [ "$pid" != "$keep" ]; then
      kill "$pid" 2>/dev/null || true
      echo "$ts watchdog: duplicate bot killed pid=$pid (kept=$keep)" >> "$WD_LOG"
    fi
  done
  exit 0
fi

if [ "$count" -eq 1 ]; then
  exit 0
fi

# fd 9 (the lock) must not leak into the bot, or it would hold the lock forever
nohup setsid node src/index.js >> "$REPO/bot.log" 2>&1 < /dev/null 9>&- &
disown

ts=$(date "+%Y-%m-%dT%H:%M:%S%z")
# brief wait so the child shows up in /proc
sleep 1
new=$(list_bot_pids | head -1)
echo "$ts watchdog: bot not running, restarted (pid=${new:-unknown})" >> "$WD_LOG"
