// server/utils.js
import * as Y from 'yjs'
import * as ws from 'ws'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync.js'
import * as awarenessProtocol from 'y-protocols/awareness.js'

const docs = new Map()
let persistence = null

export const setPersistence = (_persistence) => {
  persistence = _persistence
}

const messageSync = 0
const messageAwareness = 1

export const setupWSConnection = (conn, req, { docName = req.url.slice(1) }) => {
  const doc = getYDoc(docName)
  const awareness = new awarenessProtocol.Awareness(doc)

  awareness.setLocalState(null)

  const pingTimeout = setInterval(() => {
    if (conn.readyState !== ws.OPEN) {
      clearInterval(pingTimeout)
      awareness.destroy()
    } else {
      conn.ping()
    }
  }, 30000)

  doc.conns.set(conn, new Set())
  conn.binaryType = 'arraybuffer'

  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeSyncStep1(encoder, doc)
  conn.send(encoding.toUint8Array(encoder))

  conn.on('message', (message) => {
    const decoder = decoding.createDecoder(new Uint8Array(message))
    const encoder = encoding.createEncoder()
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case messageSync:
        encoding.writeVarUint(encoder, messageSync)
        syncProtocol.readSyncMessage(decoder, encoder, doc, null)
        if (encoding.length(encoder) > 1) conn.send(encoding.toUint8Array(encoder))
        break
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), conn)
        break
    }
  })

  conn.on('close', () => {
    const controlledIds = doc.conns.get(conn)
    if (controlledIds) {
      doc.conns.delete(conn)
      awarenessProtocol.removeAwarenessStates(awareness, Array.from(controlledIds), null)
    }
  })

  awareness.on('update', ({ added, updated, removed }, conn) => {
    const changedClients = added.concat(updated, removed)
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageAwareness)
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients))
    const buff = encoding.toUint8Array(encoder)

    doc.conns.forEach((_controlledIds, c) => {
      if (c !== conn) c.send(buff)
    })
  })
}

function getYDoc(docName) {
  const existing = docs.get(docName)
  if (existing) return existing

  const ydoc = new Y.Doc()
  ydoc.gc = true
  ydoc.conns = new Map()
  docs.set(docName, ydoc)

  if (persistence) {
    persistence.bindState(docName, ydoc)
  }

  return ydoc
}
