const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
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
    // Validate environment variables
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
      throw new Error('Missing Google credentials in environment variables');
    }

    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    
    await doc.loadInfo();
    const sheet = doc.sheetsByTitle['Bookings'];
    if (!sheet) {
      throw new Error('Bookings sheet not found');
    }
    const rows = await sheet.getRows();
    return rows;
  } catch (error) {
    console.error('Error fetching sheet:', error.message);
    throw error;
  }
}

// Parse dates from Google Sheets (DD/MM/YYYY format)
function parseGoogleSheetDate(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split('/');
  const date = new Date(`${year}-${month}-${day}`);
  date.setHours(0, 0, 0, 0);
  return date;
}

// Check if date is available
async function isDateAvailable(partyDateStr) {
  const partyDate = new Date(partyDateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  partyDate.setHours(0, 0, 0, 0);
  
  console.log(`Checking availability for party date: ${partyDate.toISOString()}`);
  
  // Block same-day bookings
  if (partyDate.getTime() === today.getTime()) {
    console.log('Date is today - unavailable');
    return false;
  }
  
  try {
    const rows = await getSheetData();
    console.log(`Retrieved ${rows.length} rows from sheet`);
    
    let kit1Booked = false;
    let kit2Booked = false;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawData = row._rawData;
      
      // Column indices from raw data:
      // 1: Kit 1 Booked
      // 2: Kit 2 Booked
      // 6: Collection Date
      // 8: Expected Return Date
      // 11: Status
      
      const status = rawData[11];
      console.log(`Row ${i}: Status="${status}"`);
      
      if (status !== 'Confirmed') {
        console.log(`  Skipping - status is not Confirmed`);
        continue;
      }
      
      const collectionDateStr = rawData[6];
      const returnDateStr = rawData[8];
      console.log(`  Collection Date: "${collectionDateStr}", Return Date: "${returnDateStr}"`);
      
      if (!collectionDateStr || !returnDateStr) {
        console.log(`  Skipping - missing date fields`);
        continue;
      }
      
      const collectionDate = parseGoogleSheetDate(collectionDateStr);
      const returnDate = parseGoogleSheetDate(returnDateStr);
      console.log(`  Parsed dates: collection=${collectionDate?.toISOString()}, return=${returnDate?.toISOString()}`);
      
      if (!collectionDate || !returnDate) {
        console.log(`  Skipping - failed to parse dates`);
        continue;
      }
      
      // Check if party date falls within blocked range
      const isInRange = partyDate >= collectionDate && partyDate <= returnDate;
      console.log(`  Party date in range? ${isInRange}`);
      
      if (isInRange) {
        const kit1 = rawData[1];
        const kit2 = rawData[2];
        console.log(`    Kit 1 Booked: "${kit1}", Kit 2 Booked: "${kit2}"`);
        
        if (kit1 && kit1.toLowerCase().includes('kit 1')) {
          kit1Booked = true;
          console.log(`    Kit 1 marked as booked`);
        }
        if (kit2 && kit2.toLowerCase().includes('kit 2')) {
          kit2Booked = true;
          console.log(`    Kit 2 marked as booked`);
        }
      }
    }
    
    const available = !(kit1Booked && kit2Booked);
    console.log(`Final result: Kit1Booked=${kit1Booked}, Kit2Booked=${kit2Booked}, Available=${available}`);
    return available;
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

// Log search for unavailable dates
app.post('/api/log-search', async (req, res) => {
  const { partyDate, available } = req.body;
  
  // Only log unavailable searches
  if (available) {
    return res.json({ success: true });
  }
  
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_CLIENT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ]
    });

    const doc = new GoogleSpreadsheet(process.env.SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    
    // Try to get or create the SearchLogs sheet
    let sheet = doc.sheetsByTitle['Search Logs'];
    
    if (!sheet) {
      // Create the sheet if it doesn't exist
      sheet = await doc.addSheet({
        title: 'Search Logs',
        headerValues: ['Date Searched', 'Party Date', 'Timestamp']
      });
    }
    
    // Add a row
    await sheet.addRows([
      {
        'Date Searched': new Date().toLocaleDateString('en-GB'),
        'Party Date': partyDate,
        'Timestamp': new Date().toISOString()
      }
    ]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error logging search:', error);
    res.json({ success: false, error: error.message });
  }
});

// Diagnostic endpoint
app.get('/api/debug', async (req, res) => {
  try {
    const rows = await getSheetData();
    
    if (rows.length === 0) {
      return res.json({ success: true, message: 'No rows in sheet' });
    }
    
    const data = rows.map((row, idx) => {
      return {
        rowIndex: idx,
        rawData: row._rawData
      };
    });
    
    res.json({ 
      success: true, 
      rows: data 
    });
  } catch (error) {
    res.json({ success: false, error: error.message, stack: error.stack });
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
