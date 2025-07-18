// server/server.js
import Redis from 'ioredis'
import * as http from 'http'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { WebSocketServer } from 'ws'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import { encoding, decoding } from 'lib0'

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
  lazyConnect: false,
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

testRedisConnection()

// Store active documents and their connections
const docs = new Map()
const docAwareness = new Map()

// Custom Redis persistence implementation
class CustomRedisPersistence {
  constructor(redis) {
    this.redis = redis
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
        console.log(`[PERSISTENCE] Document ${docName} not found in Redis, creating new`)
      }
      
      // Listen for updates and save to Redis
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

const persistence = new CustomRedisPersistence(redis)

// Message types for Y.js protocol
const messageSync = 0
const messageAwareness = 1

// Get or create document
function getYDoc(docName) {
  let doc = docs.get(docName)
  if (!doc) {
    doc = new Y.Doc()
    docs.set(docName, doc)
    
    // Set up persistence
    persistence.bindState(docName, doc)
    
    // Clean up empty documents after 30 seconds
    setTimeout(() => {
      if (doc.getMap().size === 0) {
        docs.delete(docName)
        console.log(`[CLEANUP] Removed empty document: ${docName}`)
      }
    }, 30000)
  }
  return doc
}

// Get or create awareness
function getAwareness(docName) {
  let awareness = docAwareness.get(docName)
  if (!awareness) {
    awareness = new awarenessProtocol.Awareness(getYDoc(docName))
    docAwareness.set(docName, awareness)
  }
  return awareness
}

// Proper Y.js WebSocket connection handler
function setupWSConnection(ws, req, { docName }) {
  console.log(`[WS] New connection for document: ${docName}`)
  
  const doc = getYDoc(docName)
  const awareness = getAwareness(docName)
  
  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = new Uint8Array(data)
      const encoder = encoding.createEncoder()
      const decoder = decoding.createDecoder(message)
      const messageType = decoding.readVarUint(decoder)
      
      switch (messageType) {
        case messageSync:
          console.log(`[WS] Sync message received for ${docName}`)
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, doc, ws)
          
          // Send sync response
          if (encoding.length(encoder) > 1) {
            ws.send(encoding.toUint8Array(encoder))
          }
          break
          
        case messageAwareness:
          console.log(`[WS] Awareness message received for ${docName}`)
          awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), ws)
          break
          
        default:
          console.warn(`[WS] Unknown message type: ${messageType}`)
      }
    } catch (error) {
      console.error('[WS] Error handling message:', error)
    }
  })
  
  // Send initial sync message
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  ws.send(encoding.toUint8Array(encoder))
  
  // Send awareness states
  const awarenessEncoder = encoding.createEncoder()
  encoding.writeVarUint(awarenessEncoder, messageAwareness)
  encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awareness.getStates().keys())))
  ws.send(encoding.toUint8Array(awarenessEncoder))
  
  // Handle awareness updates
  const awarenessChangeHandler = ({ added, updated, removed }) => {
    const changedClients = added.concat(updated, removed)
    if (changedClients.length > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients))
      const message = encoding.toUint8Array(encoder)
      
      // Broadcast to all clients
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(message)
        }
      })
    }
  }
  
  awareness.on('update', awarenessChangeHandler)
  
  // Handle document updates
  const updateHandler = (update, origin) => {
    if (origin !== ws) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageSync)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      
      // Broadcast to all clients except sender
      wss.clients.forEach(client => {
        if (client !== ws && client.readyState === 1) {
          client.send(message)
        }
      })
    }
  }
  
  doc.on('update', updateHandler)
  
  // Handle connection close
  ws.on('close', () => {
    console.log(`[WS] Connection closed for document: ${docName}`)
    doc.off('update', updateHandler)
    awareness.off('update', awarenessChangeHandler)
  })
  
  ws.on('error', (error) => {
    console.error('[WS] WebSocket error:', error)
  })
  
  // Set up ping/pong for connection health
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping()
    } else {
      clearInterval(pingInterval)
    }
  }, 30000)
  
  ws.on('pong', () => {
    console.log(`[WS] Pong received from ${docName}`)
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
    
    const url = new URL(request.url, `http://${request.headers.host}`)
    const token = url.searchParams.get('token')
    
    // Extract document name from pathname - remove leading slash
    let docName = url.pathname.slice(1)
    
    // Handle case where WebsocketProvider might append document name
    const pathParts = docName.split('/')
    if (pathParts.length > 1) {
      docName = pathParts[0]
    }
    
    console.log('[UPGRADE] Parsed document name:', docName)
    console.log('[UPGRADE] Token provided:', !!token)
    
    if (!docName) {
      console.log('[UPGRADE] No document name provided, destroying socket')
      socket.destroy()
      return
    }
    
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