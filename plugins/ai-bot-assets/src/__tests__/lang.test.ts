import { makeLocalesTest } from '@hcengineering/platform'

it(
  'Locales are equale',
  makeLocalesTest(async (lang) => await import(`../../lang/${lang}.json`))
)
