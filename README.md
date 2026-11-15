# Wolcowitz Family Hotline

Twilio Voice webhook app for the family hotline (+1 620-634-1542).

- `POST /voice` – main menu (set as the Twilio number's "A call comes in" webhook).
- 1 / 2 – live conference rooms `mishnayos` and `shmiras-haloshon`.
- 3, 4, 5, 6, 7 – recorded sections (3 children, 4 teen girls, 5 teen boys, 6 events, 7 daily lesson), newest first; press 1 for the previous recording, * for the menu.
- 8 – leave a message (saved to the inbox; Jack gets an email with a link).
- 9 – Chanukah games: 1 daily trivia (hear today's question, press 1 to record name + answer),
  2 gelt treasure hunt clues (newest first, 1 = previous), 3 kids' talent show (hear favorites or
  record up to 3 minutes). Trivia answers and talent submissions are emailed to Jack.
- * (hidden) – admin, PIN in the `ADMIN_PIN` env var. Admin menu: 3–7 record a new section
  recording, 8 review option-8 messages and publish to a section, 9 Chanukah admin
  (1 new trivia question, 2 new gelt clue, 3 review/publish talent submissions, 4 hear trivia answers).

Recordings are stored in Postgres (audio bytes + Twilio URL), so they survive restarts and deploys.
Prompts live in `audio/` (edge-tts, en-US-AndrewMultilingualNeural, rate -8%).

Env: `DATABASE_URL`, `ADMIN_PIN`, `RESEND_API_KEY`, `NOTIFY_EMAIL`, `RESEND_FROM`, optional
`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` (enables signature validation and authenticated
recording downloads), optional `PUBLIC_BASE_URL` (defaults to `RENDER_EXTERNAL_URL`).
