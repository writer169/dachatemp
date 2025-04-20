// api/modules/tuya.js
const axios = require('axios');
const crypto = require('crypto');
const { getRedisClient } = require('../../lib/redis');
// Create signature for requests
function generateSign(method, path, body = "", token = "") {
  const { TUYA_CLIENT_ID, TUYA_CLIENT_SECRET } = process.env;
  if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
      console.error("Missing TUYA_CLIENT_ID or TUYA_CLIENT_SECRET in environment variables.");
      throw new Error("Missing Tuya API credentials");
  }
  const timestamp = Date.now().toString();
  const contentHash = crypto.createHash("sha256").update(body).digest("hex");
  const stringToSign = `${method}\n${contentHash}\n\n${path}`;
  const signStr = TUYA_CLIENT_ID + token + timestamp + stringToSign;

  return {
    sign: crypto
      .createHmac("sha256", TUYA_CLIENT_SECRET)
      .update(signStr, "utf8")
      .digest("hex")
      .toUpperCase(),
    timestamp,
    clientId: TUYA_CLIENT_ID
  };
}

// Get access_token with Redis caching
async function getAccessToken() {
  let redisClient = null;
  const redisKey = "tuya_token";

  try {
    // Try to get token from Redis
    try {
      redisClient = await getRedisClient();
      if (!redisClient) {
          throw new Error("Failed to get Redis client instance.");
      }
      let token = await redisClient.get(redisKey);

      if (token) {
        await redisClient.quit();
        return token;
      }
      console.log("Token not found in Redis, requesting from API");
    } catch (redisError) {
      console.error("Redis error (reading):", redisError.message);
      if (redisClient) {
          try { await redisClient.quit(); } catch (e) { /* ignore */ }
          redisClient = null;
      }
    }

    // Request new token
    const path = "/v1.0/token?grant_type=1";
    const { sign, timestamp, clientId } = generateSign("GET", path);

    console.log("Making request to Tuya API for token");
    const response = await axios.get(`https://openapi.tuyaeu.com${path}`, {
      headers: { "client_id": clientId, "sign": sign, "t": timestamp, "sign_method": "HMAC-SHA256" },
      timeout: 10000
    });

    if (!response.data?.success || !response.data.result?.access_token) {
      throw new Error(`Error getting token: ${response.data?.msg || "Invalid response from Tuya API"}`);
    }

    const token = response.data.result.access_token;
    const expireTime = response.data.result.expire_time;
    const ttl = expireTime > 60 ? expireTime - 60 : expireTime;

    console.log(`Token successfully obtained. Redis TTL: ${ttl} seconds.`);

    // Try to save to Redis
    if (!redisClient) {
        try {
            redisClient = await getRedisClient();
        } catch(redisReconnectError) {
             console.error("Failed to reconnect to Redis for token save:", redisReconnectError.message);
        }
    }

    if (redisClient) {
      try {
        if (ttl > 0) {
            await redisClient.set(redisKey, token, { EX: ttl });
            console.log("Token successfully saved to Redis");
        } else {
            console.warn("Token TTL <= 0, token not cached.");
        }
      } catch (redisSaveError) {
        console.error("Error saving token to Redis:", redisSaveError.message);
      } finally {
        try {
          await redisClient.quit();
          redisClient = null;
        } catch (redisQuitError) {
          console.error("Error closing Redis connection after save:", redisQuitError.message);
        }
      }
    } else {
        console.log("Redis client unavailable, token won't be cached.");
    }

    return token;

  } catch (error) {
    console.error("Critical error in getAccessToken:", error.message);
    if (redisClient) {
      try { await redisClient.quit(); } catch (e) { /* ignore */ }
    }
    throw error;
  }
}

// Function to make custom requests to Tuya API with retry logic
async function makeCustomRequest(method, path, data = null, retry = true) {
  let response;

  try {
    const access_token = await getAccessToken();
    const body = data ? JSON.stringify(data) : "";
    const { sign, timestamp, clientId } = generateSign(method.toUpperCase(), path, body, access_token);

    const requestConfig = {
      method: method.toUpperCase(),
      url: `https://openapi.tuyaeu.com${path}`,
      headers: {
        'client_id': clientId,
        'access_token': access_token,
        'sign': sign,
        't': timestamp,
        'sign_method': 'HMAC-SHA256',
        'Content-Type': 'application/json'
      },
      timeout: 10000,
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(requestConfig.method)) {
      requestConfig.data = data;
    }

    response = await axios(requestConfig);

    // Check response for token validity
    if (response.data?.code === 1010 && retry) {
      console.warn(`Invalid token detected (code 1010). Attempting to delete from Redis and retry once. Retry = ${retry}`);
      let redisClientDel = null;
      try {
        redisClientDel = await getRedisClient();
        if (redisClientDel) {
          await redisClientDel.del("tuya_token");
          console.log("Old token deleted from Redis.");
        } else {
          console.warn("Could not connect to Redis to delete token.");
        }
      } catch (redisError) {
        console.error("Error deleting token from Redis (non-critical for retry):", redisError.message);
      } finally {
        if (redisClientDel) {
          try { await redisClientDel.quit(); } catch (e) { /* ignore */ }
        }
      }

      // Retry request once with retry=false
      console.log("Making retry request to Tuya API...");
      return makeCustomRequest(method, path, data, false);
    }

    // Check overall success and HTTP status
    if (response.status >= 400) {
        console.warn(`Request to Tuya API ${method} ${path} completed with HTTP status ${response.status}. Code: ${response.data?.code}, Msg: ${response.data?.msg}`);
    } else if (!response.data.success) {
      console.warn(`Request to Tuya API ${method} ${path} completed (HTTP ${response.status}), but success=false. Code: ${response.data.code}, Msg: ${response.data.msg}`);
    }

    return response.data;

  } catch (error) {
    console.error(`Critical NETWORK error or server error for Tuya API request (${method} ${path}):`, error.message);

    if (error.response) {
      console.error('Response from Tuya server (error):', error.response.status, error.response.data);
    } else if (error.request) {
      console.error('Request to Tuya API was sent, but no response received:', error.request);
    } else {
      console.error('Error setting up Tuya API request:', error.message);
    }
    throw error;
  }
}

// Main module export function
module.exports = async (queryParams = {}) => {
  const { TUYA_CLIENT_ID, TUYA_CLIENT_SECRET } = process.env;
  if (!TUYA_CLIENT_ID || !TUYA_CLIENT_SECRET) {
    console.error('Missing Tuya credentials (TUYA_CLIENT_ID, TUYA_CLIENT_SECRET)');
    return { success: false, message: 'Server error: Missing Tuya credentials.' };
  }

  try {
    const action = queryParams.action || 'test';

    if (action === 'test') {
      return { success: true, message: 'Tuya module working', timestamp: new Date().toISOString() };
    }

    // Custom request through general function
    if (action === 'request' && queryParams.path) {
      const method = (queryParams.method || 'GET').toUpperCase();
      const path = queryParams.path.startsWith('/') ? queryParams.path : `/${queryParams.path}`;
      let data = null;

      if (queryParams.data) {
        try {
          data = JSON.parse(queryParams.data);
        } catch (e) {
          console.error("Error parsing JSON from queryParams.data:", e.message);
          return { success: false, message: 'Invalid JSON format in data parameter', error: e.message };
        }
      }

      const result = await makeCustomRequest(method, path, data);
      return { success: result.success, path: path, method: method, result: result, message: `Request ${method} ${path} processed.` };
    }

    // Get device status - modified to return only result[0].value / 10
    else if (action === 'status' && queryParams.id) {
      const deviceId = queryParams.id;
      const path = `/v1.0/iot-03/devices/${deviceId}/status`;
      console.log(`Requesting status for device ${deviceId}...`);
      const result = await makeCustomRequest('GET', path);
      
      // Check if the result was successful and contains the expected data
      if (result.success && Array.isArray(result.result) && result.result.length > 0 && result.result[0]?.value !== undefined) {
        // Parse the value and divide by 10
        const parsedValue = parseFloat(result.result[0].value) / 10;
        return parsedValue;
      } else {
        console.warn("Tuya API returned unexpected data format for status:", result);
        return {
          success: false,
          message: "Failed to parse device status data",
          tuya_response: result
        };
      }
    }

    // List devices
    else if (action === 'devices') {
      const path = "/v1.0/users/me/devices";
      console.log("Requesting device list...");
      const result = await makeCustomRequest('GET', path);
      return {
        success: result.success,
        devices: result.result || [],
        message: result.success ? 'Tuya device list retrieved' : `Error getting device list: ${result.msg || 'Unknown error'}`,
        tuya_code: result.code,
        tuya_msg: result.msg
      };
    }

    // Device state by ID
    else if (action === 'state' && queryParams.id) {
      const deviceId = queryParams.id;
      const path = `/v1.0/devices/${deviceId}`;
      console.log(`Requesting state for device ${deviceId}...`);
      const result = await makeCustomRequest('GET', path);
      return {
        success: result.success,
        state: result.result || null,
        message: result.success ? `State for device ${deviceId}` : `Error getting state: ${result.msg || 'Unknown error'}`,
        tuya_code: result.code,
        tuya_msg: result.msg
      };
    }

    // Device control (on/off)
    else if (action === 'control' && queryParams.id && queryParams.command) {
      const deviceId = queryParams.id;
      const command = queryParams.command.toLowerCase();

      if (command !== 'on' && command !== 'off') {
        return { success: false, message: 'Invalid command. Only "on" or "off" are supported.' };
      }

      const path = `/v1.0/devices/${deviceId}/commands`;
      const payload = {
        commands: [ { code: queryParams.code || 'switch_1', value: command === 'on' } ]
      };
      const commandCode = payload.commands[0].code;

      console.log(`Sending command ${command} (code: ${commandCode}) to device ${deviceId}...`);
      const result = await makeCustomRequest('POST', path, payload);

      return {
        success: result.success,
        result: result.result,
        message: result.success
          ? `Command ${command} (code: ${commandCode}) successfully sent to device ${deviceId}`
          : `Error sending command to device ${deviceId}: ${result.msg || 'Unknown error'}`,
        tuya_code: result.code,
        tuya_msg: result.msg
      };
    }

    // Unknown action
    else {
      console.warn("Unknown action or missing required parameters:", action, queryParams);
      return { success: false, message: 'Unknown action or missing required parameters.', action: action };
    }

  } catch (error) {
    console.error('Critical error in main Tuya module handler:', error.message);
    return {
        success: false,
        error: error.message,
        tuya_response: error.response?.data,
        message: 'Internal error processing Tuya request.'
    };
  }
};