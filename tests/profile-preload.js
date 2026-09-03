// Preloaded via NODE_OPTIONS=--require by docker-compose.profile.yaml.
// V8 only flushes --cpu-prof on a clean exit; a pod with no SIGTERM handler is killed by the
// signal instead and writes nothing. This adds the missing handler, and stays out of the way
// of pods that shut down gracefully on their own.
function onSignal (sig) {
  if (process.listenerCount(sig) > 1) return
  process.exit(0)
}
process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)

// Records which bundle actually ran, so profile-report.js can refuse to apply a stale
// bundle.js.map from the host and report wrong source lines.
if (process.env.PROFILE_DIR !== undefined) {
  try {
    const fs = require('fs')
    const main = process.argv[1]
    fs.mkdirSync(process.env.PROFILE_DIR, { recursive: true })
    fs.writeFileSync(
      `${process.env.PROFILE_DIR}/meta.json`,
      JSON.stringify({ main, size: fs.statSync(main).size })
    )
  } catch (err) {
    console.warn('profile meta failed:', err.message)
  }
}
