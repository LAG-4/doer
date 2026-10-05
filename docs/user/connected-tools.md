# Tools

Open **Settings → Integrations → Tools** to turn on a tool for This computer or a Space. A Space setting can override the computer setting. Turning a switch off stops new calls to that tool, including calls from an already running task.

For quick changes, open **Plugins** beside the access control in a task's message box. Its Gmail, Excel, and PowerPoint switches apply to the current Space and its tasks. On smaller screens, find them in the message box's **More composer controls** menu. Settings keeps the computer defaults and full connection controls.

## Gmail

Turn on Gmail on the computer hosting Doer. The first connection opens Google sign-in in your browser. After connecting, ask a task to prepare an email. Doer displays the sender, recipients, subject, and full message for review; choose **Send this email** to approve that one send. If delivery is uncertain, check Gmail's Sent folder before requesting another send.

One Gmail account is shared by Spaces and trusted devices paired with the host. Switching Gmail off pauses the tool in that Space. **Disconnect** revokes Google's access and removes local credentials. It stays available when the switch is off. If revocation fails, retry while online or remove Doer in your Google account's third-party connections. Disconnecting does not erase task history or delivered mail.

This tool sends mail only. It does not read your inbox, edit Gmail drafts, or manage labels. Sign-in is available only when the host has Google sign-in configured and protected credential storage. Review the [privacy policy](https://doer.lagaryan.click/privacy-policy) and your chosen AI provider's data practices before sharing sensitive content.

If the Google OAuth app is still in Testing, Google expires its refresh token after seven days. Reconnect Gmail in settings when that happens.

## Local spreadsheets and presentations

Turn on **Spreadsheets** or **Presentations** to let tasks inspect `.xlsx` or `.pptx` files in the current Space. A task can replace an existing non-formula cell on the first spreadsheet sheet, or one exact text run on a presentation slide. Other package parts are retained. No Microsoft account or Office installation is needed.

These tools accept files up to 1 MB. Close the document in Excel or PowerPoint before editing, then inspect it again. Doer saves the original to `.doer-backups` in the Space and reports the backup path; copy that file back to restore it. File contents used in tasks may be sent to your chosen AI provider. Live editing inside an open Excel or PowerPoint window is not supported.
