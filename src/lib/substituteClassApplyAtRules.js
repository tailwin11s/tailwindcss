import _ from 'lodash'
import postcss from 'postcss'
import didYouMean from 'didyoumean'
import escapeClassName from '../util/escapeClassName'
import prefixSelector from '../util/prefixSelector'
import increaseSpecificity from '../util/increaseSpecificity'

import { flagEnabled } from '../featureFlags'
import applyComplexClasses from '../flagged/applyComplexClasses'

function buildClassTable(css) {
  const classTable = {}

  css.walkRules(rule => {
    if (!_.has(classTable, rule.selector)) {
      classTable[rule.selector] = []
    }
    classTable[rule.selector].push(rule)
  })

  return classTable
}

function buildShadowTable(generatedUtilities) {
  const utilities = postcss.root()

  postcss.root({ nodes: generatedUtilities }).walkAtRules('variants', atRule => {
    utilities.append(atRule.clone().nodes)
  })

  return buildClassTable(utilities)
}

function normalizeClassName(className) {
  return `.${escapeClassName(_.trimStart(className, '.'))}`
}

function findClass(classToApply, classTable, onError) {
  const matches = _.get(classTable, classToApply, [])

  if (_.isEmpty(matches)) {
    return []
  }

  if (matches.length > 1) {
    // prettier-ignore
    throw onError(`\`@apply\` cannot be used with ${classToApply} because ${classToApply} is included in multiple rulesets.`)
  }

  const [match] = matches

  if (match.parent.type !== 'root') {
    // prettier-ignore
    throw onError(`\`@apply\` cannot be used with ${classToApply} because ${classToApply} is nested inside of an at-rule (@${match.parent.name}).`)
  }

  return match.clone().nodes
}

let shadowLookup = null

export default function (config, getProcessedPlugins, configChanged) {
  if (flagEnabled(config, 'applyComplexClasses')) {
    return applyComplexClasses(config, getProcessedPlugins, configChanged)
  }

  return function (css) {
    const classLookup = buildClassTable(css)

    shadowLookup =
      configChanged || !shadowLookup
        ? buildShadowTable(getProcessedPlugins().utilities)
        : shadowLookup

    css.walkRules(rule => {
      rule.walkAtRules('apply', atRule => {
        const classesAndProperties = postcss.list.space(atRule.params)

        /*
         * Don't wreck CSSNext-style @apply rules:
         * http://cssnext.io/features/#custom-properties-set-apply
         *
         * These are deprecated in CSSNext but still playing it safe for now.
         * We might consider renaming this at-rule.
         */
        const [customProperties, classes] = _.partition(classesAndProperties, classOrProperty => {
          return _.startsWith(classOrProperty, '--')
        })

        const decls = _(classes)
          .reject(cssClass => cssClass === '!important')
          .flatMap(cssClass => {
            const classToApply = normalizeClassName(cssClass)
            const onError = message => {
              return atRule.error(message)
            }

            return _.reduce(
              [
                // Find exact class match in user's CSS
                () => {
                  return findClass(classToApply, classLookup, onError)
                },
                // Find exact class match in shadow lookup
                () => {
                  return findClass(classToApply, shadowLookup, onError)
                },
                // Find prefixed version of class in shadow lookup
                () => {
                  return findClass(
                    prefixSelector(config.prefix, classToApply),
                    shadowLookup,
                    onError
                  )
                },
                // Find important-scoped version of class in shadow lookup
                () => {
                  return findClass(
                    increaseSpecificity(config.important, classToApply),
                    shadowLookup,
                    onError
                  )
                },
                // Find important-scoped and prefixed version of class in shadow lookup
                () => {
                  return findClass(
                    increaseSpecificity(
                      config.important,
                      prefixSelector(config.prefix, classToApply)
                    ),
                    shadowLookup,
                    onError
                  )
                },
                () => {
                  const suggestedClass = didYouMean(classToApply, Object.keys(shadowLookup))
                  const suggestionMessage = suggestedClass ? `Did you mean ${suggestedClass}?` : ''

                  // prettier-ignore
                  throw onError(`\`@apply\` cannot be used with \`${classToApply}\` because \`${classToApply}\` either cannot be found, or its actual definition includes a pseudo-selector like :hover, :active, etc. If you're sure that \`${classToApply}\` exists, make sure that any \`@import\` statements are being properly processed *before* Tailwind CSS sees your CSS, as \`@apply\` can only be used for classes in the same CSS tree. ${suggestionMessage}`)
                },
              ],
              (classDecls, candidate) => (!_.isEmpty(classDecls) ? classDecls : candidate()),
              []
            )
          })
          .value()

        _.tap(_.last(classesAndProperties) === '!important', important => {
          decls.forEach(decl => (decl.important = important))
        })

        atRule.before(decls)

        atRule.params = customProperties.join(' ')

        if (_.isEmpty(customProperties)) {
          atRule.remove()
        }
      })
    })
  }
}
