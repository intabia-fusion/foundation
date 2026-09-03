FROM intabiafusion/base:v20251218
WORKDIR /app

# T-Bank API serves a chain signed by Russian Trusted CA (НУЦ Минцифры), absent from Node's
# bundled trust store -> SELF_SIGNED_CERT_IN_CHAIN. NODE_EXTRA_CA_CERTS augments, never replaces it.
COPY certs/russian-trusted-ca-bundle.pem /etc/ssl/russian-trusted-ca.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/russian-trusted-ca.pem

COPY bundle/bundle.js ./
COPY bundle/bundle.js.map ./

CMD [ "dumb-init", "node", "bundle.js" ]
