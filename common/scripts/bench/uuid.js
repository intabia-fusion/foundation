module.exports = (m) => {
  const v4 = m.v4 ?? m.default?.v4
  const validate = m.validate ?? m.default?.validate
  const parse = m.parse ?? m.default?.parse
  const sample = v4()
  const cases = [{ name: 'v4()', run: () => v4() }]
  if (validate !== undefined) cases.push({ name: 'validate()', run: () => validate(sample) })
  if (parse !== undefined) cases.push({ name: 'parse()', run: () => parse(sample) })
  return cases
}
