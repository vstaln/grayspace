const fs = require('node:fs')
const path = require('node:path')

const platformArch = `${process.platform}-${process.arch}`
const nativeFile = fs.readdirSync(__dirname).find((name) =>
  name.endsWith('.node') && name.includes(platformArch)
)

if (!nativeFile) {
  throw new Error(`native brain-core binary not found for ${platformArch}`)
}

module.exports = require(path.join(__dirname, nativeFile))
