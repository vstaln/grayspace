const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const v8 = require('node:v8')
const Module = require('node:module')

v8.setFlagsFromString('--no-lazy --no-flush-bytecode')
const params = ['exports', 'require', 'module', '__filename', '__dirname']
const reference = vm.compileFunction('', params, { produceCachedData: true }).cachedData
let sequence = 0
Module._extensions['.jsc'] = (module, filename) => {
  const file = fs.readFileSync(filename)
  if (file.length < 32) throw new Error('Truncated application bytecode')
  const length = file.readUInt32LE(0)
  const cachedData = file.subarray(4)
  // Version and snapshot must match; never patch incompatible snapshot checksums.
  for (const offset of [0, 4, 16]) {
    if (cachedData.readUInt32LE(offset) !== reference.readUInt32LE(offset)) {
      throw new Error('Bytecode does not match this Electron runtime. Rebuild the application.')
    }
  }
  reference.copy(cachedData, 12, 12, 16)
  const marker = `/*orcspace-${sequence++}*/`
  if (length < marker.length || length > 50_000_000) throw new Error('Invalid bytecode source length')
  const placeholder = marker.padEnd(length, ' ')
  const compiled = vm.compileFunction(placeholder, params, { cachedData, filename })
  if (compiled.cachedDataRejected) throw new Error('Electron rejected the application bytecode')
  const localRequire = Module.createRequire(filename)
  compiled(module.exports, localRequire, module, filename, path.dirname(filename))
}
