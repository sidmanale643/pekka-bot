---
name: contacts
description: Look up people's email addresses, phone numbers and organizations in the user's Google Contacts through Pekka's Google Contacts plugin.
---

# Google Contacts

Use `contacts_search` to find a person's email address or phone number before emailing them, inviting them to a meeting or adding them to a document. If access is disabled or missing, direct the user to connect and enable Google Contacts on the Plugins page.

- Search by name, email, phone number or organization. Matching works on the start of words, so try a first name, a last name or a company.
- Results list saved contacts first (`source: "contacts"`), then other contacts Google keeps for people the user has emailed (`source: "other"`), without duplicate addresses.
- When several people match, or a person has several addresses, ask the user which one to use rather than guessing. Prefer a saved contact over an other contact.
- The plugin is read-only: it cannot add, change or delete contacts.
- Contact details are personal data. Use them for the user's task and do not copy them into files, memory or messages unless the task needs it.
