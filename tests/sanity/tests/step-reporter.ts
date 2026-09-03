//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import type { FullResult, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter'
import { appendFileSync, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'

// The json reporter keeps only per-test totals, and traces exist only for failures. Without a
// per-step record there is no way to ask "which click is slow across the whole run".
const OUT = process.env.STEP_REPORT ?? 'step-report.ndjson'
const KEEP = new Set(['pw:api', 'expect', 'test.step', 'hook', 'fixture'])

export default class StepReporter implements Reporter {
  onBegin (): void {
    mkdirSync(dirname(OUT), { recursive: true })
    rmSync(OUT, { force: true })
  }

  onTestEnd (test: TestCase, result: TestResult): void {
    const rows: string[] = []
    const visit = (step: TestStep, depth: number): void => {
      if (KEEP.has(step.category)) {
        rows.push(
          JSON.stringify({
            file: test.location.file.split('/tests/').pop(),
            test: test.title,
            retry: result.retry,
            status: result.status,
            depth,
            category: step.category,
            title: step.title,
            ms: step.duration,
            error: step.error?.message?.split('\n')[0]
          })
        )
      }
      for (const child of step.steps) visit(child, depth + 1)
    }
    for (const step of result.steps) visit(step, 0)
    if (rows.length > 0) appendFileSync(OUT, rows.join('\n') + '\n')
  }

  onEnd (_result: FullResult): void {
    console.log(`\n[steps] ${OUT} - analyse with: node analyze_steps.js`)
  }
}
