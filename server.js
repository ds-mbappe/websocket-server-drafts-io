// server/server.js
import * as Y from 'yjs'
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

class CustomRedisPersistence {
  constructor(redis) {
    this.redis = redis
  }

  async bindState(docName, ydoc) {
    try {
      const data = await this.redis.get(`yjs:${docName}`)
      if (data) {
        const uint8Array = new Uint8Array(JSON.parse(data))
        Y.applyUpdate(ydoc, uint8Array)
      }
    } catch (error) {
      console.error('Error loading document:', error)
    }
  }

  async writeState(docName, ydoc) {
    try {
      const update = Y.encodeStateAsUpdate(ydoc)
      await this.redis.set(`yjs:${docName}`, JSON.stringify(Array.from(update)))
      return true
    } catch (error) {
      console.error('Error saving document:', error)
      return false
    }
  }
}

const persistence = new CustomRedisPersistence(redis)

setPersistence({
  bindState: async (docName, ydoc) => {
    return persistence.bindState(docName, ydoc)
  },
  writeState: async (docName, ydoc) => {
    return persistence.writeState(docName, ydoc)
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
