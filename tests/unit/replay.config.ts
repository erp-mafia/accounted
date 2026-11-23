// Runs unit test files in exactly the order REPLAY_FILES names them
// (comma-separated), one after another in one worker: the files a worker ran
// before a test that fails only beside other files. A failing test prints the
// command (tests/unit/isolate-modules.ts). Drop files from the front of the
// list until the failure goes away to find the one that leaves state behind.
import { mergeConfig } from 'vitest/config'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import base from '../../vitest.config'

const order = (process.env.REPLAY_FILES ?? '').split(',').filter(Boolean)
if (order.length === 0) throw new Error('tests/unit/replay.config.ts: set REPLAY_FILES to the files to replay, in order')

class InGivenOrder extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    const position = (f: TestSpecification) => order.findIndex((o) => f.moduleId.endsWith(o))
    return [...files].sort((a, b) => position(a) - position(b))
  }
}

export default mergeConfig(base, { test: { sequence: { sequencer: InGivenOrder } } })
