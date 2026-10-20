// Customer emails for Do Good Party Box.
// Every email is written once as a list of simple blocks and turned into both a plain text version and a
// branded HTML version, so the two always say the same thing. Prices, terms and addresses come from server.js.
'use strict';

const SITE_URL = 'https://dogoodpartybox.co.uk';
const LOGO_URL = SITE_URL + '/email-logo.png';

const C = {
  dark: '#2D3E31',
  primary: '#2F8B6E',
  cream: '#F5F1E8',
  sand: '#E9E0CB',
  white: '#FFFFFF',
  muted: '#5E6B61'
};
const HEADING_FONT = "'Fredoka', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif";
const BODY_FONT = "'Work Sans', 'Segoe UI', Helvetica, Arial, sans-serif";

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Accepts YYYY-MM-DD or DD/MM/YYYY and returns a UTC date (so the day never shifts with the server's time zone)
function parseDay(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

// "Saturday 28 November 2026"
function longDate(value) {
  const d = parseDay(value);
  if (!d) return String(value || '');
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(d).replace(/,/g, '');
}

function windowLabel(code) {
  const map = {
    morning: 'Morning (8am to 12pm)',
    afternoon: 'Afternoon (12pm to 5pm)',
    evening: 'Evening (5pm to 8pm)'
  };
  return map[code] || code || '';
}

function money(n) {
  return '£' + (Number(n) || 0).toFixed(2).replace(/\.00$/, '');
}

function kitLabel(kit) {
  if (kit === 'bright') return 'Bright';
  if (kit === 'pastel') return 'Pastel';
  return '';
}

// ---------- inline text: **bold** and [label](https://link) ----------
function inlineHtml(text) {
  return esc(text)
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
      `<a href="$2" style="color:${C.primary};font-weight:bold;text-decoration:underline;">$1</a>`);
}
function inlineText(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, '$1 ($2)');
}

// ---------- block renderers ----------
const html = {
  p: (b) => `<p style="margin:0 0 16px;font-family:${BODY_FONT};font-size:16px;line-height:1.6;color:${C.dark};">${inlineHtml(b.text)}</p>`,
  small: (b) => `<p style="margin:0 0 14px;font-family:${BODY_FONT};font-size:13px;line-height:1.5;color:${C.muted};">${inlineHtml(b.text)}</p>`,
  h2: (b) => `<h2 style="margin:28px 0 10px;font-family:${HEADING_FONT};font-size:13px;letter-spacing:1.5px;text-transform:uppercase;color:${C.primary};">${esc(b.text)}</h2>`,
  card: (b) => {
    const rows = b.rows.map(([label, value]) => `<tr><td valign="top" style="padding:6px 12px 6px 0;font-family:${BODY_FONT};font-size:14px;color:${C.muted};width:38%;">${esc(label)}</td><td valign="top" style="padding:6px 0;font-family:${BODY_FONT};font-size:15px;color:${C.dark};font-weight:bold;">${inlineHtml(value)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;background:${C.cream};border-left:4px solid ${C.primary};border-radius:10px;"><tr><td style="padding:14px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`;
  },
  lines: (b) => {
    const rows = b.rows.map(([label, amount, strong]) => `<tr><td style="padding:5px 0;font-family:${BODY_FONT};font-size:15px;color:${C.dark};${strong ? 'font-weight:bold;border-top:1px solid ' + C.sand + ';padding-top:10px;' : ''}">${esc(label)}</td><td align="right" style="padding:5px 0;font-family:${BODY_FONT};font-size:15px;color:${C.dark};${strong ? 'font-weight:bold;border-top:1px solid ' + C.sand + ';padding-top:10px;' : ''}">${esc(amount)}</td></tr>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;">${rows}</table>`;
  },
  list: (b) => `<ul style="margin:0 0 16px;padding-left:22px;font-family:${BODY_FONT};font-size:15px;line-height:1.6;color:${C.dark};">${b.items.map(i => `<li style="margin:0 0 6px;">${inlineHtml(i)}</li>`).join('')}</ul>`,
  button: (b) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 14px;"><tr><td align="center" bgcolor="${b.secondary ? C.dark : C.primary}" style="border-radius:999px;"><a href="${esc(b.url)}" style="display:inline-block;padding:13px 26px;font-family:${HEADING_FONT};font-size:16px;font-weight:bold;color:${C.white};text-decoration:none;border-radius:999px;">${esc(b.label)}</a></td></tr></table>`,
  w3w: (b) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td align="center" style="background:${C.dark};border-radius:12px;padding:16px;"><div style="font-family:${BODY_FONT};font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#BFD9CE;">what3words</div><a href="${esc(b.url)}" style="font-family:${HEADING_FONT};font-size:26px;font-weight:bold;color:${C.white};text-decoration:none;">${esc(b.text)}</a></td></tr></table>`,
  steps: (b) => {
    const cells = b.items.map(([icon, label]) => `<td align="center" valign="top" width="${Math.floor(100 / b.items.length)}%" style="padding:0 4px;"><div style="width:48px;height:48px;line-height:48px;border-radius:24px;background:${C.cream};font-size:22px;text-align:center;margin:0 auto 6px;">${icon}</div><div style="font-family:${HEADING_FONT};font-size:14px;font-weight:bold;color:${C.dark};">${esc(label)}</div></td>`).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;"><tr>${cells}</tr></table>`;
  }
};

const text = {
  p: (b) => inlineText(b.text) + '\n',
  small: (b) => inlineText(b.text) + '\n',
  h2: (b) => b.text.toUpperCase() + '\n',
  card: (b) => b.rows.map(([l, v]) => `${l}: ${inlineText(v)}`).join('\n') + '\n',
  lines: (b) => b.rows.map(([l, a]) => `${l}: ${a}`).join('\n') + '\n',
  list: (b) => b.items.map(i => '- ' + inlineText(i)).join('\n') + '\n',
  button: (b) => `${b.label}: ${b.url}\n`,
  w3w: (b) => `what3words: ${b.text} (${b.url})\n`,
  steps: (b) => b.items.map(([, l], i) => `${i + 1}. ${l}`).join('   ') + '\n'
};

function create(config) {
  const contact = config.contactEmail || 'hello@dogoodpartybox.co.uk';

  function render({ subject, preheader, heading, blocks }) {
    const body = blocks.map(b => html[b.type](b)).join('\n');
    const htmlOut = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600&family=Work+Sans:wght@400;600&display=swap" rel="stylesheet">
</head>
<body style="margin:0;padding:0;background:${C.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.cream};">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.cream};">
<tr><td align="center" style="padding:20px 10px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
    <tr><td align="center" bgcolor="${C.dark}" style="background:${C.dark};border-radius:16px 16px 0 0;padding:26px 20px 22px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${C.cream}" style="background:${C.cream};border-radius:18px;padding:12px 16px;"><img src="${LOGO_URL}" width="150" alt="Do Good Party Box" style="display:block;border:0;height:auto;"></td></tr></table>
      <div style="padding-top:14px;font-family:${HEADING_FONT};font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#BFD9CE;">Do better, Do Good</div>
    </td></tr>
    <tr><td bgcolor="${C.white}" style="background:${C.white};padding:30px 28px 18px;border-radius:0 0 16px 16px;">
      <h1 style="margin:0 0 18px;font-family:${HEADING_FONT};font-size:28px;line-height:1.25;color:${C.dark};">${esc(heading)}</h1>
      ${body}
    </td></tr>
    <tr><td align="center" style="padding:18px 10px 6px;font-family:${BODY_FONT};font-size:12px;line-height:1.6;color:${C.muted};">
      Do Good Party Box, reusable kids' party kit hire in Colchester, Essex<br>
      <a href="mailto:${contact}" style="color:${C.muted};">${contact}</a> | <a href="${SITE_URL}" style="color:${C.muted};">dogoodpartybox.co.uk</a><br>
      <a href="${SITE_URL}/#terms" style="color:${C.muted};">Hire terms</a> (version ${esc(config.termsVersion)})
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

    const textOut = [
      heading, '',
      ...blocks.map(b => text[b.type](b)),
      'Do better, Do Good.', '',
      `${contact} | ${SITE_URL}`
    ].join('\n').replace(/\n{3,}/g, '\n\n');

    return { subject, text: textOut, html: htmlOut };
  }

  // Wording must match the Hire terms pop-up in index.html. If you change it, bump TERMS_VERSION in server.js.
  function termsBlocks(handoverWord) {
    return [
      { type: 'h2', text: 'Hire terms in brief' },
      {
        type: 'list', items: [
          `You have one day's grace after the return date. After that a late fee of £${config.lateFee} per day applies.`,
          `Lost or broken plates, bowls, cups and cutlery are charged at £${config.replacementCharge} per item.`,
          `You can cancel for a full refund up to 1 day before your ${handoverWord} date. After that the full booking amount is kept.`
        ]
      },
      { type: 'button', label: 'Read the full hire terms', url: `${SITE_URL}/#terms`, secondary: true }
    ];
  }

  function boxContents(guests) {
    const settings = guests
      ? `A place setting for each of your ${guests} guests (a plate, bowl, cup, knife, fork and spoon)`
      : 'A place setting for each of your guests (a plate, bowl, cup, knife, fork and spoon)';
    return [
      { type: 'h2', text: "What's in your box" },
      {
        type: 'list', items: [
          settings,
          '3 jugs and 3 trays',
          'A stack of serving bowls',
          'A wipe-clean tablecloth'
        ]
      },
      { type: 'small', text: "There's a checklist in the box. Please check everything off when you get it and tell us straight away if anything is missing." }
    ];
  }

  function cycleSteps(d) {
    const first = d.delivery === 'we-deliver' ? ['📦', 'We deliver'] : ['📦', 'Collect'];
    const third = d.washing === 'we-wash' ? ['🧺', 'Hand it back dirty'] : ['🧼', 'Wash it'];
    return { type: 'steps', items: [first, ['🎉', 'Party!'], third, ['♻️', d.delivery === 'we-deliver' ? 'We collect' : 'Return']] };
  }

  function washingLine(d) {
    return d.washing === 'we-wash'
      ? `We wash it (${money(config.washingPrice)})`
      : 'You wash it (free). Soap and water, then dry';
  }

  function handoverBlocks(d) {
    if (d.delivery === 'collect') {
      return [
        { type: 'h2', text: 'Collecting your kit' },
        { type: 'p', text: `Pop in on **${longDate(d.handoverDate)}**, ${windowLabel(d.handoverWindow)}.` },
        { type: 'w3w', text: config.w3w, url: config.w3wUrl },
        { type: 'p', text: `The what3words address takes you to the exact spot, so we suggest using it. The address is ${config.collectionAddress}. Look for the black gate with the yellow number 32. The door is at the end of the path.` },
        { type: 'button', label: 'Open the pin in Google Maps', url: config.mapsUrl }
      ];
    }
    return [
      { type: 'h2', text: 'Your delivery' },
      { type: 'p', text: `We'll bring your kit on **${longDate(d.handoverDate)}**, ${windowLabel(d.handoverWindow)}.` },
      {
        type: 'card', rows: [
          ['Delivering to', [d.deliveryAddress, d.postcode].filter(Boolean).join(', ')],
          ['Your phone number', d.phone || 'Not given']
        ]
      },
      { type: 'p', text: "We'll email you the day before to confirm your time, and we'll call or text on the day if we are running early or late. If the address or number above is wrong, just reply to this email." }
    ];
  }

  function returnBlocks(d) {
    if (d.delivery === 'collect') {
      return [{ type: 'p', text: `Please bring everything back to the same address by **${longDate(d.returnDate)}**. Running late or need to change plans? Reply to this email and let us know.` }];
    }
    return [{ type: 'p', text: `We'll collect the kit from you on **${longDate(d.returnDate)}**. Please have everything packed back in the box and ready to go. If you need a different day, reply to this email.` }];
  }

  // ---------- 1. Booking confirmation ----------
  function bookingConfirmation(d) {
    const handoverLabel = d.delivery === 'collect' ? 'Collection' : 'Delivery';
    const kitRow = [kitLabel(d.kit) ? `${kitLabel(d.kit)} kit` : 'Party kit', d.guests ? `for ${d.guests} guests` : ''];
    const detailRows = [
      ['Party date', longDate(d.partyDate)],
      ['Your kit', `${kitRow[0]}${kitRow[1] ? ', ' + kitRow[1] : ''}`],
      [handoverLabel, `${longDate(d.handoverDate)}, ${windowLabel(d.handoverWindow)}`],
      ['Return by', longDate(d.returnDate)],
      ['Washing', washingLine(d)]
    ];
    const lines = [['Party kit', money(config.kitPrice)]];
    if (d.discountAmount > 0) lines.push([`Discount (${d.discountCode})`, '-' + money(d.discountAmount)]);
    if (d.washing === 'we-wash') lines.push(['Washing service', money(config.washingPrice)]);
    lines.push(['Delivery', d.delivery === 'collect' ? 'Free (collection)' : money(d.deliveryFee)]);
    lines.push(['Total paid', money(d.total), true]);

    return render({
      subject: 'Your Do Good Party Box booking is confirmed',
      preheader: `Your kit is booked for ${longDate(d.partyDate)}. Here is everything you need.`,
      heading: `You're all booked in, ${d.firstName}! 🎉`,
      blocks: [
        { type: 'p', text: `Thank you for choosing a greener way to party. Your payment of **${money(d.total)}** has been received and your kit is reserved.` },
        { type: 'card', rows: detailRows },
        ...handoverBlocks(d),
        cycleSteps(d),
        ...returnBlocks(d),
        ...boxContents(d.guests),
        { type: 'h2', text: 'Your payment' },
        { type: 'lines', rows: lines },
        ...termsBlocks(d.delivery === 'collect' ? 'collection' : 'delivery'),
        { type: 'p', text: '**Need to cancel?** Just reply to this email with your name and party date.' },
        { type: 'p', text: 'Thanks for supporting a better way to party.' },
        { type: 'p', text: 'Cheers,\nCaro & Henry\nThe DGPB Team' }
      ]
    });
  }

  // ---------- 2. Reminder before the party ----------
  function partyReminder(d) {
    return render({
      subject: d.delivery === 'collect' ? 'Your party kit is ready to collect soon' : 'Your party kit is on its way soon',
      preheader: `A quick reminder for ${longDate(d.handoverDate)}.`,
      heading: `Nearly party time, ${d.firstName}! 🎈`,
      blocks: [
        { type: 'p', text: d.delivery === 'collect'
          ? `Just a quick reminder that your kit is ready for you to collect on **${longDate(d.handoverDate)}**, ${windowLabel(d.handoverWindow)}.`
          : `Just a quick reminder that we're delivering your kit on **${longDate(d.handoverDate)}**, ${windowLabel(d.handoverWindow)}.` },
        ...handoverBlocks(d).slice(2), // skip the heading and opening line, we have our own
        { type: 'p', text: `Your party is on **${longDate(d.partyDate)}** and the kit is due back by **${longDate(d.returnDate)}**.` },
        { type: 'p', text: `Something changed? Reply to this email and we'll sort it. Have a brilliant party!` }
      ]
    });
  }

  // ---------- 3. Reminder before the return date ----------
  function returnReminder(d) {
    const washNote = d.washing === 'we-wash'
      ? "You chose our washing service, so there's no need to wash anything. Just pack it back in the box."
      : 'Please wash everything with soap and water (not just a rinse) and dry it before it goes back in the box.';
    const lateNote = `You have one day's grace after the return date. After that a late fee of £${config.lateFee} per day applies, because another family may be waiting for the kit.`;
    const blocks = d.delivery === 'collect'
      ? [
        { type: 'p', text: `Hope the party was brilliant! Your kit is due back **tomorrow, ${longDate(d.returnDate)}**.` },
        { type: 'p', text: `Please bring it back to ${config.collectionAddress}.` },
        { type: 'w3w', text: config.w3w, url: config.w3wUrl },
        { type: 'button', label: 'Open the pin in Google Maps', url: config.mapsUrl }
      ]
      : [
        { type: 'p', text: `Hope the party was brilliant! We're collecting your kit **tomorrow, ${longDate(d.returnDate)}**. Please have everything packed back in the box and ready to go.` }
      ];
    return render({
      subject: d.delivery === 'collect' ? 'Your party kit is due back tomorrow' : "We're collecting your party kit tomorrow",
      preheader: `Return date: ${longDate(d.returnDate)}.`,
      heading: `Return day is nearly here, ${d.firstName} ♻️`,
      blocks: [
        ...blocks,
        { type: 'h2', text: 'Before it goes back' },
        { type: 'list', items: [
          washNote,
          'Check everything from the checklist is in the box.',
          'Normal wear and tear is fine. If something got lost or broken, just let us know.'
        ] },
        { type: 'small', text: lateNote },
        { type: 'p', text: 'Thanks for helping keep party waste out of landfill!' }
      ]
    });
  }

  // ---------- 4. Feedback request ----------
  function feedbackRequest(d) {
    const blocks = [
      { type: 'p', text: "Thank you for hiring a Do Good Party Box. We hope your party went brilliantly and that the kit made life a little easier." },
      { type: 'p', text: "We're a small business and always want to do better, so we'd love to hear how it went. What worked, what didn't, and anything you'd change. Even a line or two helps us a lot." }
    ];
    if (config.feedbackUrl) {
      blocks.push({ type: 'button', label: 'Tell us how it went', url: config.feedbackUrl });
      blocks.push({ type: 'p', text: 'Or just reply to this email. It comes straight to us.' });
    } else {
      blocks.push({ type: 'p', text: '**Just reply to this email.** It comes straight to us, and we read every one.' });
    }
    blocks.push({ type: 'p', text: "If you enjoyed it, we'd be so grateful if you told a friend or two. Word of mouth is how a small business like ours grows." });
    blocks.push({ type: 'small', text: "We'll only ask this once. If you'd rather not hear from us, reply with 'no thanks' and that's the end of it." });
    blocks.push({ type: 'p', text: 'Cheers,\nCaro & Henry\nThe DGPB Team' });
    return render({
      subject: 'How was your party?',
      preheader: 'We would love to hear how it went.',
      heading: `How did it go, ${d.firstName}? 🎉`,
      blocks
    });
  }

  // ---------- 5. Cancellation and refund ----------
  function cancellation(d) {
    return render({
      subject: 'Your Do Good Party Box booking has been cancelled',
      preheader: `Your refund of ${money(d.refundAmount)} is on its way.`,
      heading: `Your booking is cancelled, ${d.firstName}`,
      blocks: [
        { type: 'p', text: `We've cancelled your booking for **${longDate(d.partyDate)}** and refunded **${money(d.refundAmount)}** to the card you paid with.` },
        { type: 'p', text: 'Refunds usually take a few working days to appear, depending on your bank.' },
        { type: 'p', text: "We're sorry we won't be part of your party this time. If your plans change, you're always welcome to book again." },
        { type: 'button', label: 'Book another date', url: SITE_URL },
        { type: 'small', text: "If you didn't ask for this cancellation, or something doesn't look right, reply to this email and we'll sort it out." },
        { type: 'p', text: 'Cheers,\nCaro & Henry\nThe DGPB Team' }
      ]
    });
  }

  return { bookingConfirmation, partyReminder, returnReminder, feedbackRequest, cancellation };
}

module.exports = { create, parseDay, longDate, windowLabel, money, esc };
