# Tools

Open **Settings → Integrations → Tools** to turn on a tool for an environment or a Space. A Space setting can override the environment setting. Turning a switch off stops new calls to that tool, including calls from an already running task.

## Gmail

Turn on Gmail on the computer hosting Doer. The first connection opens Google sign-in in a browser. After connecting, tell a task the exact recipients, subject, and body of a plain-text email, or review and approve those details in the conversation before asking it to send. Disconnect from the same settings page when you no longer want Doer to use that account.

This tool sends mail only. It does not read your inbox, edit Gmail drafts, or manage labels. The host needs its own Google OAuth app configuration before sign-in is available.

If the Google OAuth app is still in Testing, Google expires its refresh token after seven days. Reconnect Gmail in settings when that happens.

## Local spreadsheets and presentations

Turn on **Spreadsheets** or **Presentations** to let tasks inspect `.xlsx` or `.pptx` files in the current Space. A task can replace an existing non-formula cell on the first spreadsheet sheet, or one exact text run on a presentation slide. Other package parts are retained. No Microsoft account or Office installation is needed.

These tools accept files up to 1 MB. Reopen or inspect a file before editing it if another app has changed it. Live editing inside an open Excel or PowerPoint window is not supported.
