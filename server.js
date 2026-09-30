const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const app = express();

// Enable CORS for your domain
app.use(cors({
  origin: ['https://dogoodpartybox.co.uk', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Middleware to capture raw body for Stripe webhook verification
app.use((req, res, next) => {
  if (req.path === '/api/stripe-webhook') {
    // For webhook endpoint, use raw body
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    // For all other endpoints, parse as JSON
    express.json()(req, res, next);
  }
});

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

// Email configuration (Zoho Mail)
const transporter = nodemailer.createTransport({
  host: 'smtp.zoho.eu',
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_EMAIL,
    pass: process.env.ZOHO_PASSWORD
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
  
  console.log(`=== AVAILABILITY CHECK START ===`);
  console.log(`Checking availability for party date: ${partyDate.toISOString()}`);
  
  // Block same-day bookings
  if (partyDate.getTime() === today.getTime()) {
    console.log('Date is today - unavailable');
    return {
      pastelAvailable: false,
      brightAvailable: false,
      message: 'Same-day bookings are not available'
    };
  }
  
  try {
    const rows = await getSheetData();
    console.log(`Retrieved ${rows.length} rows from sheet`);
    
    let pastelBooked = false;
    let brightBooked = false;
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawData = row._rawData;
      
      console.log(`\n--- ROW ${i} ---`);
      console.log(`Raw data length: ${rawData.length}`);
      console.log(`Booking ID[0]: "${rawData[0]}"`);
      console.log(`Pastel Booked[1]: "${rawData[1]}"`);
      console.log(`Bright Booked[2]: "${rawData[2]}"`);
      console.log(`First Name[3]: "${rawData[3]}"`);
      console.log(`Last Name[4]: "${rawData[4]}"`);
      console.log(`Customer Email[5]: "${rawData[5]}"`);
      console.log(`Party Date[6]: "${rawData[6]}"`);
      console.log(`Collection Date[7]: "${rawData[7]}"`);
      console.log(`Collection Time[8]: "${rawData[8]}"`);
      console.log(`Delivery Date[9]: "${rawData[9]}"`);
      console.log(`Delivery Time[10]: "${rawData[10]}"`);
      console.log(`Expected Return Date[11]: "${rawData[11]}"`);
      console.log(`Status[14]: "${rawData[14]}"`);
      
      const status = rawData[14];
      if (status !== 'Confirmed') {
        console.log(`  → Skipping - status is "${status}" (not Confirmed)`);
        continue;
      }
      
      // Get both collection and delivery dates
      const collectionDateStr = rawData[7];
      const deliveryDateStr = rawData[9];
      const returnDateStr = rawData[11];
      
      // For availability purposes, use whichever date is populated (collection or delivery)
      const bookingDateStr = collectionDateStr || deliveryDateStr;
      
      console.log(`  Collection: "${collectionDateStr}", Delivery: "${deliveryDateStr}", Return: "${returnDateStr}"`);
      
      if (!bookingDateStr || !returnDateStr) {
        console.log(`  → Skipping - missing booking or return date`);
        continue;
      }
      
      const bookingDate = parseGoogleSheetDate(bookingDateStr);
      const returnDate = parseGoogleSheetDate(returnDateStr);
      console.log(`  Parsed booking: ${bookingDate?.toISOString()}, return: ${returnDate?.toISOString()}`);
      
      if (!bookingDate || !returnDate) {
        console.log(`  → Skipping - date parsing failed`);
        continue;
      }
      
      // Check if party date falls within blocked range (inclusive)
      const isInRange = partyDate >= bookingDate && partyDate <= returnDate;
      console.log(`  Party date (${partyDate.toISOString()}) in range [${bookingDate.toISOString()} to ${returnDate.toISOString()}]? ${isInRange}`);
      
      if (isInRange) {
        const pastel = rawData[1];
        const bright = rawData[2];
        console.log(`    → Date IS BLOCKED`);
        console.log(`    Pastel value: "${pastel}", Bright value: "${bright}"`);
        
        // Check if Pastel kit is booked (non-empty value)
        if (pastel && pastel.trim()) {
          pastelBooked = true;
          console.log(`    → Pastel kit marked as booked`);
        }
        
        // Check if Bright kit is booked (non-empty value)
        if (bright && bright.trim()) {
          brightBooked = true;
          console.log(`    → Bright kit marked as booked`);
        }
      }
    }
    
    console.log(`\n=== FINAL RESULT ===`);
    console.log(`PastelBooked=${pastelBooked}, BrightBooked=${brightBooked}`);
    console.log(`=== AVAILABILITY CHECK END ===\n`);
    
    // Return detailed availability for each colour
    return {
      pastelAvailable: !pastelBooked,
      brightAvailable: !brightBooked,
      message: generateAvailabilityMessage(pastelBooked, brightBooked)
    };
  } catch (error) {
    console.error('Error checking availability:', error);
    return {
      pastelAvailable: true,
      brightAvailable: true,
      message: ''
    };
  }
}

function generateAvailabilityMessage(pastelBooked, brightBooked) {
  if (!pastelBooked && !brightBooked) {
    return 'Both kits available for this date';
  } else if (!pastelBooked) {
    return 'Only Pastel kit is available for this date';
  } else if (!brightBooked) {
    return 'Only Bright kit is available for this date';
  } else {
    return 'This date is fully booked';
  }
}

// API endpoint for availability check
app.get('/api/availability', async (req, res) => {
  const { partyDate } = req.query;
  
  if (!partyDate) {
    return res.status(400).json({ error: 'partyDate parameter required' });
  }
  
  try {
    const availability = await isDateAvailable(partyDate);
    res.json({
      partyDate: partyDate,
      pastelAvailable: availability.pastelAvailable,
      brightAvailable: availability.brightAvailable,
      message: availability.message,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle unavailable date enquiry submissions
app.post('/api/unavailable-enquiry', async (req, res) => {
  const { partyDate, firstName, lastName, guests, postcode, email, notes } = req.body;
  
  if (!partyDate || !firstName || !lastName || !guests || !postcode || !email) {
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
        headerValues: ['Timestamp', 'Party Date', 'First Name', 'Last Name', 'Guests', 'Postcode', 'Email', 'Notes']
      });
    }
    
    // Add a row
    await sheet.addRows([
      {
        'Timestamp': new Date().toISOString(),
        'Party Date': partyDate,
        'First Name': firstName,
        'Last Name': lastName,
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
                text: `*Name:*\n${firstName} ${lastName}`
              },
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

// Create payment intent for Stripe
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const {
      amount,
      currency = 'gbp',
      customerEmail,
      customerName,
      partyDate,
      guests,
      postcode,
      colour,
      washing,
      delivery,
      collectionDate,
      collectionTime,
      deliveryDate,
      deliveryTime
    } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to pence
      currency,
      metadata: {
        customerEmail,
        customerName,
        partyDate,
        guests,
        postcode,
        colour,
        washing,
        delivery,
        collectionDate,
        collectionTime,
        deliveryDate,
        deliveryTime
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stripe webhook handler
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.warn('STRIPE_WEBHOOK_SECRET not set. Webhook signature verification skipped.');
    return res.status(400).json({ error: 'Webhook secret not configured' });
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (error) {
    console.error('Webhook signature verification failed:', error.message);
    return res.status(400).json({ error: `Webhook Error: ${error.message}` });
  }

  // Helper function to convert time window codes to readable format
  function getTimeWindowDisplay(windowCode) {
    const windowMap = {
      'morning': 'Morning (8am–12pm)',
      'afternoon': 'Afternoon (12pm–5pm)',
      'evening': 'Evening (5pm–8pm)'
    };
    return windowMap[windowCode] || windowCode;
  }

  // Handle payment success
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const metadata = paymentIntent.metadata;
    const {
      customerEmail,
      firstName,
      lastName,
      partyDate,
      guests,
      postcode,
      colour,
      washing,
      delivery,
      collectionDate,
      collectionTime,
      deliveryDate,
      deliveryTime
    } = metadata;

    try {
      // Add booking to Google Sheets
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

      const bookingsSheet = doc.sheetsByTitle['Bookings'];
      if (!bookingsSheet) {
        throw new Error('Bookings sheet not found');
      }

      // Determine kit selection based on colour preference
      let pastelBooked = '';
      let brightBooked = '';
      if (colour === 'pastel') {
        pastelBooked = 'Pastel';
      } else if (colour === 'bright') {
        brightBooked = 'Bright';
      } else if (colour === 'no-preference') {
        // For no preference, default to Pastel
        pastelBooked = 'Pastel';
      }

      // Determine collection/delivery details
      const bookingCollectionDate = delivery === 'collect' ? collectionDate : '';
      const bookingCollectionTime = delivery === 'collect' ? collectionTime : '';
      const bookingDeliveryDate = delivery === 'we-deliver' ? deliveryDate : '';
      const bookingDeliveryTime = delivery === 'we-deliver' ? deliveryTime : '';

      // For return date calculation, use party date (not collection/delivery date)
      let returnDate = new Date(partyDate);
      
      // Add exactly 3 days (calendar days, not business days)
      returnDate.setDate(returnDate.getDate() + 3);
      const returnDateFormatted = returnDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/');

      // Convert party date to DD/MM/YYYY format
      const partyDateObj = new Date(partyDate);
      const partyDateFormatted = partyDateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/');

      // Format collection/delivery dates
      const collectionDateFormatted = bookingCollectionDate ? new Date(bookingCollectionDate).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/') : '';
      const deliveryDateFormatted = bookingDeliveryDate ? new Date(bookingDeliveryDate).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '/') : '';

      // Add row to Bookings sheet with all fields
      await bookingsSheet.addRows([{
        'Booking ID': `BK-${Date.now()}`,
        'Pastel Booked': pastelBooked,
        'Bright Booked': brightBooked,
        'First Name': firstName || 'Not provided',
        'Last Name': lastName || 'Not provided',
        'Customer Email': customerEmail,
        'Party Date': partyDateFormatted,
        'Collection Date': collectionDateFormatted,
        'Collection Time': bookingCollectionTime,
        'Delivery Date': deliveryDateFormatted,
        'Delivery Time': bookingDeliveryTime,
        'Expected Return Date': returnDateFormatted,
        'Washing Service (Y/N)': washing === 'we-wash' ? 'Yes' : 'No',
        'Delivery Method (Collect/Deliver)': delivery === 'collect' ? 'Collection' : 'Delivery',
        'Status (Confirmed/Pending/Cancelled)': 'Confirmed',
        'Payment receipt sent': 'Yes'
      }]);

      console.log(`Booking added to sheet for ${firstName} ${lastName}: ${partyDateFormatted}`);

      // Send payment receipt email (detailed version based on delivery method)
      let receiptText, receiptHtml;

      if (delivery === 'collect') {
        const collectionTimeDisplay = getTimeWindowDisplay(bookingCollectionTime);
        receiptText = `Hi ${firstName},\n\nGreat! Your payment of £${(paymentIntent.amount / 100).toFixed(2)} has been received.\n\nYour booking is confirmed for ${partyDateFormatted}.\n\nCollection details:\nDate: ${collectionDateFormatted}\nTime window: ${collectionTimeDisplay}\nLocation: 32 East Street, Colchester, CO1 2TP\n\nLook for the black gate with the yellow number 32. The door is at the end of the path.\n\nPlease return the kit by ${returnDateFormatted}.\n\nThanks for supporting a better way to party.\n\nDo better, Do Good.\n\nCheers,\nCaro & Henry\nThe DGPB Team`;
        receiptHtml = `<p>Hi ${firstName},</p><p>Great! Your payment of £${(paymentIntent.amount / 100).toFixed(2)} has been received.</p><p>Your booking is confirmed for <strong>${partyDateFormatted}</strong>.</p><h3>Collection details</h3><p><strong>Date:</strong> ${collectionDateFormatted}<br><strong>Time window:</strong> ${collectionTimeDisplay}<br><strong>Location:</strong> 32 East Street, Colchester, CO1 2TP</p><p>Look for the black gate with the yellow number 32. The door is at the end of the path.</p><p>Please return the kit by <strong>${returnDateFormatted}</strong>.</p><p>Thanks for supporting a better way to party.</p><p>Do better, Do Good.</p><p>Cheers,<br>Caro & Henry<br>The DGPB Team</p>`;
      } else {
        const deliveryTimeDisplay = getTimeWindowDisplay(bookingDeliveryTime);
        receiptText = `Hi ${firstName},\n\nGreat! Your payment of £${(paymentIntent.amount / 100).toFixed(2)} has been received.\n\nYour booking is confirmed for ${partyDateFormatted}.\n\nDelivery details:\nPreferred date: ${deliveryDateFormatted}\nPreferred window: ${deliveryTimeDisplay}\n\nWe'll contact you to confirm the exact time within your preferred window.\n\nPlease return the kit by ${returnDateFormatted} and we'll collect it from you.\n\nThanks for supporting a better way to party.\n\nDo better, Do Good.\n\nCheers,\nCaro & Henry\nThe DGPB Team`;
        receiptHtml = `<p>Hi ${firstName},</p><p>Great! Your payment of £${(paymentIntent.amount / 100).toFixed(2)} has been received.</p><p>Your booking is confirmed for <strong>${partyDateFormatted}</strong>.</p><h3>Delivery details</h3><p><strong>Preferred date:</strong> ${deliveryDateFormatted}<br><strong>Preferred window:</strong> ${deliveryTimeDisplay}</p><p>We'll contact you to confirm the exact time within your preferred window.</p><p>Please return the kit by <strong>${returnDateFormatted}</strong> and we'll collect it from you.</p><p>Thanks for supporting a better way to party.</p><p>Do better, Do Good.</p><p>Cheers,<br>Caro & Henry<br>The DGPB Team</p>`;
      }

      const mailOptions = {
        from: process.env.ZOHO_EMAIL,
        to: customerEmail,
        subject: 'Your Do Good Party Box booking is confirmed – payment received',
        text: receiptText,
        html: receiptHtml
      };

      await transporter.sendMail(mailOptions);
      console.log(`Payment receipt sent to ${customerEmail}`);

    } catch (error) {
      console.error('Error processing payment confirmation:', error);
      // Don't fail the webhook response even if email fails
    }
  }

  res.json({ received: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Do Good Party Box server running on port ${PORT}`);
});
