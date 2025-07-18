// server/server.js
import Redis from 'ioredis'
import * as http from 'http'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { RedisPersistence } from 'y-redis'
import { setupWSConnection, setPersistence } from './utils.js'

dotenv.config()

console.log('[BOOT] REDIS_URL:', process.env.REDIS_URL)
console.log('[BOOT] AUTH_SECRET:', process.env.AUTH_SECRET)
console.log('[BOOT] NODE_ENV:', process.env.NODE_ENV)

const port = process.env.PORT || 1234
const server = http.createServer()
const wss = new WebSocketServer({ noServer: true })

// Redis persistence setup
const redis = new Redis(process.env.REDIS_URL)
const persistence = new RedisPersistence(redis)

setPersistence({
  bindState: async (docName, ydoc) => {
    return persistence.bindState(docName, ydoc)
  },
  writeState: async (docName, ydoc) => {
    return true
  },
})

function authenticate(token) {
  try {
    return jwt.verify(token, process.env.AUTH_SECRET)
  } catch {
    return null
  }
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const token = url.searchParams.get('token')
  const docName = url.pathname.slice(1)

  const user = authenticate(token)
  if (!user) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(request, socket, head, ws => {
    setupWSConnection(ws, request, { docName })
  })
})

server.listen(port, () => {
  console.log(`✅ Yjs WebSocket Server listening on port ${port}`)
})
