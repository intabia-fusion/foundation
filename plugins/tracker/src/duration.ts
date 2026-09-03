export const MINUTES_IN_HOUR = 60
export const MINUTES_IN_DAY = 8 * MINUTES_IN_HOUR
export const MINUTES_IN_WEEK = 5 * MINUTES_IN_DAY

export interface DurationUnit {
  minutes: number
  labels: Record<string, string>
}

export const durationUnits: DurationUnit[] = [
  {
    minutes: 1,
    labels: {
      en: 'm',
      ru: 'м',
      cs: 'min',
      de: 'min',
      es: 'min',
      fr: 'min',
      it: 'min',
      ja: '分',
      pt: 'min',
      'pt-br': 'min',
      tr: 'dk',
      zh: '分'
    }
  },
  {
    minutes: MINUTES_IN_HOUR,
    labels: {
      en: 'h',
      ru: 'ч',
      cs: 'h',
      de: 'h',
      es: 'h',
      fr: 'h',
      it: 'h',
      ja: '時間',
      pt: 'h',
      'pt-br': 'h',
      tr: 'sa',
      zh: '小时'
    }
  },
  {
    minutes: MINUTES_IN_DAY,
    labels: {
      en: 'd',
      ru: 'д',
      cs: 'd',
      de: 't',
      es: 'd',
      fr: 'j',
      it: 'g',
      ja: '日',
      pt: 'd',
      'pt-br': 'd',
      tr: 'g',
      zh: '天'
    }
  },
  {
    minutes: MINUTES_IN_WEEK,
    labels: {
      en: 'w',
      ru: 'н',
      cs: 'týd',
      de: 'w',
      es: 'sem',
      fr: 'sem',
      it: 'sett',
      ja: '週',
      pt: 'sem',
      'pt-br': 'sem',
      tr: 'hf',
      zh: '周'
    }
  }
]

function normalizeAlias (s: string): string {
  return s.toLowerCase().replace(/\./g, '').trim()
}

const aliasToMinutes = new Map<string, number>()
for (const unit of durationUnits) {
  for (const label of Object.values(unit.labels)) {
    aliasToMinutes.set(normalizeAlias(label), unit.minutes)
  }
}

function unitLabel (minutes: number, language: string): string {
  const unit = durationUnits.find((u) => u.minutes === minutes)
  if (unit === undefined) return ''

  const lang = language.toLowerCase()
  return unit.labels[lang] ?? unit.labels[lang.split('-')[0]] ?? unit.labels.en
}

export function parseDuration (input: string | number): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) ? input : undefined

  let remainingInput = input.toLowerCase().trim()
  if (remainingInput === '') return undefined

  const numberWithUnit = /^\s*(\d+)\s*([^\d\s]+)?/
  let totalMinutes = 0

  while (remainingInput.trim().length > 0) {
    const matchedToken = numberWithUnit.exec(remainingInput)
    if (matchedToken === null) return undefined

    const amount = Number(matchedToken[1])
    const unitAlias = matchedToken[2]

    if (unitAlias === undefined) {
      totalMinutes += amount * MINUTES_IN_HOUR
    } else {
      const minutesPerUnit = aliasToMinutes.get(normalizeAlias(unitAlias))
      if (minutesPerUnit === undefined) return undefined
      totalMinutes += amount * minutesPerUnit
    }
    remainingInput = remainingInput.slice(matchedToken[0].length)
  }

  return totalMinutes / MINUTES_IN_HOUR
}

export function formatDuration (hours: number, language: string = 'en'): string {
  if (!Number.isFinite(hours) || hours < 0) return ''
  const totalMin = Math.round(hours * MINUTES_IN_HOUR)

  const units: Array<[number, number]> = [
    [Math.floor(totalMin / MINUTES_IN_WEEK), MINUTES_IN_WEEK],
    [Math.floor((totalMin % MINUTES_IN_WEEK) / MINUTES_IN_DAY), MINUTES_IN_DAY],
    [Math.floor((totalMin % MINUTES_IN_DAY) / MINUTES_IN_HOUR), MINUTES_IN_HOUR],
    [totalMin % MINUTES_IN_HOUR, 1]
  ]

  const visible = units.filter(([value]) => value > 0)
  if (visible.length === 0) return `0${unitLabel(1, language)}`

  return visible.map(([value, minutes]) => `${value}${unitLabel(minutes, language)}`).join(' ')
}

/**
 * The largest unit that fits plus the next one down: `18w 3d 5h 30m` becomes `18w 3d`, `1d 4h 30m`
 * becomes `1d 4h`. Lists have no room for four units, and the tooltip still carries the exact value.
 */
export function formatDurationCompact (hours: number, language: string = 'en'): string {
  if (!Number.isFinite(hours) || hours < 0) return ''
  const totalMin = Math.round(hours * MINUTES_IN_HOUR)

  const units: Array<[number, number]> = [
    [Math.floor(totalMin / MINUTES_IN_WEEK), MINUTES_IN_WEEK],
    [Math.floor((totalMin % MINUTES_IN_WEEK) / MINUTES_IN_DAY), MINUTES_IN_DAY],
    [Math.floor((totalMin % MINUTES_IN_DAY) / MINUTES_IN_HOUR), MINUTES_IN_HOUR],
    [totalMin % MINUTES_IN_HOUR, 1]
  ]

  const first = units.findIndex(([value]) => value > 0)
  if (first === -1) return `0${unitLabel(1, language)}`

  const visible = units.slice(first, first + 2).filter(([value]) => value > 0)

  return visible.map(([value, minutes]) => `${value}${unitLabel(minutes, language)}`).join(' ')
}

export function durationFormatHint (language: string = 'en'): string {
  return [MINUTES_IN_WEEK, MINUTES_IN_DAY, MINUTES_IN_HOUR, 1]
    .map((minutes) => `1${unitLabel(minutes, language)}`)
    .join(' ')
}
