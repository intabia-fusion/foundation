//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//

import { test as base } from '@playwright/test'
import { flushTelemetry } from './utils'

export { expect } from '@playwright/test'
export type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test'

// @playwright/test's `test`, plus a flush of client counters before a context closes.
// Overriding `context` and not `page` keeps request-only tests browser-free.
export const test = base.extend({
  context: async ({ context }, use) => {
    await use(context)
    await Promise.all(context.pages().map(flushTelemetry))
  }
})
