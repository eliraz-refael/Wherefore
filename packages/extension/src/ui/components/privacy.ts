/**
 * What Claude sees, in the UI's words. Keep it true to TabTools: titles and redacted URLs go to
 * the model; page text only when it asks; `isSensitive` pages (core url.ts) are never read.
 */
export const PRIVACY_SHORT =
  "Claude sees tab titles and some page text. Mail, chat, cloud consoles and sign-in pages are never read."

export const PRIVACY_DETAILS = [
  "Claude sees your tab titles and web addresses, with secrets removed. It reads page text only when a title isn't enough.",
  "Mail, chat, cloud consoles, sign-in pages, and pages about billing, passwords or API keys are never read. Neither is anything on your own computer (localhost).",
  "Your list and your API key stay in this browser. Nothing goes anywhere except to Claude, with the key you entered."
] as const
