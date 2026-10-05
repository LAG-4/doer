# Operating Gmail and local document tools

## Google project and consent

Use separate Google Cloud projects for development and production. Gmail uses a **Desktop app** OAuth client, the Gmail API, `openid`, `email`, `https://www.googleapis.com/auth/gmail.send`, and `https://www.googleapis.com/auth/gmail.modify`. When creating the client, select **This client will be used by an AI-powered agent**: Doer's models request actions on the user's behalf. Modify includes reading and organizing mail and is a restricted scope. Public launch requires restricted-scope verification; transmitting or storing restricted data on servers requires Google's security assessment. Review the selected AI providers and actual Gmail data flows before submission. Do not request the permanent-delete `https://mail.google.com/` scope. Existing send-only grants must reconnect to authorize the added scope; changing Cloud configuration does not upgrade saved tokens.

Configure the production Google Auth Platform with:

- App name: **Doer**; External audience.
- Operator: **Aryan Gupta**; intended support/developer contact: **aryangupta4feb@gmail.com**.
- Homepage: `https://doer.lagaryan.click`.
- Privacy: `https://doer.lagaryan.click/privacy-policy`; terms: `https://doer.lagaryan.click/terms-of-service`.
- Authorized domain: `lagaryan.click`, with Search Console ownership verified by a project owner or editor.

Google's support-email chooser only offers the currently signed-in Google account address and Google Groups managed by that account. Give `aryangupta4feb@gmail.com` Editor access to the production project, then sign in to the Console as that account to select it as the support email. Use the same address for developer contact information. IAM Editor access alone does not add it to another account's support-email dropdown.

Deploy and review the public pages before submitting verification; local source changes do not update the live website. Google requires an accurate scope justification and a demonstration video showing consent, Gmail connection, search/read, the full message review, approved sending and organizing, and disconnect. Describe background tokens, the local host architecture, and mail returned to models. Do not claim draft editing, attachment downloads, new label creation, permanent deletion, or Microsoft 365 access.

Keep the application in Testing with named testers while preparing the review. Testing refresh tokens for Gmail expire after seven days. Production consent configuration alone does not constitute verification approval. Follow the Console's verification requirements and wait for Google's approval before enabling public Gmail releases.

Primary requirements: [OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [verification requirements](https://support.google.com/cloud/answer/13464321), and [Google user data policy](https://developers.google.com/terms/api-services-user-data-policy).

## Runtime credentials and storage

For a private test client, set `DOER_GOOGLE_OAUTH_CLIENT_ID` and `DOER_GOOGLE_OAUTH_CLIENT_SECRET` in the host's launch environment. A development checkout may use gitignored `.env.local`; never commit client JSON, tokens, or encryption keys.

Packaged native desktop hosts generate a random per-install 32-byte encryption key. Electron safeStorage protects its saved copy in `gmail-encryption-key.bin` under the desktop state directory. Linux must have a working secret store; `basic_text`, unknown, and unavailable backends disable Gmail. Access and refresh tokens are stored as authenticated AES-256-GCM ciphertext through the server secrets store. Preserve the OS-protected key when preserving application data. Losing it requires revoking the Google grant and reconnecting after resolving storage; Doer refuses to overwrite unreadable credentials.

Standalone CLI, remote hosts, WSL hosts, and an externally launched development server must explicitly provide `DOER_GMAIL_ENCRYPTION_KEY` as canonical base64 encoding of 32 random bytes from a secure secret manager or OS credential store. Persist the key securely across restarts and inject it into the server environment. Doer does not generate a plaintext key file or enable Gmail without a key. Native desktop key provisioning does not configure a separately launched development server. Do not place this key in a task, shared Space, repository, or logs.

Development prototype plaintext Gmail records are encrypted on first successful read with a configured key. Without secure storage, sending remains disabled. Revoked refresh credentials are removed when Google returns `invalid_grant`; offline failures retain them for retry. Disconnect revokes remotely before deleting locally and cancels unanswered email reviews.

Doer uses one-use state and PKCE with `http://127.0.0.1:<server-port>/api/integrations/gmail/callback`. Complete connection from the host's system browser. Google disallows controllable embedded user-agents for OAuth. Native client IDs and bundled Desktop client secrets are extractable from distributed applications: treat neither as a confidential server credential. User tokens and the vault key must remain private. Normal provider subprocess launch environments omit the Gmail vault key and runtime OAuth client secret; a malicious process with full access to the host is outside this connector's protection boundary.

## Release configuration

After production verification and a packaged end-to-end check, configure these **GitHub repository secrets**:

- `DOER_RELEASE_GOOGLE_OAUTH_CLIENT_ID`
- `DOER_RELEASE_GOOGLE_OAUTH_CLIENT_SECRET`

Set repository variable `DOER_GMAIL_PUBLIC_READY=true` only when public launch is approved. Preflight refuses a ready release with either credential missing. Desktop/CLI builds embed only these dedicated CI values. Local development `.env.local` values are never used as build defaults. Without the gate, released Gmail is unavailable unless a host supplies its own OAuth configuration and secure vault key. Turning the gate off affects future builds; existing distributed clients require an update or Google-side action.

Before releasing, verify packaged Windows and macOS secure storage, Linux with and without a keyring, restart/reconnect, wrong account, denied/expired/restarted review, offline revoke, and remote paired-device review. Review approvals in the web, desktop, and mobile clients and exercise each supported provider, including custom instances. Automated connector tests use mocked Google responses and do not send mail. Public release, legal-page deployment, and verification submission remain operator actions.

## Local documents

These are local `.xlsx` and `.pptx` file tools, not live Office add-ins. Supported edits remain existing non-formula cells on the first worksheet and exact text runs on slides, within the 1 MB limit. Writes require a fresh hash, stay inside the Space, reject linked files, serialize through the workspace lease, flush a sibling temporary file and original backup, then atomically rename. Original copies are retained in `.doer-backups` until the user removes them.

Close files in Office before editing. An external program can still race the final hash check and rename; no live Office locking protocol is implemented. Validate representative real workbooks and decks in Office before a public release. Broader spreadsheet manipulation, slide layout editing, add-ins, and Microsoft cloud authorization require separate implementation and testing.
