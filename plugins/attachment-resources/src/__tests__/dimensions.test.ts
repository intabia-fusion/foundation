/* eslint-disable import/first */
/**
 * @jest-environment jsdom
 */

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

// Mock UI and Svelte module imports before importing utils to avoid Jest Svelte syntax parsing errors
jest.mock(
  '@hcengineering/platform',
  () => ({
    plugin: jest.fn(() => ({})),
    mergeIds: jest.fn(() => ({})),
    getMetadata: jest.fn(),
    getResource: jest.fn(),
    setPlatformStatus: jest.fn(),
    unknownError: jest.fn()
  }),
  { virtual: true }
)
jest.mock('@hcengineering/presentation', () => ({}), { virtual: true })
jest.mock('@hcengineering/ui', () => ({}), { virtual: true })
jest.mock('@hcengineering/workbench', () => ({}), { virtual: true })
jest.mock('@hcengineering/view', () => ({}), { virtual: true })
jest.mock('../components/AttachmentPreviewPopup.svelte', () => ({}), { virtual: true })

import type { BlobMetadata } from '@hcengineering/core'

import { type AttachmentImageSize } from '../types'
import { calculateAttachmentDimensions, getImageDimensions } from '../utils'

interface AttachmentDimensionTestCase {
  name: string
  metadata?: BlobMetadata
  size?: AttachmentImageSize
  dpr?: number
  expectedWidth: number
  expectedHeight: number
  expectedFit?: 'contain' | 'cover'
}

describe('Attachment Image Dimensions Suite (calculateAttachmentDimensions)', () => {
  beforeAll(() => {
    if (typeof globalThis.window === 'undefined') {
      ;(globalThis as any).window = globalThis
    }
    if (typeof globalThis.document === 'undefined') {
      ;(globalThis as any).document = { documentElement: {} }
    }
    ;(globalThis.window as any).getComputedStyle = () => ({
      fontSize: '16px'
    })
  })

  // =========================================================================
  // 1. Standard Sizes, Retina Scaling & Default Presets
  // =========================================================================
  describe('Standard Image Sizes & DPR Retina Scaling', () => {
    const testCases: AttachmentDimensionTestCase[] = [
      {
        name: '300x171 standard landscape photo (1x DPR)',
        metadata: { originalWidth: 300, originalHeight: 171 },
        size: 'x-large',
        dpr: 1,
        expectedWidth: 300,
        expectedHeight: 171
      },
      {
        name: '300x171 photo on Retina 2x display (dpr = 2 -> 150x86px)',
        metadata: { originalWidth: 300, originalHeight: 171 },
        size: 'x-large',
        dpr: 2,
        expectedWidth: 150,
        expectedHeight: 86
      },
      {
        name: '300x171 photo on Retina 3x display (dpr = 3 -> 100x57px)',
        metadata: { originalWidth: 300, originalHeight: 171 },
        size: 'x-large',
        dpr: 3,
        expectedWidth: 100,
        expectedHeight: 57
      },
      {
        name: 'metadata.pixelRatio overrides lower dpr store value',
        metadata: { originalWidth: 400, originalHeight: 200, pixelRatio: 2 },
        size: 'x-large',
        dpr: 1,
        expectedWidth: 200,
        expectedHeight: 100
      },
      {
        name: '2000x1000 large image (capped by maxRem 25rem = 400px)',
        metadata: { originalWidth: 2000, originalHeight: 1000 },
        size: 'x-large',
        expectedWidth: 400,
        expectedHeight: 200
      },
      {
        name: '2000x1000 large image with medium size preset (capped by maxRem 18rem = 288px)',
        metadata: { originalWidth: 2000, originalHeight: 1000 },
        size: 'medium',
        expectedWidth: 288,
        expectedHeight: 144
      }
    ]

    for (const tc of testCases) {
      test(`calculates dimensions for ${tc.name}`, () => {
        const dims = calculateAttachmentDimensions(tc.metadata, tc.size ?? 'x-large', tc.dpr ?? 1)
        expect(dims.width).toBe(tc.expectedWidth)
        expect(dims.height).toBe(tc.expectedHeight)
        expect(dims.fit).toBe(tc.expectedFit ?? 'contain')
        expect(Number.isNaN(dims.width)).toBe(false)
        expect(Number.isNaN(dims.height)).toBe(false)
      })
    }
  })

  // =========================================================================
  // 2. Square-ish Logo Capping (Ratio 0.85 to 1.18)
  // =========================================================================
  describe('Square-ish Logo Capping (6rem = 96px cap for 0.85 <= ratio <= 1.18)', () => {
    const testCases: AttachmentDimensionTestCase[] = [
      {
        name: '160x160 1:1 square image (capped to 96px)',
        metadata: { originalWidth: 160, originalHeight: 160 },
        expectedWidth: 96,
        expectedHeight: 96
      },
      {
        name: '100x85 ratio 0.85 exact lower boundary (capped to 96px)',
        metadata: { originalWidth: 100, originalHeight: 85 },
        expectedWidth: 96,
        expectedHeight: 82
      },
      {
        name: '100x118 ratio 1.18 exact upper boundary (capped to 96px)',
        metadata: { originalWidth: 100, originalHeight: 118 },
        expectedWidth: 81,
        expectedHeight: 96
      },
      {
        name: '1000x840 ratio 0.84 (just outside square cap -> standard max bounds 400px)',
        metadata: { originalWidth: 1000, originalHeight: 840 },
        expectedWidth: 400,
        expectedHeight: 336
      },
      {
        name: '1000x1190 ratio 1.19 (just outside square cap -> standard max bounds 400px)',
        metadata: { originalWidth: 1000, originalHeight: 1190 },
        expectedWidth: 336,
        expectedHeight: 400
      }
    ]

    for (const tc of testCases) {
      test(`evaluates square cap for ${tc.name}`, () => {
        const dims = calculateAttachmentDimensions(tc.metadata, tc.size ?? 'x-large', tc.dpr ?? 1)
        expect(dims.width).toBe(tc.expectedWidth)
        expect(dims.height).toBe(tc.expectedHeight)
      })
    }
  })

  // =========================================================================
  // 3. Micro & Small Single Pixel / Tiny Images
  // =========================================================================
  describe('Micro & Small Single Pixel / Tiny Images', () => {
    const testCases: AttachmentDimensionTestCase[] = [
      {
        name: '1x1 micro single pixel square',
        metadata: { originalWidth: 1, originalHeight: 1 },
        expectedWidth: 1,
        expectedHeight: 1
      },
      {
        name: '2x2 micro square',
        metadata: { originalWidth: 2, originalHeight: 2 },
        expectedWidth: 2,
        expectedHeight: 2
      },
      {
        name: '10x10 small icon',
        metadata: { originalWidth: 10, originalHeight: 10 },
        expectedWidth: 10,
        expectedHeight: 10
      },
      {
        name: '49x49 (just below 50px threshold)',
        metadata: { originalWidth: 49, originalHeight: 49 },
        expectedWidth: 49,
        expectedHeight: 49
      },
      {
        name: '50x50 (exact 50px threshold)',
        metadata: { originalWidth: 50, originalHeight: 50 },
        expectedWidth: 50,
        expectedHeight: 50
      }
    ]

    for (const tc of testCases) {
      test(`calculates dimensions for ${tc.name}`, () => {
        const dims = calculateAttachmentDimensions(tc.metadata, tc.size ?? 'x-large', tc.dpr ?? 1)
        expect(dims.width).toBe(tc.expectedWidth)
        expect(dims.height).toBe(tc.expectedHeight)
      })
    }
  })

  // =========================================================================
  // 4. Ultra-Thin Vertical & Horizontal Lines
  // =========================================================================
  describe('Ultra-Thin Lines (1xX & Xx1)', () => {
    const testCases: AttachmentDimensionTestCase[] = [
      {
        name: '1x10 ultra-thin vertical line',
        metadata: { originalWidth: 1, originalHeight: 10 },
        expectedWidth: 1,
        expectedHeight: 10
      },
      {
        name: '1x100 ultra-thin vertical line',
        metadata: { originalWidth: 1, originalHeight: 100 },
        expectedWidth: 1,
        expectedHeight: 100
      },
      {
        name: '1x500 ultra-thin vertical line (capped by maxHeight 400px)',
        metadata: { originalWidth: 1, originalHeight: 500 },
        expectedWidth: 1,
        expectedHeight: 400
      },
      {
        name: '1x2000 ultra-thin vertical line (capped by maxHeight 400px)',
        metadata: { originalWidth: 1, originalHeight: 2000 },
        expectedWidth: 0,
        expectedHeight: 400
      },
      {
        name: '10x1 ultra-thin horizontal line',
        metadata: { originalWidth: 10, originalHeight: 1 },
        expectedWidth: 10,
        expectedHeight: 1
      },
      {
        name: '100x1 ultra-thin horizontal line',
        metadata: { originalWidth: 100, originalHeight: 1 },
        expectedWidth: 100,
        expectedHeight: 1
      },
      {
        name: '500x1 ultra-thin horizontal line (capped by maxWidth 400px)',
        metadata: { originalWidth: 500, originalHeight: 1 },
        expectedWidth: 400,
        expectedHeight: 1
      },
      {
        name: '2000x1 ultra-thin horizontal line (capped by maxWidth 400px)',
        metadata: { originalWidth: 2000, originalHeight: 1 },
        expectedWidth: 400,
        expectedHeight: 1
      }
    ]

    for (const tc of testCases) {
      test(`calculates line dimensions for ${tc.name}`, () => {
        const dims = calculateAttachmentDimensions(tc.metadata, tc.size ?? 'x-large', tc.dpr ?? 1)
        expect(dims.width).toBe(tc.expectedWidth)
        expect(dims.height).toBe(tc.expectedHeight)
      })
    }
  })

  // =========================================================================
  // 5. Extreme Panoramic & Tall Aspect Ratios
  // =========================================================================
  describe('Extreme Panoramic & Tall Aspect Ratios', () => {
    const testCases: AttachmentDimensionTestCase[] = [
      {
        name: '1200x300 ultra-wide panoramic (4:1 ratio)',
        metadata: { originalWidth: 1200, originalHeight: 300 },
        expectedWidth: 400,
        expectedHeight: 100
      },
      {
        name: '10000x500 super panoramic (20:1 ratio)',
        metadata: { originalWidth: 10000, originalHeight: 500 },
        expectedWidth: 400,
        expectedHeight: 20
      },
      {
        name: '200x800 ultra-tall banner (1:4 ratio)',
        metadata: { originalWidth: 200, originalHeight: 800 },
        expectedWidth: 100,
        expectedHeight: 400
      },
      {
        name: '500x10000 super tall banner (1:20 ratio)',
        metadata: { originalWidth: 500, originalHeight: 10000 },
        expectedWidth: 20,
        expectedHeight: 400
      },
      {
        name: '3840x1080 dual-monitor ultra-wide screenshot',
        metadata: { originalWidth: 3840, originalHeight: 1080 },
        expectedWidth: 400,
        expectedHeight: 113
      }
    ]

    for (const tc of testCases) {
      test(`calculates extreme ratio dimensions for ${tc.name}`, () => {
        const dims = calculateAttachmentDimensions(tc.metadata, tc.size ?? 'x-large', tc.dpr ?? 1)
        expect(dims.width).toBe(tc.expectedWidth)
        expect(dims.height).toBe(tc.expectedHeight)
      })
    }
  })

  // =========================================================================
  // 6. Fallback & Missing Metadata Handling
  // =========================================================================
  describe('Fallback & Missing Metadata Handling', () => {
    test('returns default fallback when metadata is undefined', () => {
      const dims = calculateAttachmentDimensions(undefined, 'x-large', 1)
      expect(dims.width).toBe(300)
      expect(dims.height).toBe(300)
      expect(dims.fit).toBe('contain')
    })

    test('returns default fallback when size is auto', () => {
      const metadata = { originalWidth: 1000, originalHeight: 500 }
      const dims = calculateAttachmentDimensions(metadata, 'auto', 1)
      expect(dims.width).toBe(300)
      expect(dims.height).toBe(300)
      expect(dims.fit).toBe('contain')
    })

    test('falls back to thumbnail dimensions when originalWidth/originalHeight are missing', () => {
      const metadata = {
        thumbnail: { width: 300, height: 150 }
      }
      const dims = calculateAttachmentDimensions(metadata as any, 'x-large', 1)
      expect(dims.width).toBe(300)
      expect(dims.height).toBe(150)
    })
  })
})

// =========================================================================
// 7. Core Low-Level Utility Unit Tests (getImageDimensions)
// =========================================================================
describe('Low-Level Utility Unit Tests (getImageDimensions)', () => {
  test('enforces min bounds when enforceMinBounds option is true', () => {
    const dims = getImageDimensions(
      { width: 1, height: 1 },
      { maxWidth: 25, maxHeight: 25, minWidth: 1, minHeight: 1 },
      { enforceMinBounds: true }
    )

    expect(dims.width).toBe(16)
    expect(dims.height).toBe(16)
  })

  test('ignores min bounds when enforceMinBounds option is false or omitted', () => {
    const dims = getImageDimensions({ width: 1, height: 1 }, { maxWidth: 25, maxHeight: 25, minWidth: 1, minHeight: 1 })

    expect(dims.width).toBe(1)
    expect(dims.height).toBe(1)
  })

  test('returns fit cover for LinkPreview calls below minRem when forceFit is omitted', () => {
    const dims = getImageDimensions(
      { width: 30, height: 30 },
      { maxWidth: 25, maxHeight: 25, minWidth: 4, minHeight: 4 } // minRem 4 = 64px
    )

    // Calculated size (30px) is below minRem (64px), forceFit omitted -> fit is 'cover' for LinkPreview
    expect(dims.fit).toBe('cover')
  })

  test('honors explicit forceFit contain even if size is below minRem', () => {
    const dims = getImageDimensions(
      { width: 30, height: 30 },
      { maxWidth: 25, maxHeight: 25, minWidth: 4, minHeight: 4 },
      { forceFit: 'contain' }
    )

    expect(dims.fit).toBe('contain')
  })
})
