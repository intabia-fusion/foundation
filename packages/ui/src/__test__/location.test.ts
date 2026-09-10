import { describe, it, expect, vi } from 'vitest'
import { locationToUrl } from '../location'
import { type Location } from '../types'

// Mock svelte/store to avoid ES module issues in Jest
vi.mock('svelte/store', () => ({
  derived: vi.fn(),
  get: vi.fn(),
  writable: vi.fn()
}))

describe('location', () => {
  it('should translate location to url', () => {
    const loc: Location = {
      path: ['x', 'y']
    }
    const url = locationToUrl(loc)
    expect(url).toBe('/x/y')
  })
})
