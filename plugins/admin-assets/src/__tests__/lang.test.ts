import { makeLocalesTest } from '@hcengineering/platform'

const langs = ['cs', 'de', 'es', 'fr', 'it', 'ja', 'pt', 'pt-br', 'ru', 'tr', 'zh']

// Keys whose English wording is also correct in at least one of the locales above
// (loanwords and internationalisms). A newly added key does not belong here - translate it instead.
const sameAsEnglish = new Set([
  'AI', // tab label is the product term
  'Actions', // fr
  'Audit',
  'Backup',
  'Backups',
  'Blobs',
  'Data',
  'Date',
  'Details',
  'Disk',
  'Email',
  'General',
  'Info',
  'Minute1',
  'Minutes15',
  'Minutes5',
  'Mode',
  'Name',
  'OtpCode',
  'Page',
  'Plan',
  'Provider',
  'Region',
  'Role',
  'Service',
  'Services',
  'Sessions', // fr
  'SortName',
  'Status',
  'Total',
  'TrialingOnly',
  'Tx',
  'Type',
  'Url',
  'Uuid'
])

async function load (lang: string): Promise<Record<string, string>> {
  return (await import(`../../lang/${lang}.json`)).string
}

it(
  'Locales are equale',
  makeLocalesTest(async (lang) => await import(`../../lang/${lang}.json`))
)

it('every locale defines the same keys as en', async () => {
  const expected = Object.keys(await load('en')).sort((a, b) => a.localeCompare(b))

  for (const lang of langs) {
    const actual = Object.keys(await load(lang)).sort((a, b) => a.localeCompare(b))
    expect({ lang, keys: actual }).toEqual({ lang, keys: expected })
  }
})

it('every locale translates its strings', async () => {
  const en = await load('en')

  for (const lang of langs) {
    const strings = await load(lang)
    const untranslated = Object.keys(en).filter((key) => strings[key] === en[key] && !sameAsEnglish.has(key))
    expect({ lang, untranslated }).toEqual({ lang, untranslated: [] })
  }
})
