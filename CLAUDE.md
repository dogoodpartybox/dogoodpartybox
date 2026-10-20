# Working on Do Good Party Box

Small UK business: reusable kids party kit hire. Owner: Henry (with Caro). Static site on GitHub Pages plus an Express backend on Fly.io. See `README.md` for how it fits together.

## Style
- UK English. Never use em-dashes.
- Keep changes targeted: edit the existing file in place, do not rewrite whole files or create duplicate copies.
- Give Henry a short plain summary of what changed and why, and flag anything he needs to do himself (sheet columns, Fly secrets, Stripe dashboard).

## Rules for changes
- Never put secrets, keys or tokens in the repo, in a commit or in a chat message.
- Run `npm install` then `npm test` before opening a pull request. Add or update tests for any backend behaviour change.
- Open a pull request for Henry to merge. Do not push to `main` directly: merging to `main` deploys the backend and takes real card payments.
- Bookings sheet columns are read by position for availability, so new columns go at the far right only. Writes are by header name.
- Prices and delivery bands exist in `server.js` (the source of truth) and are displayed in `index.html`. Change both.
- Hire terms exist in the `index.html` pop-up and in the receipt summary in `server.js`. Keep them identical and bump `TERMS_VERSION`.
- `index.html` stays a single file. The line endings in this repository are LF.
- Do not add files that must stay private to the repo root: GitHub Pages publishes it. `_config.yml` lists what is excluded from the public site, so update it when adding backend files.
