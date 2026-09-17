import assert from 'node:assert/strict'
import test from 'node:test'
import { codeWorkspaceScope } from '../shared/codeWorkspace.ts'

test('code workspace scope folds Windows path case', () => {
  assert.equal(codeWorkspaceScope('C:\\Work\\Project', 'main'), codeWorkspaceScope('c:\\work\\project', 'main'))
})

test('code workspace scope preserves POSIX path case', () => {
  assert.notEqual(codeWorkspaceScope('/work/Project', 'main'), codeWorkspaceScope('/work/project', 'main'))
})
