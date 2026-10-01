---
name: telegram
description: Send requested results, alerts, or scheduled-job notifications to the user's linked Telegram chat through Pekka's Telegram plugin.
---

# Telegram

Use `telegram_send_message` when the user asks to receive a Telegram message or notification. It sends only to that user's linked private chat; it cannot select another recipient, read conversations, or send attachments.

- Pass a nonempty plain-text `text` of at most 3,800 characters. Named-bot runs automatically prefix the message with the bot's name; do not duplicate it.
- Keep the message useful on its own: include the outcome, relevant links, and any material failure or uncertainty. Formatting markup is sent as text.
- Prefer one concise message. If the user requires a longer report, split it into clearly ordered messages within the limit and send them sequentially.
- If Telegram is unconfigured, unlinked, or disabled, direct the user to the Plugins page to link and enable it. Do not ask for the bot token or attempt a direct API workaround.
- Do not automatically retry an uncertain send. This plugin has no read tool to check delivery; report the uncertainty so the user can check their chat.
- Report a successful receipt using its returned message ID. Acceptance does not prove the user read it.

For future or recurring notifications, create a job only when the user requests scheduling. Use `list_scheduled_jobs` first, then `schedule_job` with an explicit timezone offset and a self-contained task describing what to check and when to call `telegram_send_message`. Preserve any requested notification conditions. Report the job ID and next run time, and explain that `pekka scheduler` must be running for the job to execute.
