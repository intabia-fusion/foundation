FROM intabiafusion/love-agent-base:v20260309
WORKDIR /usr/src/app

COPY package.json package.json
COPY pnpm-lock.yaml pnpm-lock.yaml

# No-op when the lock matches the base image; pulls only the delta when it drifted.
RUN pnpm install --ignore-scripts=false

# @livekit/local-inference (pulled in by @livekit/agents >= 1.6.4 for local audio EOT) is built
# with AVX2 and dies with SIGILL on older CPUs, taking the whole worker down at startup. The agent
# only transcribes, so drop the binding — the SDK logs a warning and skips the local EOT runner.
RUN rm -rf node_modules/.pnpm/@livekit+local-inference* \
    node_modules/.pnpm/@livekit+agents*/node_modules/@livekit/local-inference

COPY ./bundle .

EXPOSE 4012
CMD [ "node", "index.js" , "start"]
