// jsdom ships no matchMedia, and importing the ui index pulls in players and layout helpers that use it.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

// jsdom has no PointerEvent; the separator is driven entirely by pointer events.
if ((globalThis as any).PointerEvent === undefined) {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number
    constructor (type: string, params: MouseEventInit & { pointerId?: number } = {}) {
      super(type, params)
      this.pointerId = params.pointerId ?? 1
    }
  }
  ;(globalThis as any).PointerEvent = PointerEventPolyfill
}
