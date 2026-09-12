# Account email localization

`server/account/lang/*.json` holds the email templates (confirmation, recovery, invite, OTP,
admin OTP, API key notifications). Only `server/account-service/src/index.ts` consumes them.

## Non-obvious

- Until FUSIO-1151 the `addStringsLoader(accountId, ...)` there was a `switch` over `en`/`ru`
  only - every other locale file in that directory was dead weight, so a branding with
  `defaultLanguage: 'de'` silently got English mail. Replaced with an `accountTranslations`
  map covering all 12 locales.
- `ru.json` carried the key `InviteSubjectRU` instead of `InviteSubject`, so the Russian
  invitation email fell back to the English subject. Predates this PR.
- `ja.json` never existed in this directory (unlike every other `lang/` dir in the repo); added.
- `.npmignore` excludes `lang/`, but the imports work because rush links the package source.

## Checking for gaps

Compare each locale against `en.json`: a value byte-identical to the English one is usually
untranslated. Legit exceptions are strings that are the same in every language - `URL`,
`API + Webhooks`, the `https://example.com/webhooks` placeholder, `Endpoint` in the romance
locales, `Name`/`Operation` in German.
