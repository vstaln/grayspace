import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'
import * as net from 'net'
import { probeUrl, writeConfigAtomic, stripTomlSection } from './mcpAutoConfig.ts'

describe('mcpAutoConfig - probeUrl', () => {
  it('returns false for invalid URL', async () => {
    const result = await probeUrl('not-a-url')
    assert.strictEqual(result, false)
  })

  it('returns false for non-http protocol', async () => {
    const result = await probeUrl('ftp://127.0.0.1/')
    assert.strictEqual(result, false)
  })

  it('returns false for non-loopback URL', async () => {
    const result = await probeUrl('http://192.168.1.1:20220/mcp')
    assert.strictEqual(result, false)
  })

  it('returns true when port is listening on loopback', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as net.AddressInfo
    const result = await probeUrl(`http://127.0.0.1:${addr.port}/mcp`)
    assert.strictEqual(result, true)
    server.close()
  })

  it('returns false when port is not listening on loopback', async () => {
    const result = await probeUrl('http://127.0.0.1:58723/mcp')
    assert.strictEqual(result, false)
  })
})

describe('mcpAutoConfig - writeConfigAtomic', () => {
  beforeEach(() => {
    const testDir = join(os.tmpdir(), `orcspace-write-test-${process.pid}`)
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('creates file and preserves content', () => {
    const testFile = join(os.tmpdir(), `orcspace-write-test-${process.pid}`, 'test.json')
    writeConfigAtomic(testFile, '{"test": true}', os.tmpdir())
    assert.strictEqual(fs.readFileSync(testFile, 'utf8'), '{"test": true}')
  })

  it('creates backup .bak file when content changes', () => {
    const testDir = join(os.tmpdir(), `orcspace-write-test-${process.pid}`)
    const testFile = join(testDir, 'test.json')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(testFile, 'original', 'utf8')
    writeConfigAtomic(testFile, 'updated', testDir)
    const bakPath = `${testFile}.bak`
    assert.ok(fs.existsSync(bakPath))
    assert.strictEqual(fs.readFileSync(bakPath, 'utf8'), 'original')
  })

  it('does not create backup when content is same', () => {
    const testDir = join(os.tmpdir(), `orcspace-write-test-${process.pid}`)
    const testFile = join(testDir, 'test.json')
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(testFile, 'same content', 'utf8')
    writeConfigAtomic(testFile, 'same content', testDir)
    const bakPath = `${testFile}.bak`
    assert.ok(!fs.existsSync(bakPath))
  })
})

describe('mcpAutoConfig - stripTomlSection', () => {
  it('strips a TOML section from the beginning', () => {
    const text = '[section]\nkey = "value"\nother = 1\n[other]\nfoo = "bar"\n'
    assert.strictEqual(stripTomlSection(text, '[section]'), '[other]\nfoo = "bar"\n')
  })

  it('strips a TOML section in the middle', () => {
    const text = 'before = 1\n[section]\nkey = "value"\n[other]\nfoo = "bar"\n'
    assert.strictEqual(stripTomlSection(text, '[section]'), 'before = 1\n[other]\nfoo = "bar"\n')
  })

  it('strips a TOML section at the end', () => {
    const text = 'before = 1\n[section]\nkey = "value"\n'
    assert.strictEqual(stripTomlSection(text, '[section]'), 'before = 1')
  })
})
