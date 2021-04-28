import { asList } from '../jit/pluginUtils'
import createUtilityPlugin from '../util/createUtilityPlugin'

export default function () {
  return createUtilityPlugin('gridTemplateRows', [['grid-rows', ['gridTemplateRows']]], {
    resolveArbitraryValue: asList,
  })
}
