// server/server.js
import Redis from 'ioredis'
import * as http from 'http'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import { LeveldbPersistence } from 'y-leveldb'
// Alternative: import { MongodbPersistence } from 'y-mongodb'
import { setupWSConnection, setPersistence } from './utils.js'

dotenv.config()

console.log('[BOOT] REDIS_URL:', process.env.REDIS_URL)
console.log('[BOOT] AUTH_SECRET:', process.env.AUTH_SECRET)
console.log('[BOOT] NODE_ENV:', process.env.NODE_ENV)
console.log('[BOOT] PORT:', process.env.PORT)

const port = process.env.PORT || 1234
const server = http.createServer()
const wss = new WebSocketServer({ noServer: true })

// Redis client for custom persistence
const redis = new Redis(process.env.REDIS_URL, {
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  // Handle SSL for rediss:// URLs
  tls: process.env.REDIS_URL?.startsWith('rediss://') ? {} : undefined,
})

// Add Redis connection event handlers
redis.on('connect', () => {
  console.log('✅ Connected to Redis')
})

redis.on('error', (error) => {
  console.error('❌ Redis connection error:', error)
})

redis.on('ready', () => {
  console.log('✅ Redis is ready')
})

// Custom Redis persistence implementation
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

// Alternative: Use LevelDB persistence (recommended)
// const persistence = new LeveldbPersistence('./yjs-leveldb')

// Use custom Redis persistence
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