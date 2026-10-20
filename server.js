const express = require('express');
const cors = require('cors');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const emailTools = require('./emails');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.set('trust proxy', 1); // behind Fly's proxy, so req.ip is the real visitor (used for rate limiting)

// Enable CORS for your domain
app.use(cors({
  origin: ['https://dogoodpartybox.co.uk', 'https://www.dogoodpartybox.co.uk', 'http://localhost:3000'],
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

// Holidays and other closures live in a "Blocked Dates" tab of the same Google Sheet.
// Columns: From | To (optional, blank = one day) | Kit (Both, Pastel or Bright; blank = Both) | Reason (private note)
// A party date is blocked when its handover window overlaps the closure: we keep parties off the
// BLOCK_DAYS_BEFORE days before (collection or delivery) and the BLOCK_DAYS_AFTER days after (the kit's return).
const BLOCKED_SHEET_TITLE = 'Blocked Dates';
const BLOCKED_HEADERS = ['From', 'To', 'Kit', 'Reason'];
const BLOCK_DAYS_BEFORE = 2;
const BLOCK_DAYS_AFTER = 3;
const BLOCK_CACHE_MS = (process.env.BLOCKED_CACHE_SECONDS !== undefined ? Number(process.env.BLOCKED_CACHE_SECONDS) : 30) * 1000;
let blockedCache = { at: 0, rows: [] };

// Returns the closures as [{ from: Date, to: Date, pastel: bool, bright: bool }]. Rows that cannot be read are skipped with a warning.
async function loadBlockedRanges() {
  if (BLOCK_CACHE_MS > 0 && Date.now() - blockedCache.at < BLOCK_CACHE_MS) return blockedCache.rows;
  const doc = await getSheetsDoc();
  let sheet = doc.sheetsByTitle[BLOCKED_SHEET_TITLE];
  if (!sheet) {
    try {
      await doc.addSheet({ title: BLOCKED_SHEET_TITLE, headerValues: BLOCKED_HEADERS });
    } catch (e) {
      console.error('Could not create the Blocked Dates tab:', e.message);
    }
    blockedCache = { at: Date.now(), rows: [] };
    return [];
  }
  const rows = await sheet.getRows();
  const col = (name) => sheet.headerValues.indexOf(name);
  const ranges = [];
  rows.forEach((row, n) => {
    const get = (name) => { const i = col(name); return i === -1 || row._rawData[i] === undefined ? '' : String(row._rawData[i]).trim(); };
    const fromStr = get('From');
    if (!fromStr) return; // blank row
    const from = parseFlexibleDate(fromStr);
    const to = get('To') ? parseFlexibleDate(get('To')) : from;
    if (!from || !to || to < from) {
      console.warn(`Blocked Dates row ${n + 2} ignored: could not read the dates "${fromStr}" to "${get('To')}". Use DD/MM/YYYY.`);
      return;
    }
    const kit = get('Kit').toLowerCase();
    let pastel = true, bright = true;
    if (kit === 'pastel') bright = false;
    else if (kit === 'bright') pastel = false;
    else if (kit && kit !== 'both' && kit !== 'all') console.warn(`Blocked Dates row ${n + 2}: kit "${get('Kit')}" not recognised, blocking both kits.`);
    ranges.push({ from, to, pastel, bright });
  });
  blockedCache = { at: Date.now(), rows: ranges };
  return ranges;
}

// Which kits are closed off for this party date? Fails open (and logs) if the tab cannot be read, like the rest of the availability check.
async function getBlockedKits(partyDate) {
  try {
    const ranges = await loadBlockedRanges();
    const day = 86400000;
    const windowStart = partyDate.getTime() - BLOCK_DAYS_BEFORE * day;
    const windowEnd = partyDate.getTime() + BLOCK_DAYS_AFTER * day;
    let pastel = false, bright = false;
    for (const r of ranges) {
      if (r.from.getTime() <= windowEnd && r.to.getTime() >= windowStart) {
        if (r.pastel) pastel = true;
        if (r.bright) bright = true;
      }
    }
    return { pastel, bright };
  } catch (error) {
    console.error('Error reading Blocked Dates:', error.message);
    return { pastel: false, bright: false };
  }
}

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
    
    // Holidays and other closures
    const blocked = await getBlockedKits(partyDate);
    if (blocked.pastel) pastelBooked = true;
    if (blocked.bright) brightBooked = true;

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
  const { partyDate, firstName, lastName, guests, postcode, email, notes, marketingConsent } = req.body;
  
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
        headerValues: ['Timestamp', 'Party Date', 'First Name', 'Last Name', 'Guests', 'Postcode', 'Email', 'Notes', 'Marketing Consent']
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
        'Notes': notes || '',
        'Marketing Consent': marketingConsent === true ? 'Yes' : 'No'
      }
    ]);
    
    // Tell us straight away by email (and Slack if it is set up). Replying to the alert replies to the customer.
    const enquiryName = `${firstName} ${lastName}`;
    await notifyOwners(
      `📅 Date enquiry: ${enquiryName}, ${emailTools.longDate(partyDate)}`,
      `Someone asked about a date that is not available.\n\nName: ${enquiryName}\nEmail: ${email}\nParty date: ${emailTools.longDate(partyDate)}\nGuests: ${guests}\nPostcode: ${postcode}\nNotes: ${notes || 'None'}\nOK to email about offers: ${marketingConsent === true ? 'Yes' : 'No'}\n\nReply to this email to answer them directly.`,
      { replyTo: email }
    );

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

// ===== PRICING, DELIVERY AND DISCOUNTS =====
// The server is the source of truth for the price. Amounts sent by the browser are never trusted.
const KIT_PRICE = 25;
// Hire terms (keep in step with the Hire terms pop-up in index.html)
const TERMS_VERSION = '2026-10';
const LATE_FEE_PER_DAY = 5;

// Where customers collect from. what3words is the most precise; the Maps link is a backup.
// To use an exact pin drop, open the spot in Google Maps, choose Share, copy the link and paste it into COLLECTION_MAPS_URL below.
const COLLECTION_ADDRESS = '32 East Street, Colchester, CO1 2TP';
const COLLECTION_W3W = '///trace.meal.sling';
const COLLECTION_W3W_URL = 'https://what3words.com/trace.meal.sling';
const COLLECTION_MAPS_URL = 'https://maps.app.goo.gl/6BJwnWAwNNY7HAVV9'; // pin drop at 51.889956, 0.917591
const REPLACEMENT_CHARGE_PER_ITEM = 1;
const WASHING_PRICE = 5;
const MIN_KIT_PRICE_AFTER_DISCOUNT = 1; // a discount can never take the kit below this (Stripe's minimum charge is 30p)

// Customer emails (confirmation, reminders, feedback, cancellation) are built in emails.js from these figures.
// The feedback email links to the Google Form below. The FEEDBACK_URL Fly secret overrides it if it is ever set.
const FEEDBACK_FORM_URL = 'https://forms.gle/hMCjTrKxmr9ge3eK6';
// Public review page, offered to every customer in the feedback email (not only happy ones)
const REVIEW_URL = 'https://www.facebook.com/share/1C8WcFzzYY/';
const emails = emailTools.create({
  kitPrice: KIT_PRICE,
  washingPrice: WASHING_PRICE,
  lateFee: LATE_FEE_PER_DAY,
  replacementCharge: REPLACEMENT_CHARGE_PER_ITEM,
  termsVersion: TERMS_VERSION,
  collectionAddress: COLLECTION_ADDRESS,
  w3w: COLLECTION_W3W,
  w3wUrl: COLLECTION_W3W_URL,
  mapsUrl: COLLECTION_MAPS_URL,
  contactEmail: 'hello@dogoodpartybox.co.uk',
  feedbackUrl: process.env.FEEDBACK_URL || FEEDBACK_FORM_URL,
  reviewUrl: REVIEW_URL
});

function roundMoney(n) {
  return Math.round(n * 100) / 100;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3959; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Same bands as the website: up to 2 miles free, up to 5 miles £5, up to 10 miles £10, beyond that no delivery
async function getDeliveryCostForPostcode(postcode) {
  const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
  if (!response.ok) return null;
  const data = await response.json();
  if (!data.result) return null;
  const distance = haversineMiles(BUSINESS_LAT, BUSINESS_LNG, data.result.latitude, data.result.longitude);
  if (distance > 10) return null;
  if (distance > 5) return 10;
  if (distance > 2) return 5;
  return 0;
}

async function getSheetsDoc() {
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
  return doc;
}

// Where internal alerts (new bookings, problems) are emailed. Keeps the customer inbox clean. Override with the ALERT_EMAIL secret on Fly.
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'dogoodpartybox@gmail.com';

// Tell the owners something happened: an email to ALERT_EMAIL, plus Slack if it is set up. Never throws.
// Pass { replyTo } so that replying to the alert goes straight to the customer.
async function notifyOwners(subject, text, options = {}) {
  try {
    await transporter.sendMail({
      from: process.env.ZOHO_EMAIL,
      to: ALERT_EMAIL,
      subject,
      text,
      ...(options.replyTo ? { replyTo: options.replyTo } : {})
    });
  } catch (error) {
    console.error('Error sending alert email:', error);
  }
  await notifySlack(`${subject}\n${text}`);
}

async function notifySlack(text) {
  if (!process.env.SLACK_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (error) {
    console.error('Error sending Slack notification:', error);
  }
}

// Discount codes live in a "Discount Codes" tab of the same Google Sheet so they can be added or switched off without touching code.
// Columns: Code | Type (percent or fixed) | Value | Active (Y/N) | Expires (optional) | Max Uses (optional) | Times Used | Notes
const DISCOUNT_SHEET_TITLE = 'Discount Codes';
const DISCOUNT_HEADERS = ['Code', 'Type', 'Value', 'Active', 'Expires', 'Max Uses', 'Times Used', 'Notes'];

function parseFlexibleDate(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return null;
}

async function loadDiscountRow(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;
  const doc = await getSheetsDoc();
  const sheet = doc.sheetsByTitle[DISCOUNT_SHEET_TITLE];
  if (!sheet) {
    // First use: create the tab with headers (same approach as the enquiry and search log tabs)
    await doc.addSheet({ title: DISCOUNT_SHEET_TITLE, headerValues: DISCOUNT_HEADERS });
    return null;
  }
  const rows = await sheet.getRows();
  const headers = sheet.headerValues;
  const colIndex = (name) => headers.indexOf(name);
  const row = rows.find(r => String(r._rawData[colIndex('Code')] || '').trim().toUpperCase() === code);
  if (!row) return null;
  const get = (name) => {
    const i = colIndex(name);
    return i === -1 ? '' : String(row._rawData[i] === undefined ? '' : row._rawData[i]).trim();
  };
  return { code, row, get };
}

// Returns { valid: false } or { valid: true, code, discountAmount }
async function evaluateDiscount(rawCode) {
  const found = await loadDiscountRow(rawCode);
  if (!found) return { valid: false };
  const { code, get } = found;

  if (!['y', 'yes', 'true'].includes(get('Active').toLowerCase())) return { valid: false };

  const expires = parseFlexibleDate(get('Expires'));
  if (get('Expires') && !expires) return { valid: false }; // unreadable date: fail closed
  if (expires) {
    expires.setHours(23, 59, 59, 999); // valid right through the expiry day
    if (new Date() > expires) return { valid: false };
  }

  const maxUsesRaw = get('Max Uses');
  if (maxUsesRaw) {
    const maxUses = parseInt(maxUsesRaw, 10);
    const timesUsed = parseInt(get('Times Used') || '0', 10) || 0;
    if (isNaN(maxUses) || timesUsed >= maxUses) return { valid: false };
  }

  const type = get('Type').toLowerCase();
  const value = parseFloat(get('Value').replace(/[£%\s,]/g, ''));
  if (isNaN(value) || value <= 0) return { valid: false };

  let amount;
  if (type === 'percent') {
    if (value >= 100) return { valid: false }; // 100% codes are not supported (card payments cannot be £0)
    amount = KIT_PRICE * value / 100;
  } else if (type === 'fixed') {
    amount = value;
  } else {
    return { valid: false };
  }

  // Discounts apply to kit hire only, and can never take the kit below the minimum
  amount = roundMoney(Math.min(amount, KIT_PRICE - MIN_KIT_PRICE_AFTER_DISCOUNT));
  if (!(amount > 0)) return { valid: false };

  return { valid: true, code, discountAmount: amount };
}

// Only counted once a payment has actually succeeded
async function recordDiscountUse(rawCode) {
  const found = await loadDiscountRow(rawCode);
  if (!found) return;
  const timesUsed = parseInt(found.get('Times Used') || '0', 10) || 0;
  found.row.set('Times Used', timesUsed + 1);
  await found.row.save();
}

// Simple in-memory limiter so codes cannot be guessed in bulk (20 attempts per 10 minutes per visitor)
const discountAttempts = new Map();
function discountRateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 20;
  if (discountAttempts.size > 1000) {
    for (const [key, entry] of discountAttempts) {
      if (entry.resetAt < now) discountAttempts.delete(key);
    }
  }
  const entry = discountAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    discountAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count++;
  return entry.count > maxAttempts;
}

// Check a discount code (used by the Apply button on the website)
app.post('/api/validate-discount', async (req, res) => {
  const { code } = req.body || {};
  if (!code || !String(code).trim()) {
    return res.status(400).json({ valid: false, message: 'Please enter a code' });
  }
  if (discountRateLimited(req.ip)) {
    return res.status(429).json({ valid: false, message: 'Too many attempts. Please try again in a few minutes.' });
  }
  try {
    const result = await evaluateDiscount(code);
    if (!result.valid) {
      return res.json({ valid: false, message: "That code isn't valid or has expired" });
    }
    res.json({
      valid: true,
      code: result.code,
      discountAmount: result.discountAmount,
      message: `Code ${result.code} applied: £${result.discountAmount.toFixed(2)} off kit hire`
    });
  } catch (error) {
    console.error('Error validating discount code:', error);
    res.status(500).json({ valid: false, message: 'Could not check that code right now. Please try again.' });
  }
});

// ===== BOOKINGS SHEET: EXTRA COLUMNS =====
// New columns only ever go on the far right, because availability reads the older columns by position.
// They are added to the Bookings tab automatically (header names below) if they are missing.
const BOOKING_STATUS_HEADER = 'Status (Confirmed/Pending/Cancelled)';
const BOOKING_EXTRA_HEADERS = [
  'Phone', 'Guests', 'Delivery Address', 'Delivery Notes',
  'Pre-party Reminder Sent', 'Return Reminder Sent', 'Feedback Request Sent', 'Cancellation Email Sent'
];

let ensureChain = Promise.resolve();
async function addMissingBookingColumns(sheet) {
  await sheet.loadHeaderRow();
  const missing = BOOKING_EXTRA_HEADERS.filter(h => !sheet.headerValues.includes(h));
  if (!missing.length) return;
  const newHeaders = [...sheet.headerValues, ...missing];
  if (newHeaders.length > sheet.columnCount) {
    await sheet.resize({ rowCount: sheet.rowCount, columnCount: newHeaders.length });
  }
  await sheet.setHeaderRow(newHeaders);
  console.log('Added Bookings columns: ' + missing.join(', '));
}
// One at a time, so two bookings arriving together cannot add the same column twice
function ensureBookingColumns(sheet) {
  const run = ensureChain.then(() => addMissingBookingColumns(sheet));
  ensureChain = run.catch(() => {});
  return run;
}
// A problem here must never stop a paid booking being saved
async function ensureBookingColumnsSafe(sheet) {
  try {
    await ensureBookingColumns(sheet);
  } catch (error) {
    console.error('Could not add the new Bookings columns:', error);
    await notifyOwners('⚠️ Bookings sheet needs new columns', `The site could not add these columns to the right of the Bookings tab by itself: ${BOOKING_EXTRA_HEADERS.join(', ')}. Please add them by hand (exact names, at the far right). Bookings are still being saved.\n\nError: ${error.message}`);
  }
}

function cellValue(sheet, row, name) {
  const i = sheet.headerValues.indexOf(name);
  return i === -1 ? '' : String(row._rawData[i] === undefined ? '' : row._rawData[i]).trim();
}
async function setCellValues(row, values) {
  for (const [name, value] of Object.entries(values)) row.set(name, value);
  await row.save();
}

// ===== DAILY CUSTOMER EMAILS (reminder before the party, reminder before the return, feedback request) =====
const PARTY_REMINDER_DAYS_BEFORE = 2;   // sent when the handover (collection or delivery) is 1 to 2 days away
const FEEDBACK_DAYS_AFTER_RETURN = 2;   // sent 2 to 14 days after the return date

function londonDateString(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
// DD/MM/YYYY, matching the other dates in the sheet
function ukDateLabel(now) {
  return londonDateString(now).split('-').reverse().join('/');
}
function dayNumber(value) {
  const d = emailTools.parseDay(value);
  return d ? Math.round(d.getTime() / 86400000) : null;
}

async function sendCustomerEmail(to, mail) {
  await transporter.sendMail({ from: process.env.ZOHO_EMAIL, to, subject: mail.subject, text: mail.text, html: mail.html });
}

async function runDailyEmails(now = new Date()) {
  const result = { partyReminders: 0, returnReminders: 0, feedbackRequests: 0 };
  const doc = await getSheetsDoc();
  const sheet = doc.sheetsByTitle['Bookings'];
  if (!sheet) return result;
  await ensureBookingColumnsSafe(sheet);
  const rows = await sheet.getRows();
  const todayStamp = londonDateString(now);
  const today = dayNumber(todayStamp);

  for (const row of rows) {
    const get = (name) => cellValue(sheet, row, name);
    if (get(BOOKING_STATUS_HEADER) !== 'Confirmed') continue;
    const to = get('Customer Email');
    if (!to) continue;

    const delivery = get('Delivery Method (Collect/Deliver)') === 'Delivery' ? 'we-deliver' : 'collect';
    const handoverDate = delivery === 'collect' ? get('Collection Date') : get('Delivery Date');
    const returnDate = get('Expected Return Date');
    const data = {
      firstName: get('First Name') || 'there',
      guests: get('Guests'),
      kit: get('Pastel Booked') ? 'pastel' : (get('Bright Booked') ? 'bright' : ''),
      partyDate: get('Party Date'),
      delivery,
      handoverDate,
      handoverWindow: delivery === 'collect' ? get('Collection Time') : get('Delivery Time'),
      returnDate,
      washing: get('Washing Service (Y/N)') === 'Yes' ? 'we-wash' : 'rinse-yourself',
      deliveryAddress: get('Delivery Address'),
      phone: get('Phone')
    };

    const send = async (flag, mail, label, counter) => {
      if (!sheet.headerValues.includes(flag)) return; // never resend every day because a column is missing
      try {
        await sendCustomerEmail(to, mail);
        await setCellValues(row, { [flag]: ukDateLabel(now) });
        result[counter]++;
        console.log(`${label} sent to ${to}`);
      } catch (error) {
        console.error(`${label} failed for ${to}:`, error);
        await notifyOwners(`⚠️ ${label} FAILED`, `Could not send the ${label.toLowerCase()} to ${data.firstName} (${to}, party ${data.partyDate}). We will try again tomorrow. Error: ${error.message}`);
      }
    };

    // 1. A couple of days before the collection or delivery. Skipped for bookings made in the last 20 hours (they have just had their confirmation).
    const untilHandover = dayNumber(handoverDate) === null ? null : dayNumber(handoverDate) - today;
    const bookedAt = Number((get('Booking ID').match(/^BK-(\d+)$/) || [])[1]);
    const justBooked = bookedAt && (now.getTime() - bookedAt) < 20 * 3600 * 1000;
    if (!get('Pre-party Reminder Sent') && untilHandover !== null && untilHandover >= 1 && untilHandover <= PARTY_REMINDER_DAYS_BEFORE && !justBooked) {
      await send('Pre-party Reminder Sent', emails.partyReminder(data), 'Party reminder', 'partyReminders');
    }

    // 2. The day before the kit is due back
    const untilReturn = dayNumber(returnDate) === null ? null : dayNumber(returnDate) - today;
    if (!get('Return Reminder Sent') && untilReturn !== null && untilReturn >= 0 && untilReturn <= 1) {
      await send('Return Reminder Sent', emails.returnReminder(data), 'Return reminder', 'returnReminders');
    }

    // 3. A couple of days after the return date, once
    if (!get('Feedback Request Sent') && untilReturn !== null && -untilReturn >= FEEDBACK_DAYS_AFTER_RETURN && -untilReturn <= 14) {
      await send('Feedback Request Sent', emails.feedbackRequest(data), 'Feedback request', 'feedbackRequests');
    }
  }
  return result;
}

// 9am UK time every day. The server stays running (min_machines_running = 1 in fly.toml).
cron.schedule('0 9 * * *', () => {
  console.log('Running daily customer emails');
  runDailyEmails().catch(async (error) => {
    console.error('Daily customer emails failed:', error);
    await notifyOwners('⚠️ Daily reminder emails FAILED', `The daily reminder run could not complete: ${error.message}`);
  });
}, { timezone: 'Europe/London' });

// Add the new Bookings columns shortly after start-up, so they are there before the first booking
setTimeout(async () => {
  try {
    const doc = await getSheetsDoc();
    const sheet = doc.sheetsByTitle['Bookings'];
    if (sheet) await ensureBookingColumnsSafe(sheet);
  } catch (error) {
    console.error('Start-up column check failed:', error.message);
  }
}, 3000).unref();

// ===== REFUNDS: cancellation email =====
// When a booking is refunded in full in Stripe, mark it Cancelled (which frees the dates) and tell the customer.
async function handleChargeRefunded(charge) {
  const doc = await getSheetsDoc();
  const sheet = doc.sheetsByTitle['Bookings'];
  if (!sheet) return;
  await ensureBookingColumnsSafe(sheet);
  const rows = await sheet.getRows();
  const row = rows.find(r => cellValue(sheet, r, 'Payment Intent ID') === charge.payment_intent);
  if (!row) {
    console.log(`Refund on ${charge.payment_intent} has no booking row, ignoring`);
    return;
  }
  const get = (name) => cellValue(sheet, row, name);
  const name = `${get('First Name')} ${get('Last Name')}`.trim();
  const refunded = (charge.amount_refunded || 0) / 100;
  const fullRefund = charge.refunded === true || (charge.amount_refunded || 0) >= (charge.amount || Infinity);

  if (!fullRefund) {
    await notifyOwners(`ℹ️ Partial refund: ${name}`, `A partial refund of £${refunded.toFixed(2)} was made on ${name}'s booking for ${get('Party Date')}. The booking stays Confirmed and no email was sent to the customer.`);
    return;
  }
  if (get(BOOKING_STATUS_HEADER) !== 'Cancelled') {
    await setCellValues(row, { [BOOKING_STATUS_HEADER]: 'Cancelled' });
  }
  if (get('Cancellation Email Sent') || !sheet.headerValues.includes('Cancellation Email Sent')) return;
  const mail = emails.cancellation({ firstName: get('First Name') || 'there', partyDate: get('Party Date'), refundAmount: refunded });
  try {
    await sendCustomerEmail(get('Customer Email'), mail);
    await setCellValues(row, { 'Cancellation Email Sent': ukDateLabel(new Date()) });
  } catch (error) {
    console.error('Cancellation email failed:', error);
    await notifyOwners('⚠️ Cancellation email FAILED', `${name} (${get('Customer Email')}) was refunded £${refunded.toFixed(2)} but the cancellation email could not be sent. Please email them by hand.\n\n${mail.text}`);
    return;
  }
  await notifyOwners(`Booking cancelled: ${name}, ${get('Party Date')}`, `${name}'s booking for ${get('Party Date')} was refunded in full (£${refunded.toFixed(2)}). The sheet now says Cancelled, so the dates are free again, and the customer has been sent a cancellation email.`);
}

// Create payment intent for Stripe
// The price is worked out here from the booking details. Any amount sent by the browser is ignored.
app.post('/api/create-payment-intent', async (req, res) => {
  try {
    const {
      customerEmail,
      firstName,
      lastName,
      partyDate,
      guests,
      postcode,
      washing,
      delivery,
      collectionDate,
      collectionTime,
      deliveryDate,
      deliveryTime,
      discountCode,
      termsAccepted,
      marketingConsent
    } = req.body;
    const colour = req.body.colour || 'no-preference';
    const phone = String(req.body.phone || '').trim();
    const deliveryAddress = String(req.body.deliveryAddress || '').trim().slice(0, 200);
    const deliveryNotes = String(req.body.deliveryNotes || '').trim().slice(0, 200);

    if (!firstName || !lastName || !customerEmail || !partyDate || !postcode || !guests) {
      return res.status(400).json({ error: 'Please fill in all required fields' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail))) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (termsAccepted !== true) {
      return res.status(400).json({ error: 'Please read and accept the hire terms to continue' });
    }
    if (!/^[0-9+()\-\s]{10,20}$/.test(phone) || phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Please enter a phone number we can reach you on' });
    }
    if (!['collect', 'we-deliver'].includes(delivery)) {
      return res.status(400).json({ error: 'Please choose delivery or collection' });
    }
    if (!['rinse-yourself', 'we-wash'].includes(washing)) {
      return res.status(400).json({ error: 'Please choose a washing option' });
    }
    if (!['pastel', 'bright', 'no-preference'].includes(colour)) {
      return res.status(400).json({ error: 'Please choose a valid kit colour' });
    }
    if (delivery === 'collect' && (!collectionDate || !collectionTime)) {
      return res.status(400).json({ error: 'Please select a collection date and time window' });
    }
    if (delivery === 'we-deliver' && (!deliveryDate || !deliveryTime)) {
      return res.status(400).json({ error: 'Please select a delivery date and time window' });
    }
    if (delivery === 'we-deliver' && deliveryAddress.length < 5) {
      return res.status(400).json({ error: 'Please enter the address we should deliver to' });
    }

    const partyDay = new Date(partyDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    partyDay.setHours(0, 0, 0, 0);
    if (isNaN(partyDay.getTime()) || partyDay <= today) {
      return res.status(400).json({ error: 'Please choose a party date in the future' });
    }

    // Check the date again now, and decide which kit this booking gets
    const availability = await isDateAvailable(partyDate);
    let kit = null;
    if (colour === 'pastel') {
      kit = availability.pastelAvailable ? 'pastel' : null;
    } else if (colour === 'bright') {
      kit = availability.brightAvailable ? 'bright' : null;
    } else if (availability.pastelAvailable) {
      kit = 'pastel';
    } else if (availability.brightAvailable) {
      kit = 'bright';
    }
    if (!kit) {
      return res.status(409).json({ error: 'Sorry, that kit is no longer available for your date. Please choose another date or colour.' });
    }

    let deliveryCost = 0;
    if (delivery === 'we-deliver') {
      deliveryCost = await getDeliveryCostForPostcode(postcode);
      if (deliveryCost === null) {
        return res.status(400).json({ error: 'Your postcode is outside our delivery area. Please choose collection or contact us.' });
      }
    }

    let discountAmount = 0;
    let appliedCode = '';
    if (discountCode && String(discountCode).trim()) {
      if (discountRateLimited(req.ip)) {
        return res.status(429).json({ error: 'Too many discount code attempts. Please try again in a few minutes.' });
      }
      const result = await evaluateDiscount(discountCode);
      if (!result.valid) {
        return res.status(400).json({
          error: 'That discount code is no longer valid, so it has been removed. Please check your total and try again.',
          discountInvalid: true
        });
      }
      discountAmount = result.discountAmount;
      appliedCode = result.code;
    }

    const washingCost = washing === 'we-wash' ? WASHING_PRICE : 0;
    const total = roundMoney(KIT_PRICE - discountAmount + washingCost + deliveryCost);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100), // Convert to pence
      currency: 'gbp',
      metadata: {
        customerEmail,
        firstName,
        lastName,
        partyDate,
        guests,
        postcode,
        colour,
        kit,
        washing,
        delivery,
        deliveryCost,
        collectionDate,
        collectionTime,
        deliveryDate,
        deliveryTime,
        phone,
        deliveryAddress: delivery === 'we-deliver' ? deliveryAddress : '',
        deliveryNotes: delivery === 'we-deliver' ? deliveryNotes : '',
        discountCode: appliedCode,
        discountAmount: discountAmount.toFixed(2),
        termsAccepted: 'yes',
        termsVersion: TERMS_VERSION,
        termsAcceptedAt: new Date().toISOString(),
        marketingConsent: marketingConsent === true ? 'yes' : 'no'
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      total,
      kit
    });
  } catch (error) {
    console.error('Error creating payment intent:', error);
    res.status(500).json({ error: 'Something went wrong setting up your payment. Please try again.' });
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

  const getTimeWindowDisplay = emailTools.windowLabel;

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
      deliveryCost,
      collectionDate,
      collectionTime,
      deliveryDate,
      deliveryTime,
      phone,
      deliveryAddress,
      deliveryNotes,
      discountCode,
      discountAmount,
      kit,
      marketingConsent
    } = metadata;

    let bookingSaved = false;
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
      await ensureBookingColumns(bookingsSheet);

      // Stripe can send the same event more than once, so skip payments already recorded
      const existingRows = await bookingsSheet.getRows();
      const paymentIdColumn = bookingsSheet.headerValues.indexOf('Payment Intent ID');
      if (paymentIdColumn === -1) {
        console.warn("Bookings sheet has no 'Payment Intent ID' column. Add it so duplicate webhook deliveries can be ignored.");
      } else if (existingRows.some(r => r._rawData[paymentIdColumn] === paymentIntent.id)) {
        console.log(`Payment ${paymentIntent.id} already recorded, skipping duplicate webhook`);
        return res.json({ received: true });
      }

      // Use the kit assigned when the payment was created (falls back to the colour choice for older payments)
      const assignedKit = kit || (colour === 'bright' ? 'bright' : 'pastel');
      const pastelBooked = assignedKit === 'pastel' ? 'Pastel' : '';
      const brightBooked = assignedKit === 'bright' ? 'Bright' : '';

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
      const bookingId = `BK-${Date.now()}`;
      await bookingsSheet.addRows([{
        'Booking ID': bookingId,
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
        'Delivery Cost (£)': deliveryCost || 0,
        'Status (Confirmed/Pending/Cancelled)': 'Confirmed',
        'Payment receipt sent': 'Yes',
        'Discount Code': discountCode || '',
        'Discount Amount (£)': discountAmount || 0,
        'Payment Intent ID': paymentIntent.id,
        'Marketing Consent': marketingConsent === 'yes' ? 'Yes' : 'No',
        'Phone': phone || '',
        'Guests': guests || '',
        'Delivery Address': deliveryAddress || '',
        'Delivery Notes': deliveryNotes || ''
      }]);

      bookingSaved = true;
      console.log(`Booking added to sheet for ${firstName} ${lastName}: ${partyDateFormatted}`);

      // Tell us straight away (before the customer email, so a failed email cannot hide a booking)
      const alertTotal = (paymentIntent.amount / 100).toFixed(2);
      const alertHandover = delivery === 'collect'
        ? `Collection: ${emailTools.longDate(collectionDateFormatted)}, ${getTimeWindowDisplay(bookingCollectionTime)}`
        : `Delivery: ${emailTools.longDate(deliveryDateFormatted)}, ${getTimeWindowDisplay(bookingDeliveryTime)}\nDeliver to: ${deliveryAddress || 'not given'}, ${postcode}${deliveryNotes ? `\nAddress notes: ${deliveryNotes}` : ''}`;
      await notifyOwners(
        `🎉 New booking: ${firstName} ${lastName}, ${partyDateFormatted}`,
        `Customer: ${firstName} ${lastName}\nEmail: ${customerEmail}\nPhone: ${phone || 'not given'}\nParty date: ${emailTools.longDate(partyDateFormatted)} (${guests || '?'} guests, ${assignedKit} kit)\n${alertHandover}\nReturn by: ${emailTools.longDate(returnDateFormatted)}\nWashing: ${washing === 'we-wash' ? 'We wash it' : 'Customer washes it'}\nTotal paid: £${alertTotal}${discountCode ? ` (code ${discountCode})` : ''}\nBooking ID: ${bookingId}\n\nReply to this email to write to the customer.`,
        { replyTo: customerEmail }
      );

      if (discountCode) {
        try {
          await recordDiscountUse(discountCode);
        } catch (usageError) {
          console.error('Could not update discount usage count:', usageError);
        }
      }

      // Confirmation email for the customer (collection or delivery version), built in emails.js
      const confirmation = emails.bookingConfirmation({
        firstName,
        guests,
        kit: assignedKit,
        partyDate,
        delivery,
        handoverDate: delivery === 'collect' ? collectionDate : deliveryDate,
        handoverWindow: delivery === 'collect' ? collectionTime : deliveryTime,
        returnDate: returnDateFormatted,
        washing,
        discountCode,
        discountAmount: parseFloat(discountAmount || '0') || 0,
        deliveryFee: Number(deliveryCost) || 0,
        total: paymentIntent.amount / 100,
        deliveryAddress,
        postcode,
        phone
      });

      try {
        await transporter.sendMail({
          from: process.env.ZOHO_EMAIL,
          to: customerEmail,
          subject: confirmation.subject,
          text: confirmation.text,
          html: confirmation.html
        });
        console.log(`Payment receipt sent to ${customerEmail}`);
      } catch (mailError) {
        console.error('Receipt email failed:', mailError);
        await notifyOwners('⚠️ Receipt email FAILED', `The booking is saved but the confirmation email failed for ${firstName} ${lastName} (${customerEmail}, party ${partyDateFormatted}). Please email them the details by hand. This is the text they should have received:\n\n${confirmation.text}`, { replyTo: customerEmail });
      }

    } catch (error) {
      console.error('Error processing payment confirmation:', error);
      if (!bookingSaved) {
        // The customer has paid but there is no booking row. Ask Stripe to retry and raise the alarm.
        await notifyOwners('🚨 PAYMENT TAKEN BUT BOOKING NOT SAVED', `Payment ${paymentIntent.id}: ${firstName} ${lastName}, ${customerEmail}, party date ${partyDate}. Stripe will retry automatically; check the Bookings sheet and add it by hand if it does not appear.`);
        return res.status(500).json({ error: 'Booking could not be saved' });
      }
      // The booking is saved, so a failed email or usage count must not make Stripe retry
    }
  }

  if (event.type === 'charge.refunded') {
    try {
      await handleChargeRefunded(event.data.object);
    } catch (error) {
      console.error('Error handling refund:', error);
      return res.status(500).json({ error: 'Refund could not be processed' }); // Stripe will retry
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

module.exports = { app, runDailyEmails };
