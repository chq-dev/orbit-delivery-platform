#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "该脚本仅适用于使用 systemd 的 Linux 服务器。" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="${ORBIT_SERVICE_NAME:-orbit-delivery}"
SERVICE_USER="${ORBIT_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
STATE_DIR="${ORBIT_STATE_DIR:-/var/lib/orbit-delivery}"
REPO_ENV_FILE="$REPO_ROOT/.env"

if [[ -n "${ORBIT_ENV_FILE:-}" ]]; then
  ENV_FILE="$ORBIT_ENV_FILE"
elif [[ -f "$REPO_ENV_FILE" ]]; then
  ENV_FILE="$REPO_ENV_FILE"
else
  ENV_FILE="/etc/orbit-delivery.env"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请使用 sudo 运行：sudo bash scripts/install-orbit-server-systemd.sh" >&2
  exit 1
fi

run_as_service_user() {
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- bash -lc "$1" 2>/dev/null
  else
    sudo -u "$SERVICE_USER" -H bash -lc "$1" 2>/dev/null
  fi
}

NPM_BIN="${ORBIT_NPM_BIN:-$(run_as_service_user 'command -v npm' || true)}"
if [[ -z "$NPM_BIN" || ! -x "$NPM_BIN" ]]; then
  echo "未找到服务用户可执行的 npm；请通过 ORBIT_NPM_BIN=/absolute/path/to/npm 指定。" >&2
  exit 1
fi

NODE_BIN="${ORBIT_NODE_BIN:-$(run_as_service_user 'command -v node' || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "未找到服务用户可执行的 node；请通过 ORBIT_NODE_BIN=/absolute/path/to/node 指定。" >&2
  exit 1
fi
NODE_DIR="$(dirname "$(readlink -f "$NODE_BIN")")"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$STATE_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  EXISTING_DB="$REPO_ROOT/data/orbit.db"
  if [[ -f "$EXISTING_DB" ]]; then
    DB_PATH_VALUE='./data/orbit.db'
    if [[ -n "${ORBIT_VAULT_KEY:-}" ]]; then
      VAULT_KEY_VALUE="$ORBIT_VAULT_KEY"
    else
      VAULT_KEY_VALUE='orbit-local-development-key-change-before-production'
      echo "检测到现有数据库 $EXISTING_DB；为保持旧凭据可解密，已沿用原默认 VAULT_KEY。" >&2
    fi
  else
    DB_PATH_VALUE="$STATE_DIR/orbit.db"
    if [[ -n "${ORBIT_VAULT_KEY:-}" ]]; then
      VAULT_KEY_VALUE="$ORBIT_VAULT_KEY"
    else
      VAULT_KEY_VALUE="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    fi
  fi
  if [[ "$VAULT_KEY_VALUE" =~ [[:space:]] ]]; then
    echo "VAULT_KEY 不能包含空白字符。" >&2
    exit 1
  fi
  TMP_ENV="$(mktemp)"
  grep -vE '^(DB_PATH|VAULT_KEY)=' "$REPO_ROOT/deploy/orbit-delivery.env.example" > "$TMP_ENV"
  printf 'DB_PATH=%s\nVAULT_KEY=%s\n' "$DB_PATH_VALUE" "$VAULT_KEY_VALUE" >> "$TMP_ENV"
  install -m 0600 "$TMP_ENV" "$ENV_FILE"
  rm -f "$TMP_ENV"
  echo "已创建环境变量文件：$ENV_FILE"
else
  echo "使用现有环境变量文件：$ENV_FILE"
fi

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Orbit Delivery Platform
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$REPO_ROOT
Environment=HOME=$SERVICE_HOME
Environment=PATH=$NODE_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EnvironmentFile=-$ENV_FILE
ExecStart=$NPM_BIN run start:server
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
KillMode=mixed
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
sleep 2
systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,18p'

echo
echo "Orbit 平台已注册为 systemd 常驻服务：$UNIT_PATH"
echo "查看日志：journalctl -u $SERVICE_NAME -f"
echo "重启服务：sudo systemctl restart $SERVICE_NAME"
