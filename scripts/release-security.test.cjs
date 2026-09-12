const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createPackage } = require('@electron/asar')
const { verifyArchive } = require('./release-security.cjs')

test('release gate rejects leaked code and mismatched bytecode targets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orc-release-check-'))
  try {
    const source = path.join(dir, 'app')
    const main = path.join(source, 'out', 'main')
    await fs.mkdir(main, { recursive: true })
    await fs.writeFile(path.join(main, 'index.jsc'), 'fixture')
    await fs.writeFile(path.join(main, 'index.js'), 'require("./bytecode-loader.cjs");require("./index.jsc");')
    await fs.writeFile(path.join(main, 'bytecode-target.json'), JSON.stringify({ platform: process.platform, arch: process.arch }))
    let counter = 0
    const pack = async () => {
      const archive = path.join(dir, `${counter++}.asar`)
      await createPackage(source, archive)
      return archive
    }
    let archive = await pack()
    assert.doesNotThrow(() => verifyArchive(archive, process.platform, process.arch))
    assert.throws(() => verifyArchive(archive, 'wrong-platform', process.arch), /target OS/)
    for (const name of ['index.js.map', '_index.js', '.env', 'private.pem', 'index.ts']) {
      const file = path.join(main, name)
      await fs.writeFile(file, 'must not ship')
      archive = await pack()
      assert.throws(() => verifyArchive(archive, process.platform, process.arch), /development\/private files/)
      await fs.unlink(file)
    }
    await fs.unlink(path.join(main, 'index.jsc'))
    archive = await pack()
    assert.throws(() => verifyArchive(archive, process.platform, process.arch), /not compiled/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
