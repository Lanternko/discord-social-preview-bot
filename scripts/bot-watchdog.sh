#!/usr/bin/env bash
# Cron-driven watchdog for the Discord social-preview bot (西寶).
# Runs as user kojiek every minute. If the node process is gone, restart it.
#
# Install:
#   chmod +x /home/kojiek/side_projects/discord-social-preview-bot/scripts/bot-watchdog.sh
#   ( crontab -l 2>/dev/null; echo '* * * * * /home/kojiek/side_projects/discord-social-preview-bot/scripts/bot-watchdog.sh' ) | crontab -
#
# The [n]ode bracket trick keeps the pattern from matching the watchdog's
# own command line via the shell that ran pgrep.

set -u

REPO=/home/kojiek/side_projects/discord-social-preview-bot
WD_LOG=/tmp/bot_watchdog.log

cd "$REPO" || exit 1

if pgrep -f '[n]ode src/index.js' > /dev/null; then
  exit 0
fi

nohup setsid node src/index.js >> "$REPO/bot.log" 2>&1 < /dev/null &
disown

ts=$(date '+%Y-%m-%dT%H:%M:%S%z')
pid=$(pgrep -f '[n]ode src/index.js' | head -1)
echo "$ts watchdog: bot not running, restarted (pid=${pid:-unknown})" >> "$WD_LOG"
