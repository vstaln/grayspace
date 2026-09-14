import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOutput, parseError } from './chat.ts'

test('parseOutput deduplicates streaming Codex item updates without repeating text', () => {
  const jsonl = [
    '{"type":"thread.started","thread_id":"th-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.created","item":{"id":"item_0","type":"agent_message","text":""}}',
    '{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"The stars sew"}}',
    '{"type":"item.updated","item":{"id":"item_0","type":"agent_message","text":"The stars sew silver dreams."}}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"The stars sew silver dreams."}}',
    '{"type":"turn.completed"}'
  ].join('\n')

  assert.equal(parseOutput(jsonl), 'The stars sew silver dreams.')
})

test('parseOutput extracts explicit result from Claude Code output', () => {
  const claudeJson = JSON.stringify({
    duration_api_ms: 100,
    is_error: false,
    result: 'Hello from Claude',
    type: 'result'
  })

  assert.equal(parseOutput(claudeJson), 'Hello from Claude')
})

test('parseOutput accumulates deltas correctly', () => {
  const deltas = [
    '{"type":"response.output_text.delta","delta":"Hello"}',
    '{"type":"response.output_text.delta","delta":" world"}'
  ].join('\n')

  assert.equal(parseOutput(deltas), 'Hello world')
})

test('parseOutput falls back to raw text if no JSON matches', () => {
  assert.equal(parseOutput('Plain model response'), 'Plain model response')
})

test('parseError surfaces stdout result when stderr is empty or only deprecations', () => {
  const stdout = JSON.stringify({
    type: 'result',
    is_error: true,
    result: "There's an issue with the selected model (claude-old). It may not exist."
  })
  const deprecationStderr = 'The model is deprecated and will reach end-of-life soon.'

  const error = parseError(deprecationStderr, stdout, 'Claude', 1)
  assert.equal(error, "There's an issue with the selected model (claude-old). It may not exist.")
})

test('parseError uses stderr when stderr has an explicit error', () => {
  const stderr = 'Error: API key is invalid'
  const error = parseError(stderr, '', 'Claude', 1)
  assert.equal(error, 'Error: API key is invalid')
})

test('parseError falls back to generic message when stdout and stderr are empty', () => {
  const error = parseError('', '', 'Claude', 1)
  assert.equal(error, 'Claude returned exit code 1. Connect the account in Settings and try again.')
})
