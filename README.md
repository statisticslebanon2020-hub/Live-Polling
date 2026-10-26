# Live Polling

A small web app for single-choice audience questions. Respondents scan a QR code, answer in their phone browser, and the presenter sees totals update live.

## Run locally

1. Install Node.js 20 or newer.
2. Open this `live-polling` folder in VS Code.
3. In its terminal, run `npm install` and then `npm start`.
4. On the same computer, open `http://localhost:3000/dashboard`.
5. The dashboard shows a QR code for the respondent page. On your local network, phones need the computer's LAN address instead of `localhost`; for participants outside that network, deploy the app to a public HTTPS host.

The starter questions are in `questions.json`. Edit them before running the app. Each question has a unique `id`, a `text`, and at least two `options`.

Set `PUBLIC_URL` to the final public base URL after deployment, for example `https://your-app.example.com`. This makes the QR code work from the dashboard. Without it, the app uses the request host.

Set `PRESENTER_KEY` in the hosting service's environment variables. Open `/dashboard` and enter this key to access presenter controls. The key field disappears after login. Keep the key private; presenter access lasts up to 12 hours or until the service restarts.

For local use, responses are stored in `data/responses.json`. For Render, configure Supabase using `supabase-schema.sql`, then set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the hosting environment. With these values configured, every response is stored in the Supabase `responses` table and reloaded after the app restarts. Keep the secret key in Render environment settings only; never commit it to GitHub. Review and export rows from Supabase's Table Editor. The presenter Reset all votes button clears both the current response cache and Supabase table.

Voting stays open throughout the poll. The presenter can navigate between questions, and respondents stay on the question opened from their QR code. The dashboard updates live as responses arrive.

## Vote limits

The app uses a persistent browser cookie to accept one answer per question from the same browser. Rescanning the QR code in that browser does not allow another answer. This is suitable for informal live polling, but it is not identity verification: participants can bypass it by clearing cookies or using another browser/device. Do not use this as a secure ballot or for sensitive data.

## Deployment

Deploy this folder as a Node web service with start command `npm start`. Configure `PUBLIC_URL`, `PRESENTER_KEY`, `SUPABASE_URL`, and `SUPABASE_SECRET_KEY` in the host's environment settings. The free Supabase plan currently includes a 500 MB database and can pause projects after a week of low activity, so export a CSV backup after each event and reactivate a paused project before using the poll again. Test the deployed QR code from a phone before your event.
