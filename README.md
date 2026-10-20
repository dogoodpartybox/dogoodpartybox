# Do Good Party Box

Reusable kids party kit hire. Website at https://dogoodpartybox.co.uk, backend API on Fly.io.

## How it fits together

| Part | Where it lives | How it goes live |
| --- | --- | --- |
| Website (`index.html`) | GitHub Pages, custom domain in `CNAME` | Merge to `main`. Pages rebuilds in a minute or two. |
| Backend (`server.js`) | Fly.io app `do-good-party-box-api` | Merge a backend change to `main`. The `Test and deploy` workflow runs the tests, then deploys. |
| Bookings, enquiries, discount codes, blocked dates | Google Sheet (service account) | Edited by hand in the sheet. |
| Payments | Stripe (live keys in Fly secrets) | n/a |
| Customer emails and alerts to us | Zoho SMTP. Wording and layout live in `emails.js`; alerts to us are plain text in `server.js` | n/a |

## Emails

- Customers get a booking confirmation, a reminder 1 to 2 days before collection or delivery, a reminder the day before the return date, one feedback request 2 days after the return date, and a cancellation email when a booking is fully refunded in Stripe.
- The reminders run once a day at 09:00 UK time and record what they have sent in new columns at the far right of the Bookings tab. The server adds those columns itself if they are missing.
- We get an email at dogoodpartybox@gmail.com for each new booking, date enquiry and problem. Replying to a booking or enquiry alert goes straight to the customer.
- The cancellation email needs the `charge.refunded` event ticked on the Stripe webhook (Developers, Webhooks).
- Optional Fly secret `FEEDBACK_URL` adds a "Tell us how it went" button to the feedback email. Optional `ALERT_EMAIL` changes where our alerts go.
- `email-logo.png` in the repo root is the logo used in the emails. It must stay public.

## Making a change

1. Changes arrive as a pull request. The tests run automatically on every pull request.
2. Read the summary, and check the tests show a green tick.
3. Press **Merge**. A change to `server.js`, `package.json`, `Dockerfile` or `fly.toml` deploys to Fly by itself. A change to `index.html` only needs the Pages rebuild.

Run the tests locally with `npm install` then `npm test`. They use simulated Google Sheets, Stripe, email and Slack, so they never touch live data.

## Secrets

Secrets are never stored in this repository.

- Fly secrets (`fly secrets list -a do-good-party-box-api`): Stripe keys and webhook secret, Google service account, Zoho login, Slack webhook, sheet ID. Optional: `ALERT_EMAIL`, `FEEDBACK_URL`.
- GitHub repository secret `FLY_API_TOKEN`: lets the deploy workflow publish to Fly.

## Things to know

- Prices live in two places: the display in `index.html` and the figures in `server.js`. Change both together. The server decides what is charged.
- If the hire terms change, update the pop-up in `index.html` and the summary in `server.js`, and bump `TERMS_VERSION`.
- The live site is not tested by the automatic checks. After a deploy, load the site, pick a date and check the booking form loads.
