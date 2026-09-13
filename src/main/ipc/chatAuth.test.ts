import assert from 'node:assert/strict'
import test from 'node:test'
import { extractChatAuthDetails } from './chatAuth.ts'

test('extracts the real Codex device URL and variable-length user code', () => {
  const output = '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\u001b[94mB2P6-6C88G\u001b[0m'
  assert.deepEqual(extractChatAuthDetails(output, ['openai.com']), {
    url: 'https://auth.openai.com/codex/device',
    userCode: 'B2P6-6C88G',
    requiresInput: false
  })
})

test('detects the Claude callback-code prompt', () => {
  const output = "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted >"
  assert.deepEqual(extractChatAuthDetails(output, ['claude.com']), {
    url: 'https://claude.com/cai/oauth/authorize?code=true',
    userCode: undefined,
    requiresInput: true
  })
})

test('does not surface an untrusted URL from CLI output', () => {
  const output = 'Visit https://attacker.example/login then https://accounts.x.ai/device.'
  assert.equal(extractChatAuthDetails(output, ['x.ai']).url, 'https://accounts.x.ai/device')
})
