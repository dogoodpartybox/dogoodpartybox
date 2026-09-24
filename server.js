const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
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

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Get today's enquiries from the sheet
async function getTodaysEnquiries() {
  try {
    const rows = await getSheetData();
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const todaysEnquiries = [];
    
    for (const row of rows) {
      const rawData = row._rawData;
      const timestamp = rawData[0]; // Timestamp column
      
      if (timestamp && timestamp.startsWith(today)) {
        todaysEnquiries.push({
          timestamp: rawData[0],
          partyDate: rawData[1],
          guests: rawData[2],
          postcode: rawData[3],
          email: rawData[4],
          notes: rawData[5]
        });
      }
    }
    
    return todaysEnquiries;
  } catch (error) {
    console.error('Error getting today\'s enquiries:', error);
    return [];
  }
}

// Send daily digest email
async function sendDailyDigest() {
  try {
    const enquiries = await getTodaysEnquiries();
    
    // Only send if there are enquiries
    if (enquiries.length === 0) {
      console.log('No enquiries today, skipping email');
      return;
    }
    
    const enquiryRows = enquiries.map((e, idx) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${idx + 1}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${e.partyDate}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${e.guests}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${e.postcode}</td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;"><a href="mailto:${e.email}">${e.email}</a></td>
        <td style="padding: 12px; border-bottom: 1px solid #eee;">${e.notes || '–'}</td>
      </tr>
    `).join('');
    
    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            h1 { color: #2F8B6E; border-bottom: 3px solid #2F8B6E; padding-bottom: 10px; }
            .summary { background: #f5f1e8; padding: 15px; border-radius: 8px; margin: 20px 0; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
            th { background: #2F8B6E; color: white; padding: 12px; text-align: left; font-weight: 600; }
            .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 0.9rem; color: #666; }
            .link-btn { display: inline-block; background: #2F8B6E; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; margin-top: 15px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📅 Do Good Party Box – Daily Enquiries</h1>
            
            <div class="summary">
              <strong>${enquiries.length} unavailable date enquir${enquiries.length === 1 ? 'y' : 'ies'}</strong> came in today.
            </div>
            
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Party Date</th>
                  <th>Guests</th>
                  <th>Postcode</th>
                  <th>Email</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                ${enquiryRows}
              </tbody>
            </table>
            
            <a href="https://docs.google.com/spreadsheets/d/${process.env.SHEET_ID}/edit#gid=0" class="link-btn">View Full Sheet</a>
            
            <div class="footer">
              <p>This is an automated daily digest from Do Good Party Box. No reply needed.</p>
            </div>
          </div>
        </body>
      </html>
    `;
    
    await transporter.sendMail({
      from: process.env.GMAIL_EMAIL,
      to: process.env.DIGEST_EMAIL,
      subject: `Do Good Party Box – ${enquiries.length} Enquir${enquiries.length === 1 ? 'y' : 'ies'} Today`,
      html: htmlContent
    });
    
    console.log(`Daily digest sent to ${process.env.DIGEST_EMAIL} with ${enquiries.length} enquiries`);
  } catch (error) {
    console.error('Error sending daily digest:', error);
  }
}

// Schedule daily digest for 8:30 AM every day
// Format: minute hour day month day-of-week
cron.schedule('30 8 * * *', () => {
  console.log('Running daily digest at 8:30 AM');
  sendDailyDigest();
});

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

// Handle unavailable date enquiry submissions
app.post('/api/unavailable-enquiry', async (req, res) => {
  const { partyDate, guests, postcode, email, notes } = req.body;
  
  if (!partyDate || !guests || !postcode || !email) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
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
    
    // Try to get or create the Unavailable Enquiries sheet
    let sheet = doc.sheetsByTitle['Unavailable Enquiries'];
    
    if (!sheet) {
      // Create the sheet if it doesn't exist
      sheet = await doc.addSheet({
        title: 'Unavailable Enquiries',
        headerValues: ['Timestamp', 'Party Date', 'Guests', 'Postcode', 'Email', 'Notes']
      });
    }
    
    // Add a row
    await sheet.addRows([
      {
        'Timestamp': new Date().toISOString(),
        'Party Date': partyDate,
        'Guests': guests,
        'Postcode': postcode,
        'Email': email,
        'Notes': notes || ''
      }
    ]);
    
    // Send Slack notification if webhook is configured
    if (process.env.SLACK_WEBHOOK_URL) {
      const slackMessage = {
        text: '📅 Unavailable Date Enquiry',
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '📅 Unavailable Date Enquiry'
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: `*Party Date:*\n${partyDate}`
              },
              {
                type: 'mrkdwn',
                text: `*Guests:*\n${guests}`
              },
              {
                type: 'mrkdwn',
                text: `*Postcode:*\n${postcode}`
              },
              {
                type: 'mrkdwn',
                text: `*Email:*\n${email}`
              }
            ]
          }
        ]
      };
      
      if (notes) {
        slackMessage.blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Notes:*\n${notes}`
          }
        });
      }
      
      try {
        await fetch(process.env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackMessage)
        });
      } catch (slackError) {
        console.error('Error sending Slack notification:', slackError);
        // Don't fail the enquiry submission if Slack fails
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error processing enquiry:', error);
    res.json({ success: false, error: error.message });
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
