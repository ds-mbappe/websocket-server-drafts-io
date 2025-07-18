// server/server.js
import * as http from 'http'
import WebSocket from 'ws'
import dotenv from 'dotenv'
import jwt from 'jsonwebtoken'
import { RedisPersistence } from 'y-redis'
import { setupWSConnection, setPersistence } from './utils.js'

dotenv.config()

const port = process.env.PORT || 1234
const server = http.createServer()
const wss = new WebSocket.Server({ noServer: true })

// Redis persistence setup
const persistence = new RedisPersistence(process.env.REDIS_URL)

setPersistence({
  bindState: async (docName, ydoc) => {
    const persisted = await persistence.getYDoc(docName)
    const update = Y.encodeStateAsUpdate(persisted)
    Y.applyUpdate(ydoc, update)

    ydoc.on('update', async update => {
      await persistence.storeUpdate(docName, update)
    })
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
