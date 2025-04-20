// lib/redis.js
const { createClient } = require('redis');

// Initialize Redis client with timeout and retry logic
async function getRedisClient() {
  const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;
  
  if (!REDIS_HOST || !REDIS_PORT || !REDIS_PASSWORD) {
    throw new Error('Redis environment variables are not defined');
  }
  
  const redisPassword = encodeURIComponent(REDIS_PASSWORD);
  const redisUrl = `redis://default:${redisPassword}@${REDIS_HOST}:${REDIS_PORT}`;
  
  console.log("Connecting to Redis:", REDIS_HOST + ":" + REDIS_PORT);
  
  const client = createClient({ 
    url: redisUrl,
    socket: {
      connectTimeout: 5000,  // 5 second connection timeout
      reconnectStrategy: (retries) => {
        if (retries > 3) {
          console.error(`Redis reconnect failed after ${retries} attempts`);
          return new Error('Redis reconnect failed');
        }
        return Math.min(retries * 50, 500);
      }
    }
  });
  
  // Improved error handling
  client.on('error', (err) => {
    console.error('Redis error:', err.message);
  });
  
  try {
    await client.connect();
    console.log("Successfully connected to Redis");
    return client;
  } catch (error) {
    console.error("Redis connection error:", error.message);
    throw error;
  }
}

module.exports = {
  getRedisClient
};
