// Runs the real server.js with the outside world (Google Sheets, Stripe, email, postcodes.io, Slack) simulated
const Module = require('module');
const fs = require('fs');
const path = require('path');

// The harness runs the real server.js from the repo root

// ---------- simulated Google Sheet ----------
const BOOKING_HEADERS = ['Booking ID', 'Pastel Booked', 'Bright Booked', 'First Name', 'Last Name', 'Customer Email',
  'Party Date', 'Collection Date', 'Collection Time', 'Delivery Date', 'Delivery Time', 'Expected Return Date',
  'Washing Service (Y/N)', 'Delivery Method (Collect/Deliver)', 'Status (Confirmed/Pending/Cancelled)',
  'Delivery Cost (£)', 'Payment receipt sent', 'Discount Code', 'Discount Amount (£)', 'Payment Intent ID', 'Marketing Consent'];

const state = {
  failBookingWrite: false,
  sheets: {},
  mail: [],
  slack: [],
  intents: [],
};
function makeSheet(title, headers) {
  const sheet = {
    title, headerValues: headers.slice(), rows: [], columnCount: headers.length, rowCount: 1000,
    async loadHeaderRow() {},
    async resize({ columnCount }) { this.columnCount = columnCount; },
    async setHeaderRow(h) {
      if (h.length > this.columnCount) throw new Error('Sheet is not large enough to fit ' + h.length + ' columns. Resize the sheet first.');
      if (new Set(h).size !== h.length) throw new Error('duplicate header');
      state.headerWrites = (state.headerWrites || 0) + 1;
      this.headerValues = h.slice();
    },
    async getRows() {
      return this.rows.map(raw => ({
        _rawData: raw,
        set(name, val) { const i = sheet.headerValues.indexOf(name); if (i === -1) throw new Error('no header ' + name); raw[i] = String(val); },
        async save() {},
      }));
    },
    async addRows(objs) {
      if (title === 'Bookings' && state.failBookingWrite) throw new Error('Simulated Google Sheets outage');
      for (const o of objs) sheet.rows.push(sheet.headerValues.map(h => (o[h] === undefined ? '' : String(o[h]))));
    },
  };
  state.sheets[title] = sheet;
  return sheet;
}
makeSheet('Bookings', BOOKING_HEADERS);
const disc = makeSheet('Discount Codes', ['Code', 'Type', 'Value', 'Active', 'Expires', 'Max Uses', 'Times Used', 'Notes']);
const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
const yesterday = new Date(Date.now() - 86400000), nextYear = new Date(Date.now() + 365 * 86400000);
disc.rows.push(['SCHOOL10', 'percent', '10', 'Y', fmt(nextYear), '', '', 'Willow Brook']);
disc.rows.push(['FIVEOFF', 'fixed', '£5', 'yes', '', '', '0', '']);
disc.rows.push(['EXPIRED', 'percent', '10', 'Y', fmt(yesterday), '', '', '']);
disc.rows.push(['SWITCHEDOFF', 'percent', '10', 'N', '', '', '', '']);
disc.rows.push(['USEDUP', 'percent', '10', 'Y', '', '2', '2', '']);
disc.rows.push(['FULLFAT', 'percent', '100', 'Y', '', '', '', '']);
disc.rows.push(['HUGE', 'fixed', '100', 'Y', '', '', '', '']);
disc.rows.push(['BADDATE', 'percent', '10', 'Y', 'next tuesday', '', '', '']);

const mocks = {
  'google-spreadsheet': {
    GoogleSpreadsheet: class {
      constructor() {}
      async loadInfo() {}
      get sheetsByTitle() { return state.sheets; }
      async addSheet({ title, headerValues }) { return makeSheet(title, headerValues); }
    },
  },
  'google-auth-library': { JWT: class {} },
  nodemailer: { createTransport: () => ({ sendMail: async (o) => { if (state.failMailTo && String(o.to).includes(state.failMailTo)) throw new Error('Simulated Zoho failure'); state.mail.push(o); } }) },
  stripe: () => ({
    paymentIntents: {
      create: async (args) => {
        const pi = { id: 'pi_test_' + (state.intents.length + 1), client_secret: 'cs_test_' + (state.intents.length + 1), amount: args.amount, metadata: args.metadata };
        state.intents.push({ args, pi });
        return pi;
      },
    },
    webhooks: { constructEvent: (body) => JSON.parse(body.toString()) },
  }),
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (mocks[request]) return mocks[request];
  return realLoad.call(this, request, ...rest);
};

// ---------- simulated postcodes.io and Slack ----------
const BIZ = { lat: 51.89025987316835, lng: 0.9175324384470639 };
const POSTCODES = {
  'CO1 1AA': { latitude: BIZ.lat + 0.005, longitude: BIZ.lng },   // ~0.3 miles
  'CO3 3AA': { latitude: BIZ.lat + 0.0435, longitude: BIZ.lng },  // ~3 miles
  'CO7 7AA': { latitude: BIZ.lat + 0.1, longitude: BIZ.lng },     // ~6.9 miles
  'NR1 1AA': { latitude: BIZ.lat + 0.5, longitude: BIZ.lng },     // ~34 miles
};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.postcodes.io/postcodes/')) {
    const pc = decodeURIComponent(u.split('/postcodes/')[1]);
    const hit = POSTCODES[pc];
    return hit ? { ok: true, status: 200, json: async () => ({ status: 200, result: hit }) } : { ok: false, status: 404, json: async () => ({}) };
  }
  if (u.startsWith('https://hooks.slack.test')) { state.slack.push(JSON.parse(opts.body).text); return { ok: true }; }
  return realFetch(url, opts);
};

process.env.PORT = '3199';
process.env.SHEET_ID = 'test'; process.env.GOOGLE_CLIENT_EMAIL = 'x@y.z'; process.env.GOOGLE_PRIVATE_KEY = 'k';
process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/x';
process.env.ZOHO_EMAIL = 'hello@dogoodpartybox.co.uk';
process.env.BLOCKED_CACHE_SECONDS = '0';

const server = require('../server.js');

// ---------- tests ----------
const BASE = 'http://localhost:3199';
let ipCounter = 0;
async function post(url, body, ip) {
  const r = await realFetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || ('10.0.0.' + (++ipCounter)) }, body: JSON.stringify(body) });
  let json = {}; try { json = await r.json(); } catch (e) {}
  return { status: r.status, json };
}
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); } else { fail++; console.log('FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}
const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toISOString().split('T')[0];
const base = (over) => Object.assign({ deliveryAddress: '', deliveryNotes: '',
  customerEmail: 'jane@example.com', firstName: 'Jane', lastName: 'Smith', partyDate: iso(20), guests: '20',
  postcode: 'CO1 1AA', phone: '07700 900123', colour: 'pastel', washing: 'rinse-yourself', delivery: 'collect',
  collectionDate: iso(19), collectionTime: 'morning', deliveryDate: '', deliveryTime: '', termsAccepted: true,
}, over);

(async () => {
  await new Promise(r => setTimeout(r, 500));

  console.log('\n--- Discount validation ---');
  let r = await post('/api/validate-discount', { code: 'SCHOOL10' });
  check('10% code gives £2.50 off', r.json.valid && r.json.discountAmount === 2.5, r);
  r = await post('/api/validate-discount', { code: ' school10 ' });
  check('codes are case-insensitive and trimmed', r.json.valid === true, r);
  r = await post('/api/validate-discount', { code: 'FIVEOFF' });
  check('fixed £5 code (typed as "£5") gives £5 off', r.json.valid && r.json.discountAmount === 5, r);
  for (const bad of ['EXPIRED', 'SWITCHEDOFF', 'USEDUP', 'FULLFAT', 'BADDATE', 'NOSUCHCODE']) {
    r = await post('/api/validate-discount', { code: bad });
    check(bad + ' is rejected', r.json.valid === false, r);
  }
  r = await post('/api/validate-discount', { code: 'HUGE' });
  check('£100 code is capped so the kit never goes below £1 (£24 off)', r.json.valid && r.json.discountAmount === 24, r);
  r = await post('/api/validate-discount', {});
  check('empty code gets a 400', r.status === 400, r);
  let limited = 0;
  for (let i = 0; i < 25; i++) { const x = await post('/api/validate-discount', { code: 'GUESS' + i }, '203.0.113.9'); if (x.status === 429) limited++; }
  check('guessing codes in bulk gets rate limited', limited >= 4, { limited });

  console.log('\n--- Payment intent: pricing is decided by the server ---');
  r = await post('/api/create-payment-intent', Object.assign(base({ washing: 'we-wash' }), { amount: 0.5, deliveryCost: 0 }));
  check('tampered amount (50p) is ignored: charges £30.00 (kit + washing)', r.status === 200 && state.intents.at(-1).args.amount === 3000 && r.json.total === 30, { status: r.status, amt: state.intents.at(-1) && state.intents.at(-1).args.amount });

  r = await post('/api/create-payment-intent', Object.assign(base({ washing: 'we-wash', delivery: 'we-deliver', deliveryAddress: '5 Test Street', postcode: 'CO3 3AA', deliveryDate: iso(19), deliveryTime: 'afternoon', collectionDate: '', collectionTime: '', discountCode: 'school10' }), { deliveryCost: 0 }));
  const md = state.intents.at(-1).args.metadata;
  check('10% off kit + washing £5 + 3-mile delivery £5 = £32.50, delivery cost worked out by the server',
    r.status === 200 && state.intents.at(-1).args.amount === 3250 && md.deliveryCost === 5 && md.discountCode === 'SCHOOL10' && md.discountAmount === '2.50', { status: r.status, md, amt: state.intents.at(-1).args.amount });
  const deliveredIntent = state.intents.at(-1).pi;

  r = await post('/api/create-payment-intent', base({ delivery: 'we-deliver', deliveryAddress: '5 Test Street', postcode: 'CO7 7AA', deliveryDate: iso(19), deliveryTime: 'morning', collectionDate: '', collectionTime: '' }));
  check('~7 mile delivery costs £10 (total £35)', r.status === 200 && state.intents.at(-1).args.amount === 3500, { status: r.status });

  const before = state.intents.length;
  r = await post('/api/create-payment-intent', base({ discountCode: 'EXPIRED' }));
  check('expired code at payment time: rejected, nothing charged, client told to drop the code', r.status === 400 && r.json.discountInvalid === true && state.intents.length === before, r);
  r = await post('/api/create-payment-intent', base({ delivery: 'we-deliver', deliveryAddress: '5 Test Street', postcode: 'NR1 1AA', deliveryDate: iso(19), deliveryTime: 'morning' }));
  check('postcode outside delivery area is rejected', r.status === 400 && /outside our delivery area/.test(r.json.error || ''), r);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(-2) }));
  check('past party date is rejected', r.status === 400, r);
  r = await post('/api/create-payment-intent', base({ firstName: '' }));
  check('missing details are rejected', r.status === 400, r);
  r = await post('/api/create-payment-intent', base({ delivery: 'collect', collectionDate: '' }));
  check('collection without a date is rejected', r.status === 400, r);
  r = await post('/api/create-payment-intent', base({ colour: '' }));
  check('blank colour is treated as no preference and still gets a kit', r.status === 200 && state.intents.at(-1).args.metadata.kit === 'pastel', r);

  console.log('\n--- Kit availability is re-checked and the right kit is assigned ---');
  const pd = new Date(Date.now() + 40 * 86400000); const ret = new Date(pd.getTime() + 3 * 86400000);
  state.sheets.Bookings.rows.push(['BK-1', 'Pastel', '', 'A', 'B', 'a@b.c', fmt(pd), fmt(pd), 'morning', '', '', fmt(ret), 'No', 'Collection', 'Confirmed', '0', 'Yes', '', '', 'pi_old']);
  const pdIso = pd.toISOString().split('T')[0], cdIso = new Date(pd.getTime() - 86400000).toISOString().split('T')[0];
  r = await post('/api/create-payment-intent', base({ partyDate: pdIso, collectionDate: cdIso, colour: 'pastel' }));
  check('pastel already booked: choosing pastel is refused (409)', r.status === 409, r);
  r = await post('/api/create-payment-intent', base({ partyDate: pdIso, collectionDate: cdIso, colour: 'no-preference' }));
  check('pastel booked + "no preference": assigned the BRIGHT kit (old code would have double-booked pastel)', r.status === 200 && r.json.kit === 'bright', r);
  const brightIntent = state.intents.at(-1).pi;
  r = await post('/api/create-payment-intent', base({ partyDate: pdIso, collectionDate: cdIso, colour: 'bright' }));
  check('bright is still available and can be chosen', r.status === 200 && r.json.kit === 'bright', r);

  console.log('\n--- Webhook ---');
  const event = (pi) => ({ type: 'payment_intent.succeeded', data: { object: pi } });
  const hook = (pi) => realFetch(BASE + '/api/stripe-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' }, body: JSON.stringify(event(pi)) });

  let res = await hook(deliveredIntent);
  const bookings = state.sheets.Bookings;
  const row = bookings.rows.find(x => x[bookings.headerValues.indexOf('Payment Intent ID')] === deliveredIntent.id);
  const col = (n) => row ? row[bookings.headerValues.indexOf(n)] : undefined;
  check('webhook saves the booking with discount code, amount and payment ID', res.status === 200 && row && col('Discount Code') === 'SCHOOL10' && col('Discount Amount (£)') === '2.50', { status: res.status, row });
  check('kit recorded from the server assignment', col('Pastel Booked') === 'Pastel' && col('Bright Booked') === '', row);
  const mail = state.mail.at(-1);
  check('receipt shows the discount line and the correct total', mail && /Discount \(SCHOOL10\): -£2\.50/.test(mail.text) && /Total paid: £32\.50/.test(mail.text) && /Discount \(SCHOOL10\)<\/td>/.test(mail.html) && /-£2\.50/.test(mail.html), mail && mail.text);
  const alertMsg = state.slack.find(t => /New booking/.test(t));
  check('new booking sends a Slack alert with name, dates and total', alertMsg && /Total paid: £32\.50/.test(alertMsg) && /Party date:/.test(alertMsg) && /Return by:/.test(alertMsg) && /SCHOOL10/.test(alertMsg), alertMsg);
  const alertMail = state.mail.find(m => /New booking/.test(m.subject || ''));
  check('new booking emails dogoodpartybox@gmail.com (not the customer inbox) with details', alertMail && alertMail.to === 'dogoodpartybox@gmail.com' && /Total paid: £32\.50/.test(alertMail.text) && /Return by:/.test(alertMail.text) && /@/.test(alertMail.text), alertMail);
  const used = disc.rows.find(x => x[0] === 'SCHOOL10')[6];
  check('discount "Times Used" goes up to 1 after a successful payment', used === '1', { used });

  const rowsBefore = bookings.rows.length, mailBefore = state.mail.length;
  res = await hook(deliveredIntent);
  check('same payment delivered twice: no duplicate row, no duplicate email, used count still 1', res.status === 200 && bookings.rows.length === rowsBefore && state.mail.length === mailBefore && disc.rows.find(x => x[0] === 'SCHOOL10')[6] === '1');

  res = await hook(brightIntent);
  const brow = bookings.rows.find(x => x[bookings.headerValues.indexOf('Payment Intent ID')] === brightIntent.id);
  check('no-preference booking records the BRIGHT kit', brow && brow[1] === '' && brow[2] === 'Bright', brow);
  const plain = state.mail.at(-1);
  check('receipt for a booking with no discount has no discount line', plain && !/Discount/.test(plain.text) && !/Discount/.test(plain.html));

  state.failBookingWrite = true;
  const retryIntent = state.intents.find(x => x.pi.metadata.firstName === 'Jane' && x.pi.metadata.colour === 'no-preference' && x.pi.id !== brightIntent.id).pi;
  const slackBefore = state.slack.length;
  res = await hook(retryIntent);
  check('sheet outage: webhook returns 500 so Stripe retries, and Slack is alerted', res.status === 500 && state.slack.length === slackBefore + 1 && /PAYMENT TAKEN BUT BOOKING NOT SAVED/.test(state.slack.at(-1)), { status: res.status, slack: state.slack.at(-1) });
  check('sheet outage: owners are emailed too', state.mail.some(m => m.to === 'dogoodpartybox@gmail.com' && /NOT SAVED/.test(m.subject || '')));
  state.failBookingWrite = false;
  res = await hook(retryIntent);
  check('Stripe retry after the outage saves the booking', res.status === 200 && bookings.rows.some(x => x[bookings.headerValues.indexOf('Payment Intent ID')] === retryIntent.id));

  console.log('\n--- Hire terms ---');
  let beforeT = state.intents.length;
  r = await post('/api/create-payment-intent', base({ termsAccepted: false }));
  check('terms not accepted: rejected, nothing charged', r.status === 400 && /hire terms/.test(r.json.error || '') && state.intents.length === beforeT, r);
  r = await post('/api/create-payment-intent', base({ termsAccepted: 'true' }));
  check('terms sent as a string rather than true: rejected', r.status === 400 && state.intents.length === beforeT, r);
  const noTerms = base({}); delete noTerms.termsAccepted;
  r = await post('/api/create-payment-intent', noTerms);
  check('terms missing altogether: rejected', r.status === 400 && state.intents.length === beforeT, r);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(30), collectionDate: iso(29) }));
  const tmd = state.intents.at(-1).args.metadata;
  check('acceptance, version and time are recorded in Stripe metadata', r.status === 200 && tmd.termsAccepted === 'yes' && tmd.termsVersion === '2026-10' && !isNaN(Date.parse(tmd.termsAcceptedAt)), tmd);
  const collectPi = state.intents.at(-1).pi;
  await hook(collectPi);
  const mCollect = state.mail.at(-1);
  check('collection receipt carries the terms summary, late fee, £1 charge and link', /hire terms in brief/i.test(mCollect.text) && /£5 per day/.test(mCollect.text) && /£1 per item/.test(mCollect.text) && /up to 1 day before your collection date/.test(mCollect.text) && /dogoodpartybox\.co\.uk\/#terms/.test(mCollect.text) && /\/#terms"[^>]*>Read the full hire terms/.test(mCollect.html), mCollect.text);
  check('collection receipt has the address, what3words and a Maps link (text and html)', /\/\/\/trace\.meal\.sling/.test(mCollect.text) && /what3words\.com\/trace\.meal\.sling/.test(mCollect.html) && /maps\.app\.goo\.gl\/6BJwnWAwNNY7HAVV9/.test(mCollect.text) && /maps\.app\.goo\.gl\/6BJwnWAwNNY7HAVV9/.test(mCollect.html) && /32 East Street/.test(mCollect.text), mCollect.text);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(50), delivery: 'we-deliver', deliveryAddress: '7 Test Road', deliveryNotes: 'Gate code 1234', postcode: 'CO1 1AA', deliveryDate: iso(49), deliveryTime: 'morning', collectionDate: '', collectionTime: '' }));
  check('delivery booking request accepted', r.status === 200, r);
  await hook(state.intents.at(-1).pi);
  const mDel = state.mail.at(-1);
  check('delivery receipt says "delivery date" and has the HTML terms list', /up to 1 day before your delivery date/.test(mDel.text) && /Hire terms in brief<\/h2>/.test(mDel.html), mDel.text);

  console.log('\n--- Marketing consent ---');
  const mcol = (rowArr, name) => rowArr[bookings.headerValues.indexOf(name)];
  r = await post('/api/create-payment-intent', base({ partyDate: iso(60), collectionDate: iso(59), marketingConsent: true }));
  const miYes = state.intents.at(-1);
  check('ticked: recorded as yes in Stripe metadata', r.status === 200 && miYes.args.metadata.marketingConsent === 'yes', miYes.args.metadata);
  await hook(miYes.pi);
  const yesRow = bookings.rows.find(x => mcol(x, 'Payment Intent ID') === miYes.pi.id);
  check('ticked: booking row says Marketing Consent = Yes', yesRow && mcol(yesRow, 'Marketing Consent') === 'Yes', yesRow);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(70), collectionDate: iso(69) }));
  const miNo = state.intents.at(-1);
  check('not ticked (field missing): recorded as no', r.status === 200 && miNo.args.metadata.marketingConsent === 'no', miNo.args.metadata);
  await hook(miNo.pi);
  const noRow = bookings.rows.find(x => mcol(x, 'Payment Intent ID') === miNo.pi.id);
  check('not ticked: booking row says Marketing Consent = No, and the booking still goes through', noRow && mcol(noRow, 'Marketing Consent') === 'No', noRow);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(80), collectionDate: iso(79), marketingConsent: 'yes' }));
  check('a non-boolean value is not treated as consent', state.intents.at(-1).args.metadata.marketingConsent === 'no', state.intents.at(-1).args.metadata);
  const enq = { partyDate: iso(5), firstName: 'Sam', lastName: 'Jones', guests: '15', postcode: 'CO1 1AA', email: 'sam@example.com', notes: '' };
  r = await post('/api/unavailable-enquiry', Object.assign({}, enq, { marketingConsent: true }));
  r = await post('/api/unavailable-enquiry', Object.assign({}, enq, { email: 'tom@example.com' }));
  const enqSheet = state.sheets['Unavailable Enquiries'];
  const ec = (row, n) => row[enqSheet.headerValues.indexOf(n)];
  check('enquiry with the box ticked is saved with Marketing Consent = Yes', enqSheet.rows.find(x => ec(x, 'Email') === 'sam@example.com') && ec(enqSheet.rows.find(x => ec(x, 'Email') === 'sam@example.com'), 'Marketing Consent') === 'Yes');
  check('enquiry without the box ticked is still accepted, saved as No', r.json.success === true && ec(enqSheet.rows.find(x => ec(x, 'Email') === 'tom@example.com'), 'Marketing Consent') === 'No', r);

  console.log('\n--- Blocked dates (holidays) ---');
  const avail = async (d) => (await (await realFetch(BASE + '/api/availability?partyDate=' + d)).json());
  const dmy = (d) => fmt(new Date(Date.now() + d * 86400000));
  let a = await avail(iso(120));
  check('no Blocked Dates tab yet: date is free and the tab is created with headers', a.pastelAvailable && a.brightAvailable && state.sheets['Blocked Dates'] && state.sheets['Blocked Dates'].headerValues.join() === 'From,To,Kit,Reason', a);
  const blk = state.sheets['Blocked Dates'];
  blk.rows.push([dmy(120), dmy(124), '', 'Holiday']);
  a = await avail(iso(122));
  check('party date inside a holiday: both kits closed, "fully booked" message', !a.pastelAvailable && !a.brightAvailable && /fully booked/.test(a.message), a);
  a = await avail(iso(117));
  check('party 3 days before the holiday (kit would still be out): closed', !a.pastelAvailable && !a.brightAvailable, a);
  a = await avail(iso(116));
  check('party 4 days before the holiday: free', a.pastelAvailable && a.brightAvailable, a);
  a = await avail(iso(126));
  check('party 2 days after the holiday (collection would fall in it): closed', !a.pastelAvailable && !a.brightAvailable, a);
  a = await avail(iso(127));
  check('party 3 days after the holiday: free', a.pastelAvailable && a.brightAvailable, a);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(122), collectionDate: iso(121), colour: 'no-preference' }));
  check('trying to pay for a holiday date is refused (409), nothing charged', r.status === 409, r);
  blk.rows.length = 0;
  blk.rows.push([dmy(140), '', 'Pastel', 'Pastel kit at the school fair']);
  a = await avail(iso(140));
  check('one-day closure with To left blank, pastel only: pastel closed, bright still open', !a.pastelAvailable && a.brightAvailable, a);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(140), collectionDate: iso(139), colour: 'no-preference' }));
  check('"no preference" on that date is given the bright kit', r.status === 200 && r.json.kit === 'bright', r);
  blk.rows.length = 0;
  blk.rows.push(['not a date', '', '', 'typo'], ['', '', '', 'blank row'], [dmy(160), dmy(158), '', 'To before From']);
  a = await avail(iso(160));
  check('unreadable or back-to-front rows are ignored rather than blocking everything', a.pastelAvailable && a.brightAvailable, a);
  blk.rows.length = 0; blk.rows.push([dmy(180), dmy(181), 'Both', '']);
  a = await avail(iso(180));
  check('"Both" closes both kits', !a.pastelAvailable && !a.brightAvailable, a);
  blk.rows.length = 0;
  a = await avail(iso(180));
  check('deleting the row reopens the date straight away', a.pastelAvailable && a.brightAvailable, a);


  console.log('\n--- Phone number and delivery address ---');
  const nPI = state.intents.length;
  r = await post('/api/create-payment-intent', base({ phone: '' }));
  check('missing phone number is rejected, nothing charged', r.status === 400 && /phone/i.test(r.json.error || '') && state.intents.length === nPI, r);
  r = await post('/api/create-payment-intent', base({ phone: '12345' }));
  check('too-short phone number is rejected', r.status === 400, r);
  r = await post('/api/create-payment-intent', base({ phone: 'call me maybe' }));
  check('phone number with letters is rejected', r.status === 400, r);
  r = await post('/api/create-payment-intent', base({ phone: '+44 7700 900123', partyDate: iso(300), collectionDate: iso(299) }));
  check('+44 phone number is accepted', r.status === 200, r);
  r = await post('/api/create-payment-intent', base({ delivery: 'we-deliver', postcode: 'CO1 1AA', deliveryDate: iso(19), deliveryTime: 'morning', collectionDate: '', collectionTime: '', deliveryAddress: '' }));
  check('delivery without an address is rejected', r.status === 400 && /address/i.test(r.json.error || ''), r);
  r = await post('/api/create-payment-intent', base({ delivery: 'collect', deliveryAddress: 'Should be ignored', partyDate: iso(310), collectionDate: iso(309) }));
  check('collection bookings do not keep a delivery address', r.status === 200 && state.intents.at(-1).args.metadata.deliveryAddress === '', state.intents.at(-1).args.metadata);

  console.log('\n--- New Bookings columns are added at the far right, by the server ---');
  check('original 21 columns are untouched and in the same order', BOOKING_HEADERS.every((h, i) => bookings.headerValues[i] === h), bookings.headerValues);
  check('Phone, Guests, address and reminder columns were added after them', bookings.headerValues.slice(21).join('|') === 'Phone|Guests|Delivery Address|Delivery Notes|Pre-party Reminder Sent|Return Reminder Sent|Feedback Request Sent|Cancellation Email Sent', bookings.headerValues.slice(21));
  check('the header row was written only once, not for every booking', state.headerWrites === 1, { writes: state.headerWrites });
  const delRow = bookings.rows.find(x => mcol(x, 'Delivery Address') === '7 Test Road');
  check('delivery booking row has phone, guests, address and notes', delRow && mcol(delRow, 'Phone') === '07700 900123' && mcol(delRow, 'Guests') === '20' && mcol(delRow, 'Delivery Notes') === 'Gate code 1234', delRow);

  console.log('\n--- Confirmation email content ---');
  check('confirmation subject is clean (no dash) and is the same for every booking', mDel.subject === 'Your Do Good Party Box booking is confirmed' && mCollect.subject === mDel.subject, mDel.subject);
  check('confirmation shows weekday dates, kit and guest count', /Party date: \w+day \d{1,2} \w+ \d{4}/.test(mCollect.text) && /Your kit: Pastel kit, for 20 guests/.test(mCollect.text), mCollect.text);
  check('confirmation lists what is in the box, including the stack of serving bowls', /A stack of serving bowls/.test(mCollect.text) && /place setting for each of your 20 guests/.test(mCollect.text) && /3 jugs and 3 trays/.test(mCollect.text));
  check('confirmation tells them how to cancel and where to return the kit', /Need to cancel\? Just reply to this email/.test(mCollect.text) && /bring everything back to the same address by/.test(mCollect.text));
  check('washing is described with the word wash, never rinse', /Washing: You wash it/.test(mCollect.text) && !/rinse/i.test(mCollect.text.replace(/not just a rinse/gi, '')));
  check('delivery confirmation shows the address and phone, and says when we will be in touch', /Delivering to: 7 Test Road, CO1 1AA/.test(mDel.text) && /Your phone number: 07700 900123/.test(mDel.text) && /email you the day before/.test(mDel.text), mDel.text);
  check('HTML version has the logo, a preheader and the same what3words', /email-logo\.png/.test(mCollect.html) && /display:none/.test(mCollect.html) && /trace\.meal\.sling/.test(mCollect.html));
  const noDash = [mCollect.text, mDel.text].every(t => !/[–—]/.test(t));
  check('no dashes of the em or en kind in the customer emails', noDash);
  r = await post('/api/create-payment-intent', base({ firstName: '<b>Eve</b>', partyDate: iso(90), collectionDate: iso(89) }));
  await hook(state.intents.at(-1).pi);
  const mXss = state.mail.at(-1);
  check('names are escaped in the HTML email', /&lt;b&gt;Eve&lt;\/b&gt;/.test(mXss.html) && !/<b>Eve<\/b>/.test(mXss.html), mXss.html.slice(0, 0));

  console.log('\n--- Alerts to the owners ---');
  const dAlert = state.mail.find(m => /New booking: Jane Smith/.test(m.subject || '') && /7 Test Road/.test(m.text));
  check('delivery booking alert has phone, address, notes, booking ID and replies go to the customer', dAlert && /Phone: 07700 900123/.test(dAlert.text) && /Deliver to: 7 Test Road, CO1 1AA/.test(dAlert.text) && /Gate code 1234/.test(dAlert.text) && /Booking ID: BK-\d+/.test(dAlert.text) && dAlert.replyTo === 'jane@example.com', dAlert);

  console.log('\n--- Date enquiries now email us instantly ---');
  const enqMail = state.mail.find(m => /Date enquiry: Sam Jones/.test(m.subject || ''));
  check('enquiry emails dogoodpartybox@gmail.com with all the details and replies go to the customer', enqMail && enqMail.to === 'dogoodpartybox@gmail.com' && enqMail.replyTo === 'sam@example.com' && /Guests: 15/.test(enqMail.text) && /Postcode: CO1 1AA/.test(enqMail.text) && /OK to email about offers: Yes/.test(enqMail.text), enqMail);
  check('enquiry alert is also posted to Slack', state.slack.some(t => /Date enquiry: Sam Jones/.test(t)));
  const digestGone = await realFetch(BASE + '/health');
  check('server still healthy with the old daily digest removed', digestGone.status === 200);

  console.log('\n--- Daily emails: reminders and feedback ---');
  const ukDay = (n) => { const d = new Date(Date.now() + n * 86400000); const [y, m, dd] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-'); return dd + '/' + m + '/' + y; };
  const H = bookings.headerValues;
  const mk = (o) => { const raw = []; const d = Object.assign({ 'Booking ID': 'BK-1000', 'Pastel Booked': 'Pastel', 'First Name': 'Rem', 'Last Name': 'Inder', 'Customer Email': 'rem@example.com', 'Status (Confirmed/Pending/Cancelled)': 'Confirmed', 'Delivery Method (Collect/Deliver)': 'Collection', 'Washing Service (Y/N)': 'No', 'Guests': '12', 'Phone': '07700900000' }, o); for (const k in d) raw[H.indexOf(k)] = d[k]; bookings.rows.push(raw); return raw; };
  const startRows = bookings.rows.length;
  const rPartySoon = mk({ 'Customer Email': 'soon@example.com', 'Party Date': ukDay(3), 'Collection Date': ukDay(2), 'Collection Time': 'morning', 'Expected Return Date': ukDay(6) });
  const rJustBooked = mk({ 'Customer Email': 'just@example.com', 'Booking ID': 'BK-' + (Date.now() - 3600000), 'Party Date': ukDay(2), 'Collection Date': ukDay(1), 'Collection Time': 'morning', 'Expected Return Date': ukDay(5) });
  const rFar = mk({ 'Customer Email': 'far@example.com', 'Party Date': ukDay(10), 'Collection Date': ukDay(9), 'Collection Time': 'morning', 'Expected Return Date': ukDay(13) });
  const rCancelled = mk({ 'Customer Email': 'cancelled@example.com', 'Status (Confirmed/Pending/Cancelled)': 'Cancelled', 'Party Date': ukDay(3), 'Collection Date': ukDay(2), 'Collection Time': 'morning', 'Expected Return Date': ukDay(6) });
  const rDeliverSoon = mk({ 'Customer Email': 'dsoon@example.com', 'Delivery Method (Collect/Deliver)': 'Delivery', 'Party Date': ukDay(2), 'Delivery Date': ukDay(1), 'Delivery Time': 'afternoon', 'Delivery Address': '9 Delivery Lane', 'Expected Return Date': ukDay(5) });
  const rReturn = mk({ 'Customer Email': 'ret@example.com', 'Washing Service (Y/N)': 'Yes', 'Party Date': ukDay(-2), 'Collection Date': ukDay(-3), 'Collection Time': 'morning', 'Expected Return Date': ukDay(1) });
  const rReturnDel = mk({ 'Customer Email': 'retdel@example.com', 'Delivery Method (Collect/Deliver)': 'Delivery', 'Party Date': ukDay(-2), 'Delivery Date': ukDay(-3), 'Delivery Time': 'morning', 'Expected Return Date': ukDay(1) });
  const rFeedback = mk({ 'Customer Email': 'fb@example.com', 'Party Date': ukDay(-7), 'Collection Date': ukDay(-8), 'Collection Time': 'morning', 'Expected Return Date': ukDay(-4) });
  const rOld = mk({ 'Customer Email': 'old@example.com', 'Party Date': ukDay(-40), 'Collection Date': ukDay(-41), 'Collection Time': 'morning', 'Expected Return Date': ukDay(-37) });
  const rDone = mk({ 'Customer Email': 'done@example.com', 'Party Date': ukDay(-7), 'Collection Date': ukDay(-8), 'Collection Time': 'morning', 'Expected Return Date': ukDay(-4), 'Feedback Request Sent': '01/01/2026', 'Return Reminder Sent': '01/01/2026', 'Pre-party Reminder Sent': '01/01/2026' });
  const mailBeforeDaily = state.mail.length;
  const out = await server.runDailyEmails(new Date());
  const sent = (to) => state.mail.slice(mailBeforeDaily).filter(m => m.to === to);
  check('daily run reports what it sent', out.partyReminders === 2 && out.returnReminders === 2 && out.feedbackRequests === 1, out);
  check('collection due in 2 days: party reminder with the date, window and what3words', sent('soon@example.com').length === 1 && /Nearly party time, Rem/.test(sent('soon@example.com')[0].text) && /trace\.meal\.sling/.test(sent('soon@example.com')[0].text) && /Morning/.test(sent('soon@example.com')[0].text), sent('soon@example.com'));
  check('reminder is flagged in the sheet so it is not sent twice', /\d{2}\/\d{2}\/\d{4}/.test(mcol(rPartySoon, 'Pre-party Reminder Sent')), rPartySoon);
  check('booking made an hour ago is not reminded yet', sent('just@example.com').length === 0);
  check('date more than 2 days away: no reminder', sent('far@example.com').length === 0);
  check('cancelled booking gets nothing', sent('cancelled@example.com').length === 0);
  check('delivery tomorrow: reminder shows the delivery address and phone', sent('dsoon@example.com').length === 1 && /9 Delivery Lane/.test(sent('dsoon@example.com')[0].text) && /afternoon/i.test(sent('dsoon@example.com')[0].text), sent('dsoon@example.com'));
  check('return tomorrow (we wash): reminder says no need to wash, mentions the late fee', sent('ret@example.com').length === 1 && /no need to wash/.test(sent('ret@example.com')[0].text) && /£5 per day/.test(sent('ret@example.com')[0].text) && /due back tomorrow/i.test(sent('ret@example.com')[0].subject), sent('ret@example.com'));
  check('return tomorrow (delivery): says we are collecting', sent('retdel@example.com').length === 1 && /collecting your party kit tomorrow/.test(sent('retdel@example.com')[0].subject), sent('retdel@example.com'));
  check('feedback request goes out 2 days after the return date and invites a reply', sent('fb@example.com').length === 1 && /How did it go, Rem/.test(sent('fb@example.com')[0].text) && /reply to this email/i.test(sent('fb@example.com')[0].text), sent('fb@example.com'));
  check('return date long past: no feedback email', sent('old@example.com').length === 0);
  check('everything already flagged: nothing sent', sent('done@example.com').length === 0);
  const again = await server.runDailyEmails(new Date());
  check('running the daily job again sends nothing new', again.partyReminders === 0 && again.returnReminders === 0 && again.feedbackRequests === 0, again);
  check('reminder emails have a text and an HTML version', sent('soon@example.com')[0].html && sent('soon@example.com')[0].text);
  check('reminders contain no em or en dashes', state.mail.slice(mailBeforeDaily).every(m => !/[–—]/.test(m.text)));
  const rFail = mk({ 'Customer Email': 'bounce@example.com', 'Party Date': ukDay(3), 'Collection Date': ukDay(2), 'Collection Time': 'morning', 'Expected Return Date': ukDay(6) });
  state.failMailTo = 'bounce@example.com';
  const failAlerts = state.mail.length;
  const failOut = await server.runDailyEmails(new Date());
  state.failMailTo = '';
  check('a failed reminder is not marked as sent and the owners are told', failOut.partyReminders === 0 && !mcol(rFail, 'Pre-party Reminder Sent') && state.mail.slice(failAlerts).some(m => m.to === 'dogoodpartybox@gmail.com' && /Party reminder FAILED/.test(m.subject)), failOut);
  const retryOut = await server.runDailyEmails(new Date());
  check('it tries again on the next run', retryOut.partyReminders === 1 && !!mcol(rFail, 'Pre-party Reminder Sent'), retryOut);

  console.log('\n--- Refunds: cancellation email ---');
  const refundHook = (charge) => realFetch(BASE + '/api/stripe-webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'sig' }, body: JSON.stringify({ type: 'charge.refunded', data: { object: charge } }) });
  const cancelRow = bookings.rows.find(x => mcol(x, 'Payment Intent ID') === collectPi.id);
  const cancelBefore = state.mail.length;
  res = await refundHook({ payment_intent: collectPi.id, amount: collectPi.amount, amount_refunded: collectPi.amount, refunded: true });
  const cMail = state.mail.slice(cancelBefore).find(m => m.to === 'jane@example.com');
  check('full refund marks the booking Cancelled', res.status === 200 && mcol(cancelRow, 'Status (Confirmed/Pending/Cancelled)') === 'Cancelled', cancelRow);
  check('full refund emails the customer with the refund amount', cMail && /cancelled/.test(cMail.subject) && new RegExp('refunded £' + (collectPi.amount / 100).toFixed(2).replace(/\.00$/, '').replace('.', '\\.')).test(cMail.text), cMail && cMail.text);
  check('the owners are told too', state.mail.slice(cancelBefore).some(m => m.to === 'dogoodpartybox@gmail.com' && /Booking cancelled/.test(m.subject)));
  const cancelAfter = state.mail.length;
  await refundHook({ payment_intent: collectPi.id, amount: collectPi.amount, amount_refunded: collectPi.amount, refunded: true });
  check('same refund event delivered again: no second email', state.mail.length === cancelAfter);
  const partialBefore = state.mail.length;
  const partialRow = bookings.rows.find(x => mcol(x, 'Payment Intent ID') === miYes.pi.id);
  await refundHook({ payment_intent: miYes.pi.id, amount: miYes.pi.amount, amount_refunded: 100, refunded: false });
  check('partial refund: booking stays Confirmed and the customer is not emailed, owners are', mcol(partialRow, 'Status (Confirmed/Pending/Cancelled)') === 'Confirmed' && !state.mail.slice(partialBefore).some(m => m.to === 'jane@example.com') && state.mail.slice(partialBefore).some(m => /Partial refund/.test(m.subject)));
  res = await refundHook({ payment_intent: 'pi_unknown', amount: 100, amount_refunded: 100, refunded: true });
  check('refund for a payment with no booking is ignored without an error', res.status === 200);

  console.log('\n--- Housekeeping ---');
  const dbg = await realFetch(BASE + '/api/debug');
  check('/api/debug no longer exposes bookings (404)', dbg.status === 404, { status: dbg.status });
  const noHeader = state.sheets['Discount Codes'];
  check('Discount Codes tab exists with the expected headers', JSON.stringify(noHeader.headerValues) === JSON.stringify(['Code', 'Type', 'Value', 'Active', 'Expires', 'Max Uses', 'Times Used', 'Notes']));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
