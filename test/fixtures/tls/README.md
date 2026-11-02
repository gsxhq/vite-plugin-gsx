# Test-only TLS certificates

`ca.pem` is an isolated test CA certificate. `localhost.pem` is a server
certificate signed by it, with `serverAuth` usage and SANs for `localhost`,
`127.0.0.1` and `::1`. `localhost-key.pem` is its **publicly known test private
key**. Never use these files outside tests or install this CA in a trust store.
The live HTTPS test explicitly trusts only this CA for each connection.

These fixtures expire in October 2126. They were generated with OpenSSL using
the following commands, independently of mkcert or any developer certificate.
The CA private key is temporary and is not retained.

Run from this directory to regenerate:

```sh
tls_tmp=$(mktemp -d)
trap 'rm -rf "$tls_tmp"' EXIT
cat > "$tls_tmp/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ca
prompt = no
[dn]
CN = vite-plugin-gsx TEST ONLY CA
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF
cat > "$tls_tmp/server.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 36500 \
  -config "$tls_tmp/ca.cnf" -keyout "$tls_tmp/ca.key" -out ca.pem
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -config "$tls_tmp/server.cnf" -keyout localhost-key.pem -out "$tls_tmp/server.csr"
openssl x509 -req -in "$tls_tmp/server.csr" -CA ca.pem -CAkey "$tls_tmp/ca.key" \
  -set_serial 2 -days 36500 -sha256 -extfile "$tls_tmp/server.cnf" \
  -extensions server -out localhost.pem
openssl verify -CAfile ca.pem localhost.pem
```
