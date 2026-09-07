import { devices, PlaywrightTestConfig } from '@playwright/test'
import { config as dotenvConfig } from 'dotenv'
dotenvConfig()

const PlatformURI = process.env.PLATFORM_URI ?? 'http://localhost:8083'

let maxFailures: number | undefined
if (process.env.TESTS_MAX_FAILURES !== undefined) {
  maxFailures = parseInt(process.env.TESTS_MAX_FAILURES)
}

// A run that stays green needs no trace, and a stable failure is reproduced by the retry anyway.
// Tracing every attempt costs the whole run, so it is opt-in: TRACE_MODE=retain-on-failure when
// hunting a flake, which is the only case where the failing attempt's trace is the one you need.
const traceModes = ['on-first-retry', 'retain-on-failure', 'on', 'off', 'on-all-retries'] as const
type TraceMode = (typeof traceModes)[number]

const requested = (process.env.TRACE_MODE ?? '').trim()
const traceMode: TraceMode = traceModes.includes(requested as TraceMode) ? (requested as TraceMode) : 'on-first-retry'
if (requested !== '' && requested !== traceMode) {
  console.warn(`TRACE_MODE=${JSON.stringify(requested)} is not one of ${traceModes.join(', ')}; using ${traceMode}`)
}

// love drives the wall time: meetings.all.spec.ts pulls in all 17 love files, so it is one
// sequential ~178s job. Its own project puts it at the head of the queue instead of ~80s in,
// where it used to finish alone while the other workers idled.
const platformUse: PlaywrightTestConfig['use'] = {
  // A toast lives 10s (packages/ui/src/utils.ts) in the bottom-left corner - on top of
  // #profile-button. Every click on it then waits the toast out; that cost 166s of the run
  // and is what timed the flaky tests out. setTestOptions() does the same, but only 8 of
  // the 85 spec files call it, so put it where every context gets it.
  storageState: {
    cookies: [],
    origins: [
      {
        origin: PlatformURI,
        localStorage: [{ name: '#platform.notification.timeout', value: '0' }]
      }
    ]
  },
  // Without it an action inherits the test timeout: a click on a covered element - a panel over the
  // floor, a stale overlay - hangs for the full minute and reports nothing useful. 30s, not less:
  // under five workers a button can legitimately take twenty to become clickable.
  actionTimeout: 30000,
  testIdAttribute: 'data-id',
  permissions: ['clipboard-read', 'clipboard-write', 'microphone', 'camera'],
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // WebRTC ICE: on Linux CI runners mDNS .local hostnames don't
      // resolve, which kills DTLS handshake. Disable mDNS obfuscation so
      // LiveKit gets a real loopback/host IP candidate.
      '--disable-features=WebRtcHideLocalIpsWithMdns'
    ]
  },
  ...devices['Desktop Chrome'],
  screenshot: 'only-on-failure',
  viewport: {
    width: 1440,
    height: 900
  },
  trace: {
    mode: traceMode,
    snapshots: true,
    screenshots: true,
    sources: true
  },
  contextOptions: {
    reducedMotion: 'reduce'
  }
}

const config: PlaywrightTestConfig = {
  globalSetup: require.resolve('./global.setup.ts'),
  globalTeardown: require.resolve('./global.teardown.ts'),
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'Love',
      testMatch: /love\/.*\.spec\.ts/,
      use: platformUse,
      fullyParallel: false,
      dependencies: ['setup']
    },
    {
      name: 'Platform',
      testIgnore: /love\//,
      use: platformUse,
      // Measured alternatives are worse: per-test scheduling 382.9s, a separate lane for the
      // heavy tracker specs 346.4s, this 314.2s.
      fullyParallel: false,
      dependencies: ['setup']
    }
  ],
  retries: 2,
  timeout: 60000,
  maxFailures,
  expect: {
    timeout: 15000
  },
  globalTimeout: 2_700_000,
  reporter: [
    ['list'],
    // open: 'never' - the default parks a report server on failure and hangs the terminal.
    ['html', { open: 'never' }],
    // Machine-readable twin of the html report, consumed by analyze_failures.js.
    // Relative to this config's directory, so '..' puts it next to package.json.
    ['json', { outputFile: '../playwright-report.json' }],
    // Per-step timings, which the json reporter drops. Consumed by analyze_steps.js.
    [require.resolve('./step-reporter.ts')],
    [
      'allure-playwright',
      {
        detail: true,
        suiteTitle: false
      }
    ]
  ]
}
export default config
