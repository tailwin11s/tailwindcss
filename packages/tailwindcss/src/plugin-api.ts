import { objectToAst, rule, type CssInJs } from './ast'
import type { Candidate } from './candidate'
import type { DesignSystem } from './design-system'
import { withAlpha, withNegative } from './utilities'
import { inferDataType } from './utils/infer-data-type'

export type PluginAPI = {
  addVariant(name: string, variant: string | string[] | CssInJs): void
  addUtilities(utilities: Record<string, CssInJs>, options?: {}): void
  matchUtilities(
    utilities: Record<string, (value: string, extra: { modifier: string | null }) => CssInJs>,
    options?: Partial<{
      type: string | string[]

      supportsNegativeValues: boolean

      values: Record<string, string>
      modifiers: 'any' | Record<string, string>
    }>,
  ): void
}

const IS_VALID_UTILITY_NAME = /^[a-z][a-zA-Z0-9/%._-]*$/

function resolveCandidateValue(
  value: Extract<Candidate, { kind: 'functional' }>['value'],
  list: Record<string, string>,
) {
  if (!value) return list.DEFAULT ?? null

  if (value.kind === 'arbitrary') return value.value

  return list[value.value] ?? null
}

function resolveCandidateModifier(
  modifier: Extract<Candidate, { kind: 'functional' }>['modifier'],
  list: Record<string, string> | 'any' | null,
  types: string[],
) {
  if (!modifier || !list) return null

  // If bare modifiers are supported or the modifier is arbitrary, just return the value
  if (list === 'any' || modifier.kind === 'arbitrary') return modifier.value

  // If there's a match in the lookup list, use that
  if (list[modifier.value]) return list[modifier.value]

  // Color utilities implicitly support all numeric modifiers as opacity values (0-100) which are
  // converted to percentages.
  if (types.includes('color') && !Number.isNaN(Number(modifier.value))) {
    return `${modifier.value}%`
  }

  return null
}

export function buildPluginApi(designSystem: DesignSystem): PluginAPI {
  let theme = designSystem.theme

  return {
    addVariant(name, variant) {
      // Single selector
      if (typeof variant === 'string') {
        designSystem.variants.static(name, (r) => {
          r.nodes = [rule(variant, r.nodes)]
        })
      }

      // Multiple parallel selectors
      else if (Array.isArray(variant)) {
        designSystem.variants.static(name, (r) => {
          r.nodes = variant.map((selector) => rule(selector, r.nodes))
        })
      }

      // CSS-in-JS object
      else if (typeof variant === 'object') {
        designSystem.variants.fromAst(name, objectToAst(variant))
      }
    },

    addUtilities(utilities) {
      for (let [name, css] of Object.entries(utilities)) {
        if (name[0] !== '.' || !IS_VALID_UTILITY_NAME.test(name.slice(1))) {
          throw new Error(
            `\`addUtilities({ '${name}' : … })\` defines an invalid utility selector. Utilities must be a single class name and start with a lowercase letter, eg. \`.scrollbar-none\`.`,
          )
        }

        designSystem.utilities.static(name.slice(1), (candidate) => {
          if (candidate.negative) return

          return objectToAst(css)
        })
      }
    },

    matchUtilities(utilities, options) {
      let types = options?.type
        ? Array.isArray(options?.type)
          ? options.type
          : [options.type]
        : ['any']

      for (let [name, fn] of Object.entries(utilities)) {
        if (!IS_VALID_UTILITY_NAME.test(name)) {
          throw new Error(
            `\`matchUtilities({ '${name}' : … })\` defines an invalid utility name. Utilities should be alphanumeric and start with a lowercase letter, eg. \`scrollbar\`.`,
          )
        }

        designSystem.utilities.functional(name, (candidate) => {
          // A negative utility was provided but is unsupported
          if (!options?.supportsNegativeValues && candidate.negative) return

          // Throw out any candidate whose value is not a supported type
          if (candidate.value?.kind === 'arbitrary' && types.length > 0 && !types.includes('any')) {
            // The candidate has an explicit data type but it's not in the list
            // of supported types by this utility. For example, a `scrollbar`
            // utility that is only used to change the scrollbar color but is
            // used with a `length` value: `scrollbar-[length:var(--whatever)]`
            if (candidate.value.dataType && !types.includes(candidate.value.dataType)) {
              return
            }

            // The candidate does not have an explicit data type and the value
            // cannot be inferred as one of the supported types. For example, a
            // `scrollbar` utility that is only used to change the scrollbar
            // color but is used with a `length` value: `scrollbar-[33px]`
            if (
              !candidate.value.dataType &&
              !inferDataType(candidate.value.value, types as any[])
            ) {
              return
            }
          }

          let isColor = types.includes('color')

          let values = options?.values ?? {}

          if (isColor) {
            // Color utilities implicitly support `inherit`, `transparent`, and `currentColor`
            // for backwards compatibility but still allow them to be overriden
            values = {
              inherit: 'inherit',
              transparent: 'transparent',
              current: 'currentColor',
              ...values,
            }
          }

          let value = resolveCandidateValue(candidate.value, values)

          if (!value) return

          let modifiers = options?.modifiers ?? null

          if (isColor) {
            // Color utilities implicitly support opacity modifiers when no modifiers are provided
            modifiers = modifiers ?? Object.fromEntries(theme.namespace('--opacity').entries())
          }

          let modifier = resolveCandidateModifier(candidate.modifier, modifiers, types)

          // A modifier was provided but its invalid
          if (candidate.modifier && !modifier) {
            // For arbitrary values, return `null` to avoid falling through to the next utility
            return candidate.value?.kind === 'arbitrary' ? null : undefined
          }

          if (isColor && modifier) {
            value = withAlpha(value, modifier)
          }

          if (candidate.negative) {
            value = withNegative(value, candidate)
          }

          return objectToAst(fn(value, { modifier }))
        })
      }
    },
  }
}
