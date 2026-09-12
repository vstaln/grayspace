const { join } = require('node:path')
const { listPackage, extractFile } = require('@electron/asar')
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses')

function verifyArchive(archive, platform, arch) {
  const files = listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, ''))
  const forbidden = files.filter(file =>
    /(^|\/)(?:\.git|\.env(?:\.[^/]*)?)(?:\/|$)/i.test(file) ||
    (/^src\//i.test(file)) ||
    /\.(?:map|[cm]?ts|tsx|rs|pdb|pem|key|p12|pfx)$/i.test(file) ||
    (/^out\/main\/.+\.(?:js|cjs|mjs)$/.test(file) && !['out/main/index.js', 'out/main/bytecode-loader.cjs'].includes(file))
  )
  if (forbidden.length) throw new Error(`Release contains development/private files: ${forbidden.join(', ')}`)
  if (!files.includes('out/main/index.jsc')) throw new Error('Release main process is not compiled to bytecode')
  const loader = extractFile(archive, join('out', 'main', 'index.js')).toString()
  if (loader.length > 1024 || !loader.includes('bytecode-loader.cjs')) throw new Error('Plaintext main bundle found')
  const target = JSON.parse(extractFile(archive, join('out', 'main', 'bytecode-target.json')))
  if (target.platform !== platform || target.arch !== arch) throw new Error('Bytecode must be built on the release target OS and architecture')
}

async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager, arch } = context
  const product = packager.appInfo.productFilename
  const resources = electronPlatformName === 'darwin'
    ? join(appOutDir, `${product}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  const archName = require('builder-util').Arch[arch]
  verifyArchive(join(resources, 'app.asar'), electronPlatformName, archName)
  const binary = electronPlatformName === 'darwin'
    ? join(appOutDir, `${product}.app`)
    : join(appOutDir, electronPlatformName === 'win32' ? `${product}.exe` : packager.executableName)
  const settings = {
    version: FuseVersion.V1,
    // The shipped CLI uses Electron as its Node runtime.
    [FuseV1Options.RunAsNode]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
  }
  await flipFuses(binary, settings)
  const wire = await getCurrentFuseWire(binary)
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'version') continue
    if (wire[key] !== (value ? 49 : 48)) throw new Error(`Release fuse ${key} was not applied`)
  }
}

module.exports = afterPack
module.exports.verifyArchive = verifyArchive
