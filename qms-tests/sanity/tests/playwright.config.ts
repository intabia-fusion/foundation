import { devices, PlaywrightTestConfig } from '@playwright/test'
import { config as dotenvConfig } from 'dotenv'
dotenvConfig()

const PlatformURI = process.env.PLATFORM_URI ?? 'http://localhost:8083'

// Tracing every attempt costs the whole run; TRACE_MODE=retain-on-failure when hunting a flake.
const traceMode = (process.env.TRACE_MODE ?? 'on-first-retry') as 'on-first-retry'

let maxFailures: number | undefined
if (process.env.TESTS_MAX_FAILURES !== undefined) {
  maxFailures = parseInt(process.env.TESTS_MAX_FAILURES)
}

const config: PlaywrightTestConfig = {
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'QMS',
      use: {
        // A toast lives 10s (packages/ui/src/utils.ts) in the bottom-left corner, on top of
        // #profile-button - every click on it then waits the toast out. setTestOptions() does the
        // same, but only for the tests that call it.
        storageState: {
          cookies: [],
          origins: [
            {
              origin: PlatformURI,
              localStorage: [{ name: '#platform.notification.timeout', value: '0' }]
            }
          ]
        },
        testIdAttribute: 'data-id',
        permissions: ['clipboard-read', 'clipboard-write'],
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
      },
      dependencies: ['setup']
    }
  ],
  fullyParallel: false,
  workers: 1,
  retries: 2,
  timeout: 60000,
  maxFailures,
  expect: {
    timeout: 15000
  },
  reporter: [
    ['list'],
    ['html'],
    // Consumed by analyze_failures.js and the telemetry collector in CI.
    ['json', { outputFile: '../playwright-report.json' }],
    [require.resolve('../../../tests/sanity/tests/step-reporter.ts')],
    [
      'allure-playwright',
      {
        detail: false,
        suiteTitle: false
      }
    ]
  ]
}
export default config
