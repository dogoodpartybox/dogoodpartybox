# Do Good Party Box

Reusable kids party kit hire. Website at https://dogoodpartybox.co.uk, backend API on Fly.io.

## How it fits together

| Part | Where it lives | How it goes live |
| --- | --- | --- |
| Website (`index.html`) | GitHub Pages, custom domain in `CNAME` | Merge to `main`. Pages rebuilds in a minute or two. |
| Backend (`server.js`) | Fly.io app `do-good-party-box-api` | Merge a backend change to `main`. The `Test and deploy` workflow runs the tests, then deploys. |
| Bookings, enquiries, discount codes, blocked dates | Google Sheet (service account) | Edited by hand in the sheet. |
| Payments | Stripe (live keys in Fly secrets) | n/a |
| Receipts and alerts | Zoho SMTP | n/a |

## Making a change

1. Changes arrive as a pull request. The tests run automatically on every pull request.
2. Read the summary, and check the tests show a green tick.
3. Press **Merge**. A change to `server.js`, `package.json`, `Dockerfile` or `fly.toml` deploys to Fly by itself. A change to `index.html` only needs the Pages rebuild.

Run the tests locally with `npm install` then `npm test`. They use simulated Google Sheets, Stripe, email and Slack, so they never touch live data.

## Secrets

Secrets are never stored in this repository.

- Fly secrets (`fly secrets list -a do-good-party-box-api`): Stripe keys and webhook secret, Google service account, Zoho login, Slack webhook, sheet ID.
- GitHub repository secret `FLY_API_TOKEN`: lets the deploy workflow publish to Fly.

## Things to know

- Prices live in two places: the display in `index.html` and the figures in `server.js`. Change both together. The server decides what is charged.
- If the hire terms change, update the pop-up in `index.html` and the summary in `server.js`, and bump `TERMS_VERSION`.
- The live site is not tested by the automatic checks. After a deploy, load the site, pick a date and check the booking form loads.
