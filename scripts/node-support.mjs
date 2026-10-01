export const SUPPORTED_NODE_VERSION_TEXT = '22.18.x or 24.x'

export function isSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number)
  return major === 24 || (major === 22 && minor >= 18)
}
