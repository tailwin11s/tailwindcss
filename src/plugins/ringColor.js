import flattenColorPalette from '../util/flattenColorPalette'
import withAlphaVariable from '../util/withAlphaVariable'

export default function () {
  return function ({ matchUtilities2, theme, variants }) {
    matchUtilities2(
      {
        ring: (value) => {
          return withAlphaVariable({
            color: value,
            property: '--tw-ring-color',
            variable: '--tw-ring-opacity',
          })
        },
      },
      {
        values: Object.fromEntries(
          Object.entries(flattenColorPalette(theme('ringColor'))).filter(
            ([modifier]) => modifier !== 'DEFAULT'
          )
        ),
        variants: variants('ringColor'),
        type: 'color',
      }
    )
  }
}
