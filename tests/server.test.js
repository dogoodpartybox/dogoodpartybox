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
    title, headerValues: headers.slice(), rows: [],
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
  nodemailer: { createTransport: () => ({ sendMail: async (o) => { state.mail.push(o); } }) },
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

require('../server.js');

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
const base = (over) => Object.assign({
  customerEmail: 'jane@example.com', firstName: 'Jane', lastName: 'Smith', partyDate: iso(20), guests: '20',
  postcode: 'CO1 1AA', colour: 'pastel', washing: 'rinse-yourself', delivery: 'collect',
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

  r = await post('/api/create-payment-intent', Object.assign(base({ washing: 'we-wash', delivery: 'we-deliver', postcode: 'CO3 3AA', deliveryDate: iso(19), deliveryTime: 'afternoon', collectionDate: '', collectionTime: '', discountCode: 'school10' }), { deliveryCost: 0 }));
  const md = state.intents.at(-1).args.metadata;
  check('10% off kit + washing £5 + 3-mile delivery £5 = £32.50, delivery cost worked out by the server',
    r.status === 200 && state.intents.at(-1).args.amount === 3250 && md.deliveryCost === 5 && md.discountCode === 'SCHOOL10' && md.discountAmount === '2.50', { status: r.status, md, amt: state.intents.at(-1).args.amount });
  const deliveredIntent = state.intents.at(-1).pi;

  r = await post('/api/create-payment-intent', base({ delivery: 'we-deliver', postcode: 'CO7 7AA', deliveryDate: iso(19), deliveryTime: 'morning', collectionDate: '', collectionTime: '' }));
  check('~7 mile delivery costs £10 (total £35)', r.status === 200 && state.intents.at(-1).args.amount === 3500, { status: r.status });

  const before = state.intents.length;
  r = await post('/api/create-payment-intent', base({ discountCode: 'EXPIRED' }));
  check('expired code at payment time: rejected, nothing charged, client told to drop the code', r.status === 400 && r.json.discountInvalid === true && state.intents.length === before, r);
  r = await post('/api/create-payment-intent', base({ delivery: 'we-deliver', postcode: 'NR1 1AA', deliveryDate: iso(19), deliveryTime: 'morning' }));
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
  check('receipt shows the discount line and the correct total', mail && /Discount \(SCHOOL10\): -£2\.50/.test(mail.text) && /Total: £32\.50/.test(mail.text) && /<li>Discount \(SCHOOL10\): -£2\.50<\/li>/.test(mail.html), mail && mail.text);
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
  check('collection receipt carries the terms summary, late fee, £1 charge and link', /Hire terms in brief/.test(mCollect.text) && /£5 per day/.test(mCollect.text) && /£1 per item/.test(mCollect.text) && /up to 1 day before your collection date/.test(mCollect.text) && /dogoodpartybox\.co\.uk\/#terms/.test(mCollect.text) && /\/#terms">Read the full hire terms/.test(mCollect.html), mCollect.text);
  check('collection receipt has the address, what3words and a Maps link (text and html)', /\/\/\/trace\.meal\.sling/.test(mCollect.text) && /what3words\.com\/trace\.meal\.sling/.test(mCollect.html) && /maps\.app\.goo\.gl\/6BJwnWAwNNY7HAVV9/.test(mCollect.text) && /maps\.app\.goo\.gl\/6BJwnWAwNNY7HAVV9/.test(mCollect.html) && /32 East Street/.test(mCollect.text), mCollect.text);
  r = await post('/api/create-payment-intent', base({ partyDate: iso(50), delivery: 'we-deliver', postcode: 'CO1 1AA', deliveryDate: iso(49), deliveryTime: 'morning', collectionDate: '', collectionTime: '' }));
  check('delivery booking request accepted', r.status === 200, r);
  await hook(state.intents.at(-1).pi);
  const mDel = state.mail.at(-1);
  check('delivery receipt says "delivery date" and has the HTML terms list', /up to 1 day before your delivery date/.test(mDel.text) && /<h3>Hire terms in brief<\/h3>/.test(mDel.html), mDel.text);

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

  console.log('\n--- Housekeeping ---');
  const dbg = await realFetch(BASE + '/api/debug');
  check('/api/debug no longer exposes bookings (404)', dbg.status === 404, { status: dbg.status });
  const noHeader = state.sheets['Discount Codes'];
  check('Discount Codes tab exists with the expected headers', JSON.stringify(noHeader.headerValues) === JSON.stringify(['Code', 'Type', 'Value', 'Active', 'Expires', 'Max Uses', 'Times Used', 'Notes']));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
