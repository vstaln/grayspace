const http = require('node:http')

module.exports = function requestIpc(socketPath, path, { method = 'GET', headers = {}, body } = {}) {
  if (!socketPath) return Promise.reject(new Error('Runtime IPC socket is missing'))
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ socketPath, path, method, headers: {
      ...headers,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }) }
        catch (error) { reject(error) }
      })
    })
    const timer = setTimeout(() => req.destroy(new Error('IPC request timed out')), 5000)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(payload)
  })
}
