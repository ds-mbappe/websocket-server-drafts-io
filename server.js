// server/server.js
import Redis from 'ioredis'
import * as http from 'http'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
// Remove this import if you don't have the utils.js file
// import { setupWSConnection, setPersistence } from './utils.js'

dotenv.config()

// Add process error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
  process.exit(1)
})

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error)
  process.exit(1)
})

console.log('[BOOT] Starting server...')
console.log('[BOOT] REDIS_URL:', process.env.REDIS_URL)
console.log('[BOOT] AUTH_SECRET:', process.env.AUTH_SECRET ? 'Set' : 'Not set')
console.log('[BOOT] NODE_ENV:', process.env.NODE_ENV)
console.log('[BOOT] PORT:', process.env.PORT)

const port = process.env.PORT || 1234
const server = http.createServer((req, res) => {
  // Handle HTTP requests for health checks
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Yjs WebSocket Server is running')
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }
})
const wss = new WebSocketServer({ noServer: true })

// Parse Redis URL manually for better control
const redisUrl = new URL(process.env.REDIS_URL)
console.log('[REDIS] Parsed URL:', {
  host: redisUrl.hostname,
  port: redisUrl.port,
  protocol: redisUrl.protocol,
  username: redisUrl.username
})

// Redis client for custom persistence
const redis = new Redis({
  host: redisUrl.hostname,
  port: parseInt(redisUrl.port) || 6379,
  password: redisUrl.password,
  username: redisUrl.username || 'default',
  tls: redisUrl.protocol === 'rediss:' ? {} : undefined,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: 3,
  connectTimeout: 10000,
  lazyConnect: false, // Connect immediately
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

redis.on('close', () => {
  console.log('⚠️ Redis connection closed')
})

// Test Redis connection on startup
async function testRedisConnection() {
  try {
    console.log('[REDIS] Testing connection...')
    await redis.ping()
    console.log('✅ Redis ping successful')
  } catch (error) {
    console.error('❌ Redis ping failed:', error)
  }
}

// Call test function
testRedisConnection()

// Custom Redis persistence implementation
class CustomRedisPersistence {
  constructor(redis) {
    this.redis = redis
    this.docs = new Map() // In-memory cache
  }

  async bindState(docName, ydoc) {
    try {
      console.log(`[PERSISTENCE] Loading document: ${docName}`)
      const data = await this.redis.get(`yjs:${docName}`)
      if (data) {
        const uint8Array = new Uint8Array(JSON.parse(data))
        Y.applyUpdate(ydoc, uint8Array)
        console.log(`[PERSISTENCE] Document ${docName} loaded from Redis`)
      } else {
        console.log(`[PERSISTENCE] Document ${docName} not found in Redis`)
      }
      
      // Store in memory cache
      this.docs.set(docName, ydoc)
      
      // Listen for updates
      ydoc.on('update', (update) => {
        this.writeState(docName, ydoc)
      })
      
    } catch (error) {
      console.error(`[PERSISTENCE] Error loading document ${docName}:`, error)
    }
  }

  async writeState(docName, ydoc) {
    try {
      const update = Y.encodeStateAsUpdate(ydoc)
      await this.redis.set(`yjs:${docName}`, JSON.stringify(Array.from(update)))
      console.log(`[PERSISTENCE] Document ${docName} saved to Redis`)
      return true
    } catch (error) {
      console.error(`[PERSISTENCE] Error saving document ${docName}:`, error)
      return false
    }
  }
}

// Use custom Redis persistence
const persistence = new CustomRedisPersistence(redis)

// Simple WebSocket connection handler (replacing setupWSConnection)
function setupWSConnection(ws, req, { docName }) {
  console.log(`[WS] New connection for document: ${docName}`)
  
  // Create or get document
  const ydoc = new Y.Doc()
  
  // Bind persistence
  persistence.bindState(docName, ydoc)
  
  // Handle WebSocket messages
  ws.on('message', (data) => {
    try {
      const update = new Uint8Array(data)
      Y.applyUpdate(ydoc, update)
      
      // Broadcast to other clients (simplified)
      ws.send(data)
    } catch (error) {
      console.error('[WS] Error handling message:', error)
    }
  })
  
  ws.on('close', () => {
    console.log(`[WS] Connection closed for document: ${docName}`)
  })
  
  ws.on('error', (error) => {
    console.error('[WS] WebSocket error:', error)
  })
}

function authenticate(token) {
  try {
    if (!token) {
      console.log('[AUTH] No token provided')
      return null
    }
    const decoded = jwt.verify(token, process.env.AUTH_SECRET)
    console.log('[AUTH] Token verified for:', decoded.email)
    return decoded
  } catch (error) {
    console.log('[AUTH] Token verification failed:', error.message)
    return null
  }
}

server.on('upgrade', (request, socket, head) => {
  try {
    console.log('[UPGRADE] WebSocket upgrade request received')
    console.log('[UPGRADE] Request URL:', request.url)
    console.log('[UPGRADE] Request headers:', request.headers)
    
    const url = new URL(request.url, `http://${request.headers.host}`)
    const token = url.searchParams.get('token')
    
    // Extract document name from pathname - remove leading slash
    let docName = url.pathname.slice(1)
    
    // Handle case where WebsocketProvider appends document name
    // If URL is /docName/docName, take the first part
    const pathParts = docName.split('/')
    if (pathParts.length > 1 && pathParts[0] === pathParts[1]) {
      docName = pathParts[0]
    }
    
    console.log('[UPGRADE] Full URL:', url.toString())
    console.log('[UPGRADE] Parsed document name:', docName)
    console.log('[UPGRADE] Token provided:', !!token)
    console.log('[UPGRADE] Token preview:', token ? token.substring(0, 50) + '...' : 'None')
    
    if (!token) {
      console.log('[UPGRADE] No token provided, destroying socket')
      socket.destroy()
      return
    }
    
    const user = authenticate(token)
    
    if (!user) {
      console.log('[UPGRADE] Authentication failed, destroying socket')
      socket.destroy()
      return
    }
    
    console.log('[UPGRADE] Authentication successful, handling upgrade')
    wss.handleUpgrade(request, socket, head, ws => {
      setupWSConnection(ws, request, { docName })
    })
  } catch (error) {
    console.error('[UPGRADE] Error during upgrade:', error)
    socket.destroy()
  }
})

server.listen(port, '0.0.0.0', async () => {
  console.log(`✅ Yjs WebSocket Server listening on port ${port}`)
  
  // Test Redis connection after server starts
  try {
    await redis.ping()
    console.log('✅ Redis connection verified')
  } catch (error) {
    console.error('❌ Redis connection failed:', error)
  }
})