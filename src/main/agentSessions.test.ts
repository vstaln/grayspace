import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeProjectSlug,
  claudeProjectSlugUnicode,
  listAgentConversations,
  parseAntigravityHistory,
  parseClaudeTitle,
  parseCodexMeta,
  parseCodexTitle,
  readChunk,
  samePath,
  epochMs
} from './agentSessions.ts'

const WORKSPACE = process.platform === 'win32' ? 'C:\\Users\\dev\\Project' : '/home/dev/Project'

function jsonl(...entries: unknown[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'orcspace-agent-sessions-'))
}

function writeFileAt(path: string, contents: string, mtimeSeconds?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds)
}

describe('agentSessions - path handling', () => {
  test('claude slug replaces every non-alphanumeric character', () => {
    assert.equal(claudeProjectSlug('C:\\Users\\user\\Desktop\\Orcpace'), 'C--Users-user-Desktop-Orcpace')
  })

  test('claude slug ignores a trailing separator', () => {
    assert.equal(claudeProjectSlug('C:\\Users\\user\\Orcpace\\'), claudeProjectSlug('C:\\Users\\user\\Orcpace'))
  })

  test('samePath ignores trailing separators', () => {
    assert.ok(samePath(`${WORKSPACE}${process.platform === 'win32' ? '\\' : '/'}`, WORKSPACE))
  })

  test('samePath rejects a different folder', () => {
    assert.equal(samePath(WORKSPACE, `${WORKSPACE}-other`), false)
  })

  test('samePath rejects empty input', () => {
    assert.equal(samePath('', WORKSPACE), false)
  })

  if (process.platform === 'win32') {
    test('samePath ignores case and separator style on Windows', () => {
      assert.ok(samePath('C:/users/DEV/project', 'C:\\Users\\dev\\Project'))
    })
  }
})

describe('agentSessions - timestamps', () => {
  test('milliseconds pass through', () => {
    assert.equal(epochMs(1_786_725_015_139), 1_786_725_015_139)
  })

  test('seconds are scaled, so a history in seconds is not dated to 1970', () => {
    assert.equal(epochMs(1_786_725_015), 1_786_725_015_000)
  })

  test('nothing usable reads as zero', () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '1700000000', null, undefined, {}]) {
      assert.equal(epochMs(value), 0, String(value))
    }
  })
})

describe('agentSessions - transcript parsing', () => {
  test('claude title takes the first real user message', () => {
    const head = jsonl(
      { type: 'mode', mode: 'normal' },
      { type: 'user', isMeta: true, message: { role: 'user', content: '<command-name>/init</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'fix the terminal flicker' } },
      { type: 'user', message: { role: 'user', content: 'second message' } }
    )
    assert.equal(parseClaudeTitle(head), 'fix the terminal flicker')
  })

  test('claude title reads list-shaped content and skips sidechains', () => {
    const head = jsonl(
      { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '  add  a  planner  ' }] } }
    )
    assert.equal(parseClaudeTitle(head), 'add a planner')
  })

  test('claude title is empty when only injected prompts exist', () => {
    assert.equal(parseClaudeTitle(jsonl({ type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } })), '')
  })

  test('a slash command names a conversation that has nothing else', () => {
    const head = jsonl(
      { type: 'user', message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
      { type: 'user', message: { role: 'user', content: '/code-review' } }
    )
    assert.equal(parseClaudeTitle(head), '/code-review')
  })

  test('a real sentence still wins over an earlier slash command', () => {
    const head = jsonl(
      { type: 'user', message: { role: 'user', content: '/model opus' } },
      { type: 'user', message: { role: 'user', content: 'fix the resume panel' } }
    )
    assert.equal(parseClaudeTitle(head), 'fix the resume panel')
  })

  test('codex prefers a typed prompt over a slash command too', () => {
    const head = jsonl(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '/status' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship the release' }] } }
    )
    assert.equal(parseCodexTitle(head), 'ship the release')
  })

  test('malformed lines never throw', () => {
    assert.equal(parseClaudeTitle('not json\n{"broken":\n'), '')
    assert.equal(parseCodexTitle(''), '')
    assert.equal(parseCodexMeta('{'), null)
  })

  test('codex meta reads session id and cwd', () => {
    const head = jsonl({ type: 'session_meta', payload: { session_id: '01a09fb3-9b74-7e10-9291-5d6ec6db29e3', cwd: WORKSPACE } })
    assert.deepEqual(parseCodexMeta(head), { id: '01a09fb3-9b74-7e10-9291-5d6ec6db29e3', cwd: WORKSPACE })
  })

  test('codex meta rejects an unusable session id', () => {
    assert.equal(parseCodexMeta(jsonl({ type: 'session_meta', payload: { session_id: 'a b; rm -rf /', cwd: WORKSPACE } })), null)
  })

  test('codex title skips the injected plugin prompt', () => {
    const head = jsonl(
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>…</recommended_plugins>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sure' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add 100 items' }] } }
    )
    assert.equal(parseCodexTitle(head), 'add 100 items')
  })

  test('antigravity falls back to a slash command when it is the only prompt', () => {
    const tail = jsonl(
      { display: '/effort low', timestamp: 10, workspace: WORKSPACE, conversationId: '7dfebd3e-1f05-440e-a728-71118e1ffe9f' },
      { display: '/model fast', timestamp: 20, workspace: WORKSPACE, conversationId: '7dfebd3e-1f05-440e-a728-71118e1ffe9f' }
    )
    const found = parseAntigravityHistory(tail, WORKSPACE)
    assert.equal(found.length, 1)
    assert.equal(found[0].title, '/effort low')
    // Seconds in the history, milliseconds in the result.
    assert.equal(found[0].updatedAt, 20_000)
  })

  test('antigravity history groups prompts by conversation', () => {
    const tail = jsonl(
      { display: '/effort low', timestamp: 10, workspace: WORKSPACE, type: 'slash_command' },
      { display: 'first prompt', timestamp: 20, workspace: WORKSPACE, conversationId: '5dfebd3e-1f05-440e-a728-71118e1ffe9f' },
      { display: 'later prompt', timestamp: 90, workspace: WORKSPACE, conversationId: '5dfebd3e-1f05-440e-a728-71118e1ffe9f' },
      { display: 'other folder', timestamp: 95, workspace: `${WORKSPACE}-other`, conversationId: '6dfebd3e-1f05-440e-a728-71118e1ffe9f' }
    )
    const found = parseAntigravityHistory(tail, WORKSPACE)
    assert.equal(found.length, 1)
    assert.equal(found[0].title, 'first prompt')
    assert.equal(found[0].updatedAt, 90_000)
    assert.equal(found[0].command, 'agy --conversation 5dfebd3e-1f05-440e-a728-71118e1ffe9f')
  })
})

describe('agentSessions - windowed reads', () => {
  test('a tail keeps the newest whole lines and drops the cut one', async () => {
    const home = makeHome()
    try {
      const file = join(home, 'history.jsonl')
      writeFileAt(file, 'aaaa\nbbbb\ncccc\ndddd\n')
      assert.equal(await readChunk(file, 11, true), 'cccc\ndddd\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a head keeps the oldest whole lines and drops the cut one', async () => {
    const home = makeHome()
    try {
      const file = join(home, 'history.jsonl')
      writeFileAt(file, 'aaaa\nbbbb\ncccc\n')
      assert.equal(await readChunk(file, 7, false), 'aaaa\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a window wider than the file returns all of it', async () => {
    const home = makeHome()
    try {
      const file = join(home, 'history.jsonl')
      writeFileAt(file, 'only\n')
      assert.equal(await readChunk(file, 4096, true), 'only\n')
      assert.equal(await readChunk(file, 4096, false), 'only\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a multibyte character split by the window never reaches a kept line', async () => {
    const home = makeHome()
    try {
      const file = join(home, 'history.jsonl')
      writeFileAt(file, 'привет\nмир\n')
      const tail = await readChunk(file, 10, true)
      assert.ok(!tail.includes('�'), tail)
      assert.equal(tail, 'мир\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('an empty file reads as empty', async () => {
    const home = makeHome()
    try {
      const file = join(home, 'history.jsonl')
      writeFileAt(file, '')
      assert.equal(await readChunk(file, 64, true), '')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('agentSessions - discovery', () => {
  test('merges every agent, newest first, with resume commands', async () => {
    const home = makeHome()
    try {
      writeFileAt(
        join(home, '.claude', 'projects', claudeProjectSlug(WORKSPACE), 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
        jsonl({ type: 'user', message: { role: 'user', content: 'claude work' } }),
        1_000
      )
      writeFileAt(
        join(home, '.codex', 'sessions', '2026', '09', '14', 'rollout-2026-09-14T15-00-32-01a09f25.jsonl'),
        jsonl(
          { type: 'session_meta', payload: { session_id: '01a09f25-88c0-7da1-8bf3-3fda3c91a298', cwd: WORKSPACE } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex work' }] } }
        ),
        2_000
      )
      writeFileAt(
        join(home, '.gemini', 'antigravity-cli', 'history.jsonl'),
        jsonl({ display: 'agy work', timestamp: 3_000_000, workspace: WORKSPACE, conversationId: 'cccccccc-1111-2222-3333-444444444444' })
      )

      const found = await listAgentConversations(WORKSPACE, { home })
      assert.deepEqual(
        found.map((c) => [c.agentId, c.title, c.command]),
        [
          ['antigravity', 'agy work', 'agy --conversation cccccccc-1111-2222-3333-444444444444'],
          ['codex', 'codex work', 'codex resume 01a09f25-88c0-7da1-8bf3-3fda3c91a298'],
          ['claude', 'claude work', 'claude --resume aaaaaaaa-1111-2222-3333-444444444444']
        ]
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('rejects a transcript whose folder only collides with this one', async () => {
    // "Project-x" and "Project_x" flatten to the same Claude project folder.
    const home = makeHome()
    const mine = `${WORKSPACE}-x`
    const theirs = `${WORKSPACE}_x`
    assert.equal(claudeProjectSlug(mine), claudeProjectSlug(theirs))
    try {
      const dir = join(home, '.claude', 'projects', claudeProjectSlug(mine))
      writeFileAt(
        join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
        jsonl({ type: 'user', cwd: theirs, message: { role: 'user', content: 'not mine' } }),
        2_000
      )
      writeFileAt(
        join(dir, 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'),
        jsonl({ type: 'user', cwd: mine, message: { role: 'user', content: 'mine' } }),
        1_000
      )
      const found = await listAgentConversations(mine, { home })
      assert.deepEqual(found.map((c) => c.title), ['mine'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('finds transcripts when the project folder keeps non-Latin letters', async () => {
    const home = makeHome()
    const dir = `${WORKSPACE}\\бот`
    try {
      assert.notEqual(claudeProjectSlug(dir), claudeProjectSlugUnicode(dir))
      writeFileAt(
        join(home, '.claude', 'projects', claudeProjectSlugUnicode(dir), 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
        jsonl({ type: 'user', cwd: dir, message: { role: 'user', content: 'cyrillic folder' } })
      )
      const found = await listAgentConversations(dir, { home })
      assert.deepEqual(found.map((c) => c.title), ['cyrillic folder'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('ignores conversations from another folder and empty transcripts', async () => {
    const home = makeHome()
    try {
      writeFileAt(join(home, '.claude', 'projects', claudeProjectSlug(`${WORKSPACE}-other`), 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'), jsonl({ type: 'user', message: { role: 'user', content: 'elsewhere' } }))
      writeFileAt(join(home, '.claude', 'projects', claudeProjectSlug(WORKSPACE), 'bbbbbbbb-1111-2222-3333-444444444444.jsonl'), '')
      writeFileAt(
        join(home, '.codex', 'sessions', '2026', '09', '14', 'rollout-x.jsonl'),
        jsonl({ type: 'session_meta', payload: { session_id: '01a09f25-88c0-7da1-8bf3-3fda3c91a298', cwd: `${WORKSPACE}-other` } })
      )
      assert.deepEqual(await listAgentConversations(WORKSPACE, { home }), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a missing home yields nothing instead of throwing', async () => {
    assert.deepEqual(await listAgentConversations(WORKSPACE, { home: join(tmpdir(), 'orcspace-not-here-9182') }), [])
  })

  test('an empty folder yields nothing', async () => {
    assert.deepEqual(await listAgentConversations('', { home: tmpdir() }), [])
  })

  test('finds a codex session buried under many from other folders', async () => {
    const home = makeHome()
    try {
      const day = join(home, '.codex', 'sessions', '2026', '09', '14')
      for (let i = 0; i < 40; i++) {
        writeFileAt(
          join(day, `rollout-other-${String(i).padStart(2, '0')}.jsonl`),
          jsonl({ type: 'session_meta', payload: { session_id: `01a09f25-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, cwd: `${WORKSPACE}-other` } }),
          5_000 + i
        )
      }
      writeFileAt(
        join(day, 'rollout-mine.jsonl'),
        jsonl(
          { type: 'session_meta', payload: { session_id: '01a09f25-1111-2222-3333-444444444444', cwd: WORKSPACE } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'buried work' }] } }
        ),
        1_000
      )
      const found = await listAgentConversations(WORKSPACE, { home })
      assert.deepEqual(found.map((c) => c.title), ['buried work'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('reads a codex title that sits past the instruction preamble', async () => {
    const home = makeHome()
    try {
      const filler = jsonl(
        ...Array.from({ length: 60 }, (_, i) => ({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${i} ${'x'.repeat(1200)}` }] }
        }))
      )
      writeFileAt(
        join(home, '.codex', 'sessions', '2026', '09', '14', 'rollout-deep.jsonl'),
        jsonl({ type: 'session_meta', payload: { session_id: '01a09f25-1111-2222-3333-555555555555', cwd: WORKSPACE } }) +
          filler +
          jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt after the preamble' }] } })
      )
      const found = await listAgentConversations(WORKSPACE, { home })
      assert.deepEqual(found.map((c) => c.title), ['prompt after the preamble'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a busy agent cannot crowd the others out of the list', async () => {
    const home = makeHome()
    try {
      const project = join(home, '.claude', 'projects', claudeProjectSlug(WORKSPACE))
      for (let i = 0; i < 12; i++) {
        writeFileAt(
          join(project, `aaaaaaaa-1111-2222-3333-00000000000${i.toString(36)}.jsonl`),
          jsonl({ type: 'user', cwd: WORKSPACE, message: { role: 'user', content: `claude ${i}` } }),
          9_000 + i
        )
      }
      writeFileAt(
        join(home, '.codex', 'sessions', '2026', '09', '14', 'rollout-old.jsonl'),
        jsonl(
          { type: 'session_meta', payload: { session_id: '01a09f25-9999-0000-0000-000000000001', cwd: WORKSPACE } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old codex work' }] } }
        ),
        1_000
      )
      writeFileAt(
        join(home, '.gemini', 'antigravity-cli', 'history.jsonl'),
        jsonl({ display: 'old agy work', timestamp: 500, workspace: WORKSPACE, conversationId: 'cccccccc-9999-0000-0000-000000000001' })
      )

      const found = await listAgentConversations(WORKSPACE, { home, limit: 4 })
      assert.equal(found.length, 4)
      assert.deepEqual(new Set(found.map((c) => c.agentId)), new Set(['claude', 'codex', 'antigravity']))
      // Still newest first, so the freshest claude conversation leads.
      assert.equal(found[0].agentId, 'claude')
      for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].updatedAt >= found[i].updatedAt)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('limit caps the list', async () => {
    const home = makeHome()
    try {
      const dir = join(home, '.claude', 'projects', claudeProjectSlug(WORKSPACE))
      for (let i = 0; i < 5; i++) {
        writeFileAt(join(dir, `aaaaaaaa-1111-2222-3333-00000000000${i}.jsonl`), jsonl({ type: 'user', message: { role: 'user', content: `task ${i}` } }), 1_000 + i)
      }
      const found = await listAgentConversations(WORKSPACE, { home, limit: 2 })
      assert.equal(found.length, 2)
      assert.equal(found[0].title, 'task 4')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('default limit caps the list at 20', async () => {
    const home = makeHome()
    try {
      const dir = join(home, '.claude', 'projects', claudeProjectSlug(WORKSPACE))
      for (let i = 0; i < 25; i++) {
        writeFileAt(
          join(dir, `aaaaaaaa-1111-2222-3333-${String(i).padStart(12, '0')}.jsonl`),
          jsonl({ type: 'user', message: { role: 'user', content: `task ${i}` } }),
          1_000 + i
        )
      }
      const found = await listAgentConversations(WORKSPACE, { home })
      assert.equal(found.length, 20)
      assert.equal(found[0].title, 'task 24')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
