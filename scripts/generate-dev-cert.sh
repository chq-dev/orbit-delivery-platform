#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TLS_DIR="$ROOT_DIR/data/tls"
KEY_PATH="$TLS_DIR/orbit-key.pem"
CERT_PATH="$TLS_DIR/orbit-cert.pem"
CONFIG_PATH="$TLS_DIR/openssl.cnf"

if ! command -v openssl >/dev/null 2>&1; then
  echo "未找到 openssl，请先安装 OpenSSL 或使用受信反向代理终止 TLS。" >&2
  exit 1
fi

mkdir -p "$TLS_DIR"
cat > "$CONFIG_PATH" <<'EOF'
[req]
default_bits = 2048
prompt = no
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = localhost

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOF

openssl req \
  -x509 \
  -nodes \
  -newkey rsa:2048 \
  -days 825 \
  -keyout "$KEY_PATH" \
  -out "$CERT_PATH" \
  -config "$CONFIG_PATH"

chmod 600 "$KEY_PATH" "$CERT_PATH" "$CONFIG_PATH"
echo "已生成本地开发证书："
echo "  私钥：$KEY_PATH"
echo "  证书：$CERT_PATH"
echo "浏览器首次访问需要信任该自签名证书；生产环境请替换为正式证书。"
