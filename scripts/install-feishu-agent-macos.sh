#!/bin/zsh
set -euo pipefail

LABEL="com.orbit.feishu-agent"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_VALUE="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents"
launchctl remove "$LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>HOME=$HOME</string>
    <string>PATH=$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "$REPO_ROOT" &amp;&amp; exec "$NPM_BIN" run feishu:agent</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/tmp/orbit-feishu-agent.out</string>
  <key>StandardErrorPath</key>
  <string>/tmp/orbit-feishu-agent.err</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"
if ! launchctl bootstrap "gui/$UID_VALUE" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST"
fi
launchctl kickstart -k "gui/$UID_VALUE/$LABEL" 2>/dev/null || true
sleep 3
curl -fsS --max-time 12 http://127.0.0.1:18787/health
printf '\n%s\n' "Orbit 飞书同步代理已注册为登录自启：$PLIST"
