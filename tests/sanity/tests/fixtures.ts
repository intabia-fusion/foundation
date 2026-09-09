//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

import type { WorkspaceLoginInfo } from '@hcengineering/account'
import { request as apiRequest, test as base } from '@playwright/test'
import type { TestData } from './chat/types'
import { createAccountWithWorkspace, flushTelemetry, generateTestData } from './utils'

export { expect } from '@playwright/test'
export type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test'

export interface SharedWorkspace {
  data: TestData
  ws: WorkspaceLoginInfo
  token: string
}

// The free plan gives 5 seats and the AI bot takes none, so the owner plus 4 guests fit. One stays
// spare: an invite that skips the `@invite` tag is uncounted, and past the cap a guest goes read-only.
const SEATS_PER_WORKSPACE = 3

// @playwright/test's `test`, plus a flush of client counters before a context closes.
// Overriding `context` and not `page` keeps request-only tests browser-free.
// eslint-disable-next-line @typescript-eslint/ban-types
export const test = base.extend<{}, { sharedWorkspace: (invites?: number) => Promise<SharedWorkspace> }>({
  context: async ({ context }, use) => {
    await use(context)
    await Promise.all(context.pages().map(flushTelemetry))
  },

  // One workspace per worker instead of one per test: creating it costs ~1.9s of account and
  // model-building time. Tests that invite guests spend seats, so it is recycled before it runs out.
  sharedWorkspace: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const request = await apiRequest.newContext()
      let current: SharedWorkspace | undefined
      let seatsLeft = 0
      await use(async (invites = 0) => {
        if (current === undefined || invites > seatsLeft) {
          const data = generateTestData()
          current = { data, ...(await createAccountWithWorkspace(request, data)) }
          seatsLeft = SEATS_PER_WORKSPACE
        }
        seatsLeft -= invites
        return current
      })
      await request.dispose()
    },
    { scope: 'worker' }
  ]
})
