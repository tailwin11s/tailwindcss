import { __unstable__loadDesignSystem } from '@tailwindcss/node'
import { expect, test } from 'vitest'
import { arbitraryValueToBareValue } from './arbitrary-value-to-bare-value'

test.each([
  ['aspect-[12/34]', 'aspect-12/34'],
  ['aspect-[1.2/34]', 'aspect-[1.2/34]'],
  ['col-start-[7]', 'col-start-7'],
  ['flex-[2]', 'flex-2'], // `flex` is implemented as static and functional utilities

  // Only 50-200% (inclusive) are valid:
  // https://developer.mozilla.org/en-US/docs/Web/CSS/font-stretch#percentage
  ['font-stretch-[50%]', 'font-stretch-50%'],
  ['font-stretch-[201%]', 'font-stretch-[201%]'],
  ['font-stretch-[49%]', 'font-stretch-[49%]'],
  // Should stay as-is
  ['font-stretch-[1/2]', 'font-stretch-[1/2]'],

  // This test in itself is a bit flawed because `text-[1/2]` currently
  // generates something. Converting it to `text-1/2` doesn't produce anything.
  ['text-[1/2]', 'text-[1/2]'],

  ['data-[selected]:flex', 'data-selected:flex'],
  ['data-[foo=bar]:flex', 'data-[foo=bar]:flex'],

  ['supports-[gap]:flex', 'supports-gap:flex'],
  ['supports-[display:grid]:flex', 'supports-[display:grid]:flex'],

  ['group-data-[selected]:flex', 'group-data-selected:flex'],
  ['group-data-[foo=bar]:flex', 'group-data-[foo=bar]:flex'],
  ['group-has-data-[selected]:flex', 'group-has-data-selected:flex'],

  ['aria-[selected]:flex', 'aria-[selected]:flex'],
  ['aria-[selected="true"]:flex', 'aria-selected:flex'],
  ['aria-[selected*="true"]:flex', 'aria-[selected*="true"]:flex'],

  ['group-aria-[selected]:flex', 'group-aria-[selected]:flex'],
  ['group-aria-[selected="true"]:flex', 'group-aria-selected:flex'],
  ['group-has-aria-[selected]:flex', 'group-has-aria-[selected]:flex'],

  ['max-lg:hover:data-[selected]:flex!', 'max-lg:hover:data-selected:flex!'],
  [
    'data-[selected]:aria-[selected="true"]:aspect-[12/34]',
    'data-selected:aria-selected:aspect-12/34',
  ],
])('%s => %s', async (candidate, result) => {
  let designSystem = await __unstable__loadDesignSystem('@import "tailwindcss";', {
    base: __dirname,
  })

  expect(arbitraryValueToBareValue(designSystem, {}, candidate)).toEqual(result)
})
