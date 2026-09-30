#!/bin/sh
set -e

# The save directory is usually a bind mount owned by the host user.
# Apache runs PHP as www-data (uid 33), which needs to write room files into it.
DATA_DIR=/var/www/html/data/rooms
mkdir -p "$DATA_DIR"
if ! chown -R www-data:www-data "$DATA_DIR" 2>/dev/null; then
    echo "infinisweeper: warning: could not chown $DATA_DIR; make sure uid 33 (www-data) can write to it" >&2
fi

# HTTPS certificate. A cert.pem/key.pem you put in $TLS_DIR is used as-is. Otherwise a self-signed one is
# made once and kept, so each browser only has to accept it once; it's remade if TLS_HOSTS changes.
# TLS_HOSTS lists the extra names/IPs players use, e.g. TLS_HOSTS=192.168.1.20,mypc.local
TLS_DIR=/var/lib/infinisweeper/tls
mkdir -p "$TLS_DIR" 2>/dev/null || true
SAN="DNS:localhost,IP:127.0.0.1"
for h in $(echo "${TLS_HOSTS:-}" | tr ',' ' '); do
    if echo "$h" | grep -Eq '^[0-9.]+$|:'; then SAN="$SAN,IP:$h"; else SAN="$SAN,DNS:$h"; fi
done
if [ -f "$TLS_DIR/generated-for" ] && [ "$(cat "$TLS_DIR/generated-for")" != "$SAN" ]; then
    rm -f "$TLS_DIR/cert.pem" "$TLS_DIR/key.pem"
fi
if [ ! -s "$TLS_DIR/cert.pem" ] || [ ! -s "$TLS_DIR/key.pem" ]; then
    # A plain server certificate (not a CA, which req -x509 makes by default). 825 days is the longest
    # validity Apple platforms accept for one.
    CNF=/tmp/infinisweeper-tls.cnf
    printf '%s\n' '[req]' 'distinguished_name=dn' 'x509_extensions=ext' 'prompt=no' '[dn]' 'CN=infinisweeper' '[ext]' \
        "subjectAltName=$SAN" 'basicConstraints=critical,CA:FALSE' 'keyUsage=critical,digitalSignature,keyEncipherment' \
        'extendedKeyUsage=serverAuth' > "$CNF"
    if openssl req -x509 -newkey rsa:2048 -nodes -days 825 -config "$CNF" \
            -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" 2>/dev/null; then
        chmod 600 "$TLS_DIR/key.pem" || true
        echo "$SAN" > "$TLS_DIR/generated-for"
        echo "infinisweeper: created a self-signed HTTPS certificate for $SAN" >&2
    else
        echo "infinisweeper: error: could not create an HTTPS certificate in $TLS_DIR; serving HTTP only" >&2
    fi
fi
# Apache won't start at all with a missing certificate, so without one only the HTTPS site is switched off.
if [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
    a2ensite -q infinisweeper-tls >/dev/null
else
    a2dissite -q infinisweeper-tls >/dev/null
fi

exec docker-php-entrypoint "$@"
