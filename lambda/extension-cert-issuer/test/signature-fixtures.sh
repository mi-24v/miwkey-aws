#!/bin/sh
# Development-only: SHA-1 signed fixtures with explicit validity; all output stays in $1.
set -eu
D="$1"; cd "$D"
export OPENSSL_CONF=/dev/null
NB=20261014000000Z; NA=20261116000000Z; RNA=20271014000000Z
cat > ext.cnf <<'CNF'
[root]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
[inter]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth
subjectAltName=DNS:notifications.example.com
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
CNF
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out root.key 2>/dev/null
openssl req -new -key root.key -subj "/CN=Probe SHA1 RSA Root" -out root.csr
openssl x509 -req -in root.csr -signkey root.key -sha256 -not_before $NB -not_after $RNA -extfile ext.cnf -extensions root -out root.pem 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out leaf.key
openssl req -new -key leaf.key -subj "/CN=notifications.example.com" -out leaf.csr
openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -set_serial 0x1001 -sha1 -not_before $NB -not_after $NA -extfile ext.cnf -extensions leaf -out leaf-sha1.pem 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out inter.key
openssl req -new -key inter.key -subj "/CN=Probe SHA1 Intermediate" -out inter.csr
openssl x509 -req -in inter.csr -CA root.pem -CAkey root.key -set_serial 0x1002 -sha1 -not_before $NB -not_after $RNA -extfile ext.cnf -extensions inter -out inter-sha1.pem 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out leaf2.key
openssl req -new -key leaf2.key -subj "/CN=notifications.example.com" -out leaf2.csr
openssl x509 -req -in leaf2.csr -CA inter-sha1.pem -CAkey inter.key -set_serial 0x1003 -sha256 -not_before $NB -not_after $NA -extfile ext.cnf -extensions leaf -out leaf2.pem 2>/dev/null
for f in leaf-sha1.pem inter-sha1.pem leaf2.pem; do openssl x509 -in $f -noout -text | grep -E "Signature Algorithm|Not (Before|After)" | head -3; done

openssl x509 -req -in root.csr -signkey root.key -sha1 -not_before $NB -not_after $RNA -extfile ext.cnf -extensions root -out root-sha1.pem 2>/dev/null
