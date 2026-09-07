import { layoutColumns, type LaidOutSpan } from '../layout'

function span (date: number, dueDate: number): LaidOutSpan {
  return { date, dueDate, cols: 1, index: 0 }
}

function boxes (spans: LaidOutSpan[]): Array<[number, number]> {
  return spans.map((it) => [it.index / it.cols, (it.index + 1) / it.cols])
}

function overlaps (spans: LaidOutSpan[]): boolean {
  const rects = boxes(spans)
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const timeHits = spans[i].date < spans[j].dueDate && spans[i].dueDate > spans[j].date
      const spaceHits = rects[i][0] < rects[j][1] && rects[i][1] > rects[j][0]
      if (timeHits && spaceHits) return true
    }
  }
  return false
}

describe('layoutColumns', () => {
  it('gives a lone span the whole width', () => {
    const spans = [span(0, 10)]
    layoutColumns(spans)
    expect(spans[0]).toMatchObject({ cols: 1, index: 0 })
  })

  it('splits two overlapping spans', () => {
    const spans = [span(0, 10), span(5, 15)]
    layoutColumns(spans)
    expect(spans.map((it) => it.index)).toEqual([0, 1])
    expect(spans.every((it) => it.cols === 2)).toBe(true)
  })

  it('agrees on the column count across a chain', () => {
    // B overlaps both A and C, but A and C do not touch - deciding per span would hand B three
    // columns while A keeps two, and the two boxes would overlap on screen.
    const spans = [span(0, 10), span(5, 15), span(12, 20)]
    layoutColumns(spans)
    expect(spans.every((it) => it.cols === 2)).toBe(true)
    expect(spans.map((it) => it.index)).toEqual([0, 1, 0])
    expect(overlaps(spans)).toBe(false)
  })

  it('starts a new cluster once the previous one ends', () => {
    const spans = [span(0, 10), span(5, 15), span(20, 30)]
    layoutColumns(spans)
    expect(spans[2]).toMatchObject({ cols: 1, index: 0 })
  })

  it('reuses a freed column', () => {
    const spans = [span(0, 30), span(5, 10), span(12, 20)]
    layoutColumns(spans)
    expect(spans.map((it) => it.index)).toEqual([0, 1, 1])
    expect(overlaps(spans)).toBe(false)
  })

  it('never overlaps on a dense random day', () => {
    const spans: LaidOutSpan[] = []
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 200; i++) {
      const start = Math.floor(rnd() * 1440)
      spans.push(span(start, start + 1 + Math.floor(rnd() * 240)))
    }
    spans.sort((a, b) => a.date - b.date)
    layoutColumns(spans)
    expect(overlaps(spans)).toBe(false)
  })

  it('touching spans share a column', () => {
    const spans = [span(0, 10), span(10, 20)]
    layoutColumns(spans)
    expect(spans.map((it) => it.index)).toEqual([0, 0])
    expect(spans.every((it) => it.cols === 1)).toBe(true)
  })
})
