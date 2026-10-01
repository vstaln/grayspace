const { app } = require('electron')
const fs = require('node:fs')
const vm = require('node:vm')
const v8 = require('node:v8')

v8.setFlagsFromString('--no-lazy --no-flush-bytecode')
app.disableHardwareAcceleration()
app.whenReady().then(() => {
  try {
    const filename = process.argv[process.argv.length - 1]
    if (!filename || !filename.endsWith('.js')) throw new Error('Missing JavaScript bundle path')
    const code = fs.readFileSync(filename, 'utf8')
    const compiled = vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { produceCachedData: true })
    if (!compiled.cachedDataProduced) throw new Error('V8 did not produce bytecode')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(code.length)
    fs.writeFileSync(`${filename}c`, Buffer.concat([header, compiled.cachedData]))
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
