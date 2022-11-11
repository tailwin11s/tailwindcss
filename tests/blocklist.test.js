import { run, html, css } from './util/run'

let warn

beforeEach(() => {
  warn = jest.spyOn(require('../src/util/log').default, 'warn')
})

afterEach(() => warn.mockClear())

it('can block classes matched literally', () => {
  let config = {
    content: [{ raw: html`<div class="font-bold uppercase hover:text-sm bg-red-500/50"></div>` }],
    blocklist: ['uppercase', 'hover:text-sm', 'bg-red-500/50'],
  }

  return run('@tailwind utilities', config).then((result) => {
    return expect(result.css).toMatchCss(css`
      .font-bold {
        font-weight: 700;
      }
    `)
  })
})

it('blocklists do NOT support regexes', async () => {
  let config = {
    content: [{ raw: html`<div class="font-bold bg-[#f00d1e]"></div>` }],
    blocklist: [/^bg-\[[^]+\]$/],
  }

  let result = await run('@tailwind utilities', config)

  expect(result.css).toMatchCss(css`
    .bg-\[\#f00d1e\] {
      --tw-bg-opacity: 1;
      background-color: rgb(240 13 30 / var(--tw-bg-opacity));
    }
    .font-bold {
      font-weight: 700;
    }
  `)

  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls.map((x) => x[0])).toEqual(['blocklist-invalid'])
})

it('can block classes generated by the safelist', () => {
  let config = {
    content: [{ raw: html`<div class="font-bold"></div>` }],
    safelist: [{ pattern: /^bg-red-(400|500)$/ }],
    blocklist: ['bg-red-500'],
  }

  return run('@tailwind utilities', config).then((result) => {
    return expect(result.css).toMatchCss(css`
      .bg-red-400 {
        --tw-bg-opacity: 1;
        background-color: rgb(248 113 113 / var(--tw-bg-opacity));
      }
      .font-bold {
        font-weight: 700;
      }
    `)
  })
})
