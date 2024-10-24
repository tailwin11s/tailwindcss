import { version } from '../package.json'
import { substituteAtApply } from './apply'
import {
  atRoot,
  comment,
  context as contextNode,
  decl,
  rule,
  toCss,
  walk,
  WalkAction,
  type AstNode,
  type Rule,
} from './ast'
import { substituteAtImports } from './at-import'
import { applyCompatibilityHooks } from './compat/apply-compat-hooks'
import type { UserConfig } from './compat/config/types'
import { type Plugin } from './compat/plugin-api'
import { compileCandidates } from './compile'
import { substituteFunctions } from './css-functions'
import * as CSS from './css-parser'
import { buildDesignSystem, type DesignSystem } from './design-system'
import { Theme, ThemeOptions } from './theme'
import { segment } from './utils/segment'
import { compoundsForSelectors } from './variants'
export type Config = UserConfig

const IS_VALID_PREFIX = /^[a-z]+$/
const IS_VALID_UTILITY_NAME = /^[a-z][a-zA-Z0-9/%._-]*$/

type CompileOptions = {
  base?: string
  loadModule?: (
    id: string,
    base: string,
    resourceHint: 'plugin' | 'config',
  ) => Promise<{ module: Plugin | Config; base: string }>
  loadStylesheet?: (id: string, base: string) => Promise<{ content: string; base: string }>
}

function throwOnLoadModule(): never {
  throw new Error('No `loadModule` function provided to `compile`')
}

function throwOnLoadStylesheet(): never {
  throw new Error('No `loadStylesheet` function provided to `compile`')
}

function parseThemeOptions(selector: string) {
  let options = ThemeOptions.NONE
  let prefix = null

  for (let option of segment(selector.slice(6) /* '@theme'.length */, ' ')) {
    if (option === 'reference') {
      options |= ThemeOptions.REFERENCE
    } else if (option === 'inline') {
      options |= ThemeOptions.INLINE
    } else if (option === 'default') {
      options |= ThemeOptions.DEFAULT
    } else if (option.startsWith('prefix(') && option.endsWith(')')) {
      prefix = option.slice(7, -1)
    }
  }

  return [options, prefix] as const
}

async function parseCss(
  css: string,
  {
    base = '',
    loadModule = throwOnLoadModule,
    loadStylesheet = throwOnLoadStylesheet,
  }: CompileOptions = {},
) {
  let ast = [contextNode({ base }, CSS.parse(css))] as AstNode[]

  await substituteAtImports(ast, base, loadStylesheet)

  let important = null as boolean | null
  let theme = new Theme()
  let customVariants: ((designSystem: DesignSystem) => void)[] = []
  let customUtilities: ((designSystem: DesignSystem) => void)[] = []
  let firstThemeRule = null as Rule | null
  let utilitiesNode = null as Rule | null
  let globs: { base: string; pattern: string }[] = []
  let root:
    | null // Unknown root
    | 'none' // Explicitly no root specified via `source(none)`
    // Specified via `source(…)`, relative to the `base`
    | { base: string; pattern: string } = null

  // Handle at-rules
  walk(ast, (node, { parent, replaceWith, context }) => {
    if (node.kind !== 'rule') return
    if (node.selector[0] !== '@') return

    // Find `@tailwind utilities` so that we can later replace it with the
    // actual generated utility class CSS.
    if (
      utilitiesNode === null &&
      (node.selector === '@tailwind utilities' || node.selector.startsWith('@tailwind utilities '))
    ) {
      let params = segment(node.selector.slice(20).trim(), ' ')
      for (let param of params) {
        if (param.startsWith('source(')) {
          let path = param.slice(7, -1)

          // Keyword: `source(none)`
          if (path === 'none') {
            root = path
            continue
          }

          // Explicit path: `source('…')`
          if (
            (path[0] === '"' && path[path.length - 1] !== '"') ||
            (path[0] === "'" && path[path.length - 1] !== "'") ||
            (path[0] !== "'" && path[0] !== '"')
          ) {
            throw new Error('`source(…)` paths must be quoted.')
          }

          root = {
            base: context.sourceBase ?? context.base,
            pattern: path.slice(1, -1),
          }
        }
      }

      utilitiesNode = node
    }

    // Collect custom `@utility` at-rules
    if (node.selector.startsWith('@utility ')) {
      if (parent !== null) {
        throw new Error('`@utility` cannot be nested.')
      }

      let name = node.selector.slice(9).trim()

      if (!IS_VALID_UTILITY_NAME.test(name)) {
        throw new Error(
          `\`@utility ${name}\` defines an invalid utility name. Utilities should be alphanumeric and start with a lowercase letter.`,
        )
      }

      if (node.nodes.length === 0) {
        throw new Error(
          `\`@utility ${name}\` is empty. Utilities should include at least one property.`,
        )
      }

      customUtilities.push((designSystem) => {
        designSystem.utilities.static(name, (candidate) => {
          if (candidate.negative) return
          return structuredClone(node.nodes)
        })
      })

      return
    }

    // Collect paths from `@source` at-rules
    if (node.selector.startsWith('@source ')) {
      if (node.nodes.length > 0) {
        throw new Error('`@source` cannot have a body.')
      }

      if (parent !== null) {
        throw new Error('`@source` cannot be nested.')
      }

      let path = node.selector.slice(8)
      if (
        (path[0] === '"' && path[path.length - 1] !== '"') ||
        (path[0] === "'" && path[path.length - 1] !== "'") ||
        (path[0] !== "'" && path[0] !== '"')
      ) {
        throw new Error('`@source` paths must be quoted.')
      }
      globs.push({ base: context.base, pattern: path.slice(1, -1) })
      replaceWith([])
      return
    }

    // Register custom variants from `@variant` at-rules
    if (node.selector.startsWith('@variant ')) {
      if (parent !== null) {
        throw new Error('`@variant` cannot be nested.')
      }

      // Remove `@variant` at-rule so it's not included in the compiled CSS
      replaceWith([])

      let [name, selector] = segment(node.selector.slice(9), ' ')

      if (node.nodes.length > 0 && selector) {
        throw new Error(`\`@variant ${name}\` cannot have both a selector and a body.`)
      }

      // Variants with a selector, but without a body, e.g.: `@variant hocus (&:hover, &:focus);`
      if (node.nodes.length === 0) {
        if (!selector) {
          throw new Error(`\`@variant ${name}\` has no selector or body.`)
        }

        let selectors = segment(selector.slice(1, -1), ',')

        let atRuleSelectors: string[] = []
        let styleRuleSelectors: string[] = []

        for (let selector of selectors) {
          selector = selector.trim()

          if (selector[0] === '@') {
            atRuleSelectors.push(selector)
          } else {
            styleRuleSelectors.push(selector)
          }
        }

        customVariants.push((designSystem) => {
          designSystem.variants.static(
            name,
            (r) => {
              let nodes: AstNode[] = []

              if (styleRuleSelectors.length > 0) {
                nodes.push(rule(styleRuleSelectors.join(', '), r.nodes))
              }

              for (let selector of atRuleSelectors) {
                nodes.push(rule(selector, r.nodes))
              }

              r.nodes = nodes
            },
            {
              compounds: compoundsForSelectors([...styleRuleSelectors, ...atRuleSelectors]),
            },
          )
        })

        return
      }

      // Variants without a selector, but with a body:
      //
      // E.g.:
      //
      // ```css
      // @variant hocus {
      //   &:hover {
      //     @slot;
      //   }
      //
      //   &:focus {
      //     @slot;
      //   }
      // }
      // ```
      else {
        customVariants.push((designSystem) => {
          designSystem.variants.fromAst(name, node.nodes)
        })

        return
      }
    }

    if (node.selector.startsWith('@media ')) {
      let params = segment(node.selector.slice(7), ' ')
      let unknownParams: string[] = []

      for (let param of params) {
        // Handle `@media source(…)`
        if (param.startsWith('source(')) {
          let path = param.slice(7, -1)

          walk(node.nodes, (child, { replaceWith }) => {
            if (child.kind !== 'rule') return
            if (child.selector === '@tailwind utilities') {
              child.selector += ` source(${path})`
              replaceWith([contextNode({ sourceBase: context.base }, [child])])
              return WalkAction.Stop
            }
          })
        }

        // Handle `@media theme(…)`
        //
        // We support `@import "tailwindcss/theme" theme(reference)` as a way to
        // import an external theme file as a reference, which becomes `@media
        // theme(reference) { … }` when the `@import` is processed.
        else if (param.startsWith('theme(')) {
          let themeParams = param.slice(6, -1)

          walk(node.nodes, (child) => {
            if (child.kind !== 'rule') {
              throw new Error(
                'Files imported with `@import "…" theme(…)` must only contain `@theme` blocks.',
              )
            }
            if (child.selector === '@theme' || child.selector.startsWith('@theme ')) {
              child.selector += ' ' + themeParams
              return WalkAction.Skip
            }
          })
        }

        // Handle `@media prefix(…)`
        //
        // We support `@import "tailwindcss" prefix(ident)` as a way to
        // configure a theme prefix for variables and utilities.
        else if (param.startsWith('prefix(')) {
          let prefix = param.slice(7, -1)

          walk(node.nodes, (child) => {
            if (child.kind !== 'rule') return
            if (child.selector === '@theme' || child.selector.startsWith('@theme ')) {
              child.selector += ` prefix(${prefix})`
              return WalkAction.Skip
            }
          })
        }

        // Handle important
        else if (param === 'important') {
          important = true
        }

        //
        else {
          unknownParams.push(param)
        }
      }

      if (unknownParams.length > 0) {
        node.selector = `@media ${unknownParams.join(' ')}`
      } else if (params.length > 0) {
        replaceWith(node.nodes)
      }

      return WalkAction.Skip
    }

    // Handle `@theme`
    if (node.selector === '@theme' || node.selector.startsWith('@theme ')) {
      let [themeOptions, themePrefix] = parseThemeOptions(node.selector)

      if (themePrefix) {
        if (!IS_VALID_PREFIX.test(themePrefix)) {
          throw new Error(
            `The prefix "${themePrefix}" is invalid. Prefixes must be lowercase ASCII letters (a-z) only.`,
          )
        }

        theme.prefix = themePrefix
      }

      // Record all custom properties in the `@theme` declaration
      walk(node.nodes, (child, { replaceWith }) => {
        // Collect `@keyframes` rules to re-insert with theme variables later,
        // since the `@theme` rule itself will be removed.
        if (child.kind === 'rule' && child.selector.startsWith('@keyframes ')) {
          theme.addKeyframes(child)
          replaceWith([])
          return WalkAction.Skip
        }

        if (child.kind === 'comment') return
        if (child.kind === 'declaration' && child.property.startsWith('--')) {
          theme.add(child.property, child.value ?? '', themeOptions)
          return
        }

        let snippet = toCss([rule(node.selector, [child])])
          .split('\n')
          .map((line, idx, all) => `${idx === 0 || idx >= all.length - 2 ? ' ' : '>'} ${line}`)
          .join('\n')

        throw new Error(
          `\`@theme\` blocks must only contain custom properties or \`@keyframes\`.\n\n${snippet}`,
        )
      })

      // Keep a reference to the first `@theme` rule to update with the full
      // theme later, and delete any other `@theme` rules.
      if (!firstThemeRule && !(themeOptions & ThemeOptions.REFERENCE)) {
        firstThemeRule = node
      } else {
        replaceWith([])
      }
      return WalkAction.Skip
    }
  })

  let designSystem = buildDesignSystem(theme)

  if (important) {
    designSystem.important = important
  }

  // Apply hooks from backwards compatibility layer. This function takes a lot
  // of random arguments because it really just needs access to "the world" to
  // do whatever ungodly things it needs to do to make things backwards
  // compatible without polluting core.
  await applyCompatibilityHooks({ designSystem, base, ast, loadModule, globs })

  for (let customVariant of customVariants) {
    customVariant(designSystem)
  }

  for (let customUtility of customUtilities) {
    customUtility(designSystem)
  }

  // Output final set of theme variables at the position of the first `@theme`
  // rule.
  if (firstThemeRule) {
    firstThemeRule = firstThemeRule as Rule
    firstThemeRule.selector = ':root'

    let nodes = []

    for (let [key, value] of theme.entries()) {
      if (value.options & ThemeOptions.REFERENCE) continue
      nodes.push(decl(key, value.value))
    }

    let keyframesRules = theme.getKeyframes()
    if (keyframesRules.length > 0) {
      let animationParts = [...theme.namespace('--animate').values()].flatMap((animation) =>
        animation.split(' '),
      )

      for (let keyframesRule of keyframesRules) {
        // Remove any keyframes that aren't used by an animation variable.
        let keyframesName = keyframesRule.selector.slice(11) // `@keyframes `.length
        if (!animationParts.includes(keyframesName)) {
          continue
        }

        // Wrap `@keyframes` in `AtRoot` so they are hoisted out of `:root` when
        // printing.
        nodes.push(
          Object.assign(keyframesRule, atRoot([rule(keyframesRule.selector, keyframesRule.nodes)])),
        )
      }
    }
    firstThemeRule.nodes = nodes
  }

  // Replace `@apply` rules with the actual utility classes.
  substituteAtApply(ast, designSystem)

  substituteFunctions(ast, designSystem.resolveThemeValue)

  // Remove `@utility`, we couldn't replace it before yet because we had to
  // handle the nested `@apply` at-rules first.
  walk(ast, (node, { replaceWith }) => {
    if (node.kind !== 'rule') return

    if (node.selector[0] === '@' && node.selector.startsWith('@utility ')) {
      replaceWith([])
    }

    // The `@utility` has to be top-level, therefore we don't have to traverse
    // into nested trees.
    return WalkAction.Skip
  })

  return {
    designSystem,
    ast,
    globs,
    root,
    utilitiesNode,
  }
}

export async function compile(
  css: string,
  opts: CompileOptions = {},
): Promise<{
  globs: { base: string; pattern: string }[]
  root:
    | null // Unknown root
    | 'none' // Explicitly no root specified via `source(none)`
    | { base: string; pattern: string } // Specified via `source(…)`, relative to the `base`
  build(candidates: string[]): string
}> {
  let { designSystem, ast, globs, root, utilitiesNode } = await parseCss(css, opts)

  if (process.env.NODE_ENV !== 'test') {
    ast.unshift(comment(`! tailwindcss v${version} | MIT License | https://tailwindcss.com `))
  }

  // Track all invalid candidates
  function onInvalidCandidate(candidate: string) {
    designSystem.invalidCandidates.add(candidate)
  }

  // Track all valid candidates, these are the incoming `rawCandidate` that
  // resulted in a generated AST Node. All the other `rawCandidates` are invalid
  // and should be ignored.
  let allValidCandidates = new Set<string>()
  let compiledCss = toCss(ast)
  let previousAstNodeCount = 0

  return {
    globs,
    root,
    build(newRawCandidates: string[]) {
      let didChange = false

      // Add all new candidates unless we know that they are invalid.
      let prevSize = allValidCandidates.size
      for (let candidate of newRawCandidates) {
        if (!designSystem.invalidCandidates.has(candidate)) {
          allValidCandidates.add(candidate)
          didChange ||= allValidCandidates.size !== prevSize
        }
      }

      // If no new candidates were added, we can return the original CSS. This
      // currently assumes that we only add new candidates and never remove any.
      if (!didChange) {
        return compiledCss
      }

      if (utilitiesNode) {
        let newNodes = compileCandidates(allValidCandidates, designSystem, {
          onInvalidCandidate,
        }).astNodes

        // If no new ast nodes were generated, then we can return the original
        // CSS. This currently assumes that we only add new ast nodes and never
        // remove any.
        if (previousAstNodeCount === newNodes.length) {
          return compiledCss
        }

        previousAstNodeCount = newNodes.length

        utilitiesNode.nodes = newNodes
        compiledCss = toCss(ast)
      }

      return compiledCss
    },
  }
}

export async function __unstable__loadDesignSystem(css: string, opts: CompileOptions = {}) {
  let result = await parseCss(css, opts)
  return result.designSystem
}

export default function postcssPluginWarning() {
  throw new Error(
    `It looks like you're trying to use \`tailwindcss\` directly as a PostCSS plugin. The PostCSS plugin has moved to a separate package, so to continue using Tailwind CSS with PostCSS you'll need to install \`@tailwindcss/postcss\` and update your PostCSS configuration.`,
  )
}
