# Tools

Open **Settings → Integrations → Tools** to turn on a tool for This computer. Plugin switches are shared by all Spaces on that computer. Turning a switch on also works for an already running task; turning a switch off stops new calls to that tool, including calls from an already running task.

For quick changes, open **Plugins** beside the access control in a task's message box. Its Gmail, Excel, and PowerPoint switches update the same switches in Settings, and changes in Settings appear in chat. On smaller screens, find them in the message box's **More composer controls** menu.

## Gmail

Turn on Gmail on the computer hosting Doer. The first connection opens Google sign-in in your browser. After connecting, ask a task to prepare an email. Doer displays the sender, recipients, subject, and full message for review; choose **Send this email** to approve that one send. If delivery is uncertain, check Gmail's Sent folder before requesting another send.

One Gmail account is shared by Spaces and trusted devices paired with the host. Each computer shows its own connection status and Disconnect; sign-in itself must be done in a browser on that computer. Switching Gmail off pauses the tool on that computer. **Disconnect** switches Gmail off, revokes Google's access and removes local credentials. It stays available when the switch is off. Opening Settings or the Plugins menu does not reconnect a disconnected account; turn Gmail on or choose **Connect Gmail** to sign in again. If revocation fails, access stays paused; retry while online or remove Doer in your Google account's third-party connections. Disconnecting does not erase task history or delivered mail.

Ask a task to search or summarize mail, such as “Summarize unread messages from the last week.” Reading uses Gmail's API and leaves messages unread. You can ask it to archive or restore messages to the inbox, mark them read or unread, star or unstar, apply or remove existing custom labels, or move mail to Trash and restore it. Each change shows the account, message and action for one-time approval. Permanent deletion, creating labels, editing drafts and downloading attachments are not supported. Search returns up to 20 messages per page; message bodies are limited to 64,000 characters with a truncation notice.

If you connected an older send-only version, disconnect and reconnect Gmail to grant read and organize access, then start a new task to load the new tools. Sign-in requires Google configuration and protected credential storage. Mail contents returned to a task may be stored in local history and sent to your chosen AI provider. Review the [privacy policy](https://doer.lagaryan.click/privacy-policy) and that provider's data practices before using sensitive mail.

If the Google OAuth app is still in Testing, Google expires its refresh token after seven days. Reconnect Gmail in settings when that happens.

## Local spreadsheets and presentations

Turn on **Spreadsheets** or **Presentations** to let tasks inspect `.xlsx` or `.pptx` files in the current Space. A task can replace an existing non-formula cell on the first spreadsheet sheet, or one exact text run on a presentation slide (the slide listing shows the exact runs to choose from). Other package parts are retained. No Microsoft account or Office installation is needed.

These tools accept files up to 1 MB. Close the document in Excel or PowerPoint before editing, then inspect it again. Doer saves the original to `.doer-backups` in the Space and reports the backup path; copy that file back to restore it. File contents used in tasks may be sent to your chosen AI provider. Live editing inside an open Excel or PowerPoint window is not supported.
