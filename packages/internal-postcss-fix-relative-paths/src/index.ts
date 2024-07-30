import path from 'node:path'
import type { AtRule, Container, Plugin } from 'postcss'

const SINGLE_QUOTE = "'"
const DOUBLE_QUOTE = '"'

export default function fixRelativePathsPlugin(): Plugin {
  // Retain a list of touched at-rules to avoid infinite loops
  let touched: WeakSet<AtRule> = new WeakSet()

  function fixRelativePath(atRule: AtRule) {
    let rootPath = getRoot(atRule)?.source?.input.file
    if (!rootPath) {
      return
    }

    let inputFilePath = atRule?.source?.input.file
    if (!inputFilePath) {
      return
    }

    if (touched.has(atRule)) {
      return
    }

    let value = atRule.params[0]

    let quote =
      value[0] === DOUBLE_QUOTE && value[value.length - 1] === DOUBLE_QUOTE
        ? DOUBLE_QUOTE
        : value[0] === SINGLE_QUOTE && value[value.length - 1] === SINGLE_QUOTE
          ? SINGLE_QUOTE
          : null
    if (!quote) {
      return
    }
    let glob = atRule.params.slice(1, -1)

    // We only want to rewrite relative paths.
    if (!glob.startsWith('./') && !glob.startsWith('../')) {
      return
    }

    let absoluteGlob = path.posix.join(
      // Convert Windows paths to posix glob separators
      path.dirname(inputFilePath).replaceAll(path.win32.sep, path.posix.sep),
      glob,
    )
    let absoluteRootPosixPath = path.posix.dirname(
      // Convert Windows paths to posix glob separators
      rootPath.replaceAll(path.win32.sep, path.posix.sep),
    )

    let relative = path.posix.relative(absoluteRootPosixPath, absoluteGlob)

    // TODO: If we fix paths like this, ensure we have tests that cover
    // POSIX style absolute globs on windows in the rust codebase
    console.log({
      absoluteGlob,
      absoluteRootPosixPath,
      relative,
    })

    // If the path points to a file in the same directory, `path.relative` will
    // remove the leading `./` and we need to add it back in order to still
    // consider the path relative
    if (!relative.startsWith('.')) {
      relative = './' + relative
    }

    atRule.params = quote + relative + quote
    touched.add(atRule)
  }

  return {
    postcssPlugin: 'tailwindcss-postcss-fix-relative-paths',
    AtRule: {
      content: fixRelativePath,
      plugin: fixRelativePath,
    },
  }
}

function getRoot(node: AtRule | Container | undefined): Container | undefined {
  if (node?.parent) {
    return getRoot(node.parent as Container)
  }
  return node
}
