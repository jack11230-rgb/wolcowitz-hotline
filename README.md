# Wolcowitz Family Hotline

Twilio Voice webhook app for the family hotline (+1 620-634-1542).

- `POST /voice` – main menu (set as the Twilio number's "A call comes in" webhook).
- 1 / 3 – live conference rooms `mishnayos` and `shmiras-haloshon`.
- 2, 4, 5, 6, 7 – recorded sections, newest first; press 1 for the previous recording, * for the menu.
- 8 – leave a message (saved to the inbox; Jack gets an email with a link).
- 9 – admin (PIN in the `ADMIN_PIN` env var): record a new section recording, or review inbox
  messages and publish one to a section.

Recordings are stored in Postgres (audio bytes + Twilio URL), so they survive restarts and deploys.
Prompts live in `audio/` (edge-tts, en-US-AndrewMultilingualNeural, rate -8%).

Env: `DATABASE_URL`, `ADMIN_PIN`, `RESEND_API_KEY`, `NOTIFY_EMAIL`, `RESEND_FROM`, optional
`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (enables signature validation and authenticated
recording downloads), optional `PUBLIC_BASE_URL` (defaults to `RENDER_EXTERNAL_URL`).
