import { formatDuration, formatDurationCompact } from '../duration'

describe('duration formatting', () => {
  it('keeps every unit in the full form', () => {
    expect(formatDuration(18 * 5 * 8 + 3 * 8 + 5.5)).toEqual('749h 30m')
    expect(formatDuration(8 + 4)).toEqual('12h')
    expect(formatDuration(0)).toEqual('0m')
  })

  it('keeps the largest unit and the next one down', () => {
    expect(formatDurationCompact(18 * 5 * 8 + 3 * 8 + 5.5)).toEqual('18w 3d')
    expect(formatDurationCompact(1 * 5 * 8 + 4 * 8 + 7.5)).toEqual('1w 4d')
    expect(formatDurationCompact(8 + 4)).toEqual('1d 4h')
    expect(formatDurationCompact(2 + 20 / 60)).toEqual('2h 20m')
    expect(formatDurationCompact(2)).toEqual('2h')
    expect(formatDurationCompact(0.5)).toEqual('30m')
    expect(formatDurationCompact(0)).toEqual('0m')
  })

  it('drops the second unit when it is zero', () => {
    expect(formatDurationCompact(5 * 8 + 5)).toEqual('1w')
    expect(formatDurationCompact(8 + 20 / 60)).toEqual('1d')
  })
})
