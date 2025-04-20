// api/data.js
const tuyaModule = require('../api/modules/tuya');

module.exports = async (req, res) => {
  // Проверка API key
  const apiKey = req.query.api_key;
  const validApiKey = process.env.API_KEY;
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({ 
      success: false, 
      message: 'Unauthorized: Invalid or missing API key' 
    });
  }
  
  try {
    const deviceId = process.env.DEVICE_ID;
    if (!deviceId) {
      return res.status(500).json({ 
        success: false, 
        message: 'Server configuration error: Device ID not set' 
      });
    }
    
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
};