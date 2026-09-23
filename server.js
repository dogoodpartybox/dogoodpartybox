const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
require('dotenv').config();

const app = express();

// Enable CORS for your domain
app.use(cors({
  origin: ['https://dogoodpartybox.co.uk', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Business location
const BUSINESS_LAT = 51.89025987316835;
const BUSINESS_LNG = 0.9175324384470639;

// Initialize Google Sheets
async function getSheetData() {
  try {
    const doc = new GoogleSpreadsheet(process.env.SHEET_ID);
    
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
    
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Bookings'];
    const rows = await sheet.getRows();
    return rows;
  } catch (error) {
    console.error('Error fetching sheet:', error);
    throw error;
  }
}

// Check if date is available
async function isDateAvailable(partyDateStr) {
  const partyDate = new Date(partyDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  partyDate.setHours(0, 0, 0, 0);
  
  // Block same-day bookings
  if (partyDate.getTime() === today.getTime()) {
    return false;
  }
  
  try {
    const rows = await getSheetData();
    
    let kit1Booked = false;
    let kit2Booked = false;
    
    for (const row of rows) {
      const status = row.get('Status');
      
      if (status !== 'Confirmed') continue;
      
      const collectionDateStr = row.get('Collection Date');
      const returnDateStr = row.get('Expected Return Date');
      
      if (!collectionDateStr || !returnDateStr) continue;
      
      const collectionDate = new Date(collectionDateStr);
      const returnDate = new Date(returnDateStr);
      
      collectionDate.setHours(0, 0, 0, 0);
      returnDate.setHours(0, 0, 0, 0);
      
      // Check if party date falls within blocked range
      if (partyDate >= collectionDate && partyDate <= returnDate) {
        const kit1 = row.get('Kit 1 Booked');
        const kit2 = row.get('Kit 2 Booked');
        
        if (kit1 && kit1.toLowerCase().includes('kit 1')) {
          kit1Booked = true;
        }
        if (kit2 && kit2.toLowerCase().includes('kit 2')) {
          kit2Booked = true;
        }
      }
    }
    
    return !(kit1Booked && kit2Booked);
  } catch (error) {
    console.error('Error checking availability:', error);
    return true; // Default to available on error
  }
}

// API endpoint for availability check
app.get('/api/availability', async (req, res) => {
  const { partyDate } = req.query;
  
  if (!partyDate) {
    return res.status(400).json({ error: 'partyDate parameter required' });
  }
  
  try {
    const available = await isDateAvailable(partyDate);
    res.json({
      partyDate: partyDate,
      available: available,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Do Good Party Box server running on port ${PORT}`);
});
