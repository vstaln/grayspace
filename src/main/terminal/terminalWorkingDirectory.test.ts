import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { preferredTerminalCwd } from './terminalWorkingDirectory.ts'

const HOME = process.platform === 'win32' ? 'C:\\Users\\user' : '/home/user'
const PROJECT = process.platform === 'win32' ? 'C:\\Users\\user\\Desktop\\Orcpace' : '/home/user/orcspace'
const ELSEWHERE = process.platform === 'win32' ? 'D:\\work\\api' : '/work/api'

describe('preferred terminal working directory', () => {
  it('honours an explicitly requested directory over everything', () => {
    assert.equal(
      preferredTerminalCwd({ requested: ELSEWHERE, saved: PROJECT, workspace: PROJECT, home: HOME }),
      ELSEWHERE
    )
  })

  it('keeps a saved directory somebody chose', () => {
    assert.equal(
      preferredTerminalCwd({ saved: ELSEWHERE, workspace: PROJECT, home: HOME }),
      ELSEWHERE
    )
  })

  it('replaces a saved home directory with the open workspace', () => {
    // The bug this exists for: a terminal opened before any folder was open
    // snapshots the home-directory fallback and stays there for good, so its
    // agent writes sessions into a different project than the one on screen.
    assert.equal(
      preferredTerminalCwd({ saved: HOME, workspace: PROJECT, home: HOME }),
      PROJECT
    )
  })

  it('ignores trailing separators and case when recognising the fallback', () => {
    const noisy = process.platform === 'win32' ? 'c:\\users\\USER\\' : `${HOME}/`
    assert.equal(preferredTerminalCwd({ saved: noisy, workspace: PROJECT, home: HOME }), PROJECT)
  })

  it('keeps the saved directory when no workspace is open', () => {
    assert.equal(preferredTerminalCwd({ saved: HOME, home: HOME }), HOME)
  })

  it('falls back to the workspace for a terminal with no history', () => {
    assert.equal(preferredTerminalCwd({ workspace: PROJECT, home: HOME }), PROJECT)
  })

  it('returns nothing when there is nothing to go on', () => {
    assert.equal(preferredTerminalCwd({ home: HOME }), undefined)
  })
})
