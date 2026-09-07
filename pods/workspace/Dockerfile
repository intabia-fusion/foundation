FROM intabiafusion/base-slim:v20260309
WORKDIR /usr/src/app

COPY bundle/bundle.js ./
COPY bundle/bundle.js.map ./

COPY ini[t]/ ./init-scripts/

CMD [ "node", "bundle.js" ]

