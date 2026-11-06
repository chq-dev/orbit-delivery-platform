#!/bin/bash
set -euo pipefail

LABEL="com.orbit.feishu-agent"
DEFAULT_PLATFORM_BASE_URL="https://8.145.45.84:8787"
PLATFORM_BASE_URL="${1:-${ORBIT_PLATFORM_BASE_URL:-$DEFAULT_PLATFORM_BASE_URL}}"
PLATFORM_BASE_URL="${PLATFORM_BASE_URL%/}"
DOWNLOAD_BASE_URL="${2:-$PLATFORM_BASE_URL}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL%/}"

case "$PLATFORM_BASE_URL" in
  https://*) ;;
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
  *)
    echo "平台地址必须是 HTTPS；仅允许 localhost 开发地址使用 HTTP：$PLATFORM_BASE_URL" >&2
    exit 1
    ;;
esac

case "$DOWNLOAD_BASE_URL" in
  https://*) ;;
  http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) ;;
  *)
    echo "下载地址必须是 HTTPS；仅允许 localhost 开发地址使用 HTTP：$DOWNLOAD_BASE_URL" >&2
    exit 1
    ;;
esac

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 Node.js；请先安装 Node.js 18 或更新版本后重试。" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 18 )); then
  echo "需要 Node.js 18 或更新版本，当前版本：$("$NODE_BIN" --version)" >&2
  exit 1
fi

UID_VALUE="$(id -u)"
NODE_DIR="$(dirname "$NODE_BIN")"
PATH_VALUE="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
APP_DIR="$HOME/Library/Application Support/Orbit/feishu-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"

download_agent_file() {
  local file_name="$1"
  local temporary_path="$APP_DIR/$file_name.download"
  curl --fail --silent --show-error --location --retry 2 \
    "$DOWNLOAD_BASE_URL/downloads/$file_name" \
    --output "$temporary_path"
  chmod 600 "$temporary_path"
  mv "$temporary_path" "$APP_DIR/$file_name"
}

download_agent_file feishuClientAgent.mjs
download_agent_file feishuSync.mjs
download_agent_file localDelivery.mjs

launchctl bootout "gui/$UID_VALUE/$LABEL" 2>/dev/null || true
sleep 1
LISTENER_PIDS="$(lsof -tiTCP:18787 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$LISTENER_PIDS" ]]; then
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    process_command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$process_command" in
      *feishuClientAgent*|*feishu:agent*) kill -TERM "$pid" ;;
      *)
        echo "18787 端口由其他进程占用，未停止它：$process_command" >&2
        exit 1
        ;;
    esac
  done <<< "$LISTENER_PIDS"
  sleep 1
fi
if lsof -tiTCP:18787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "旧代理仍占用 18787 端口，请关闭后重新运行安装器。" >&2
  exit 1
fi

xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  value="${value//\"/\&quot;}"
  value="${value//\'/\&apos;}"
  printf '%s' "$value"
}

NODE_XML="$(xml_escape "$NODE_BIN")"
AGENT_XML="$(xml_escape "$APP_DIR/feishuClientAgent.mjs")"
SYNC_CLI_XML="$(xml_escape "$APP_DIR/feishuSync.mjs")"
DELIVERY_CLI_XML="$(xml_escape "$APP_DIR/localDelivery.mjs")"
HOME_XML="$(xml_escape "$HOME")"
PATH_XML="$(xml_escape "$PATH_VALUE")"
PLATFORM_XML="$(xml_escape "$PLATFORM_BASE_URL")"
CODEX_BIN="$(command -v codex || true)"
MEEGLE_BIN="$(command -v meegle || true)"
CODEX_ENV=""
MEEGLE_ENV=""
if [[ -n "$CODEX_BIN" ]]; then
  CODEX_ENV="<key>CODEX_BIN</key><string>$(xml_escape "$CODEX_BIN")</string>"
fi
if [[ -n "$MEEGLE_BIN" ]]; then
  MEEGLE_ENV="<key>MEEGLE_BIN</key><string>$(xml_escape "$MEEGLE_BIN")</string>"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$AGENT_XML</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME_XML</string>
    <key>PATH</key><string>$PATH_XML</string>
    <key>FEISHU_AGENT_PLATFORM_URL</key><string>$PLATFORM_XML</string>
    <key>ORBIT_FEISHU_SYNC_CLI</key><string>$SYNC_CLI_XML</string>
    <key>ORBIT_LOCAL_DELIVERY_CLI</key><string>$DELIVERY_CLI_XML</string>
    $CODEX_ENV
    $MEEGLE_ENV
  </dict>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
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
launchctl bootstrap "gui/$UID_VALUE" "$PLIST"
launchctl kickstart -k "gui/$UID_VALUE/$LABEL"
sleep 3
curl --fail --silent --show-error --max-time 12 \
  http://127.0.0.1:18787/health
printf '\n%s\n' "Orbit 独立执行代理已安装为登录自启动服务：$PLIST"
