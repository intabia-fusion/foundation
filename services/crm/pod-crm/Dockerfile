FROM intabiafusion/base-slim:v20260309
WORKDIR /usr/src/app

COPY bundle/bundle.js ./
COPY bundle/bundle.js.map ./

EXPOSE 3001

CMD [ "node", "bundle.js" ]
