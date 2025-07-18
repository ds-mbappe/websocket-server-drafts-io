// Test file - test-redis.js
import Redis from 'ioredis'
import dotenv from 'dotenv'
dotenv.config()

const redis = new Redis(process.env.REDIS_URL)
redis.ping().then(() => {
  console.log('Redis works!')
  process.exit(0)
}).catch(err => {
  console.error('Redis failed:', err)
  process.exit(1)
})