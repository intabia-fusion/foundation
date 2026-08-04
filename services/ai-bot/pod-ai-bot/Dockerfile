FROM intabiafusion/base:v20251218
WORKDIR /usr/src/app

COPY bundle/bundle.js ./
COPY assets/avatar.png ./
COPY certs ./certs/
COPY prompts.yaml ./

ENV NODE_EXTRA_CA_CERTS=/usr/src/app/certs
ENV NODE_TLS_REJECT_UNAUTHORIZED='0'

EXPOSE 4010
CMD [ "node", "bundle.js" ]
