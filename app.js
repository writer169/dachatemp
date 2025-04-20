// app.js - Main application file
const express = require('express');
const tuyaModule = require('./api/modules/tuya');
const app = express();
const port = process.env.PORT || 3000;

// Simple API key validation middleware
const validateApiKey = (req, res, next) => {
  const apiKey = req.query.api_key;
  const validApiKey = process.env.API_KEY;
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized: Invalid or missing API key' 
    });
  }
  
  next();
};

// Main data endpoint with API key validation
app.get('/data', validateApiKey, async (req, res) => {
  try {
    const deviceId = process.env.DEVICE_ID;
    
    if (!deviceId) {
      return res.status(500).json({ 
        success: false, 
        message: 'Server configuration error: Device ID not set' 
      });
    }
    
    // Fetch device status using your existing Tuya module
    const result = await tuyaModule({ 
      action: 'status', 
      id: deviceId 
    });
    
    return res.json(result);
  } catch (error) {
    console.error('Error fetching device data:', error.message);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error', 
      error: error.message 
    });
  }
});

// Health check endpoint (no API key required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
