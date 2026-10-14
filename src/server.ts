import { Plugin } from '@opencode/plugin'
import { CompletionCheckCommandPlugin } from './completion-check-command.js'
import { CompletionCheckCommandSetup } from './v2.js'

export default {
  ...Plugin.define({
    id: 'opencode-completion-check-command',
    setup: CompletionCheckCommandSetup,
  }),
  server: CompletionCheckCommandPlugin,
}
