# YouTube MCP for Google Apps Script

An MCP server that runs as a Google Apps Script web app and uploads and edits
YouTube videos. No server to host.

| Tool | What it does |
| --- | --- |
| `youtube_videos_upload`, `youtube_videos_upload_continue` | Chunked upload from Google Drive or an https URL |
| `youtube_videos_update` | Change title, description, tags, category, visibility, schedule and other settings |
| `youtube_thumbnails_set` | Set a custom thumbnail |
| `youtube_videos_delete` | Delete a video |
| `youtube_videos_list`, `youtube_videos_list_mine` | Read video details; list a channel's own uploads |
| `youtube_video_categories_list` | Look up category IDs |
| `youtube_accounts_list`, `_connect`, `_remove`, `_set_default` | Choose which channel to act as |

It works with the account that deploys it, and with any other channel you connect through OAuth.

## Deploy

1. Open <https://script.new>. In **Project Settings**, tick **Show "appsscript.json" manifest file**.
2. Replace `Code.gs` with [dist/Code.gs](dist/Code.gs) and `appsscript.json` with [dist/appsscript.json](dist/appsscript.json).
3. Select the `setup` function and click **Run**. Approve the permissions. This creates the API key.
4. **Deploy > New deployment > Web app**, with **Execute as: Me** and **Who has access: Anyone**. Copy the URL ending in `/exec`.
5. Run `setup` again and open the execution log. It prints the MCP endpoint: `https://script.google.com/macros/s/.../exec?key=...`

After changing the code, use **Deploy > Manage deployments > Edit > New version** so the URL stays the same.

With [clasp](https://github.com/google/clasp) instead: copy `.clasp.json.example` to `.clasp.json`, set your script ID, and run `clasp push`.

## Connect a client

Claude Code:

```bash
claude mcp add --transport http youtube "https://script.google.com/macros/s/XXXX/exec?key=YOUR_KEY"
```

Clients that only speak stdio (for example Claude Desktop's config file):

```json
{ "mcpServers": { "youtube": { "command": "npx", "args": ["-y", "mcp-remote", "https://script.google.com/macros/s/XXXX/exec?key=YOUR_KEY"] } } }
```

The client must follow HTTP redirects, because Apps Script answers every POST with a 302.

## Use other channels

The `owner` account (whoever deployed the script) works immediately, on that Google account's own channel. To act as any other channel, including brand channels:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen and add the channel owners as test users (or publish the app).
3. Create an **OAuth client ID** of type **Web application** whose **Authorized redirect URI** is your `/exec` URL.
4. In the Apps Script editor, open **Project Settings > Script Properties** and add `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`.
5. Ask the assistant to run `youtube_accounts_connect` with an alias. Open the returned link, pick the channel, approve.

Every tool then accepts `account: "<alias>"`. `youtube_accounts_set_default` changes which account is used when it is omitted.

While the consent screen is in **Testing** mode, Google expires refresh tokens after 7 days; publish the app to keep channels connected.

## Script Properties

| Property | Purpose |
| --- | --- |
| `MCP_API_KEY` | Secret required as `?key=`. Created by `setup`; replace it with `rotateApiKey`. |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` | OAuth client for connecting extra channels. |
| `WEBAPP_URL` | Optional. Set it to the `/exec` URL if the redirect URI is detected wrongly. |
| `DEFAULT_ACCOUNT`, `YT_ACCOUNT_*` | Managed by the server (default alias, stored refresh tokens). |

## Uploading videos

`youtube_videos_upload` streams the file in 8 MB chunks. Each call uploads for about 40 seconds and returns `in_progress` with an `uploadId`; `youtube_videos_upload_continue` carries on until `completed`. Upload state is kept for 6 hours.

- `driveFileId` reads from the deploying account's Drive. `url` must be https and support range requests.
- YouTube locks videos uploaded through an unaudited API project to **private**. To publish through the API, the Cloud project has to pass [YouTube's API audit](https://support.google.com/youtube/contact/yt_api_form).

## Limits

- **Not in any public API**, so not possible: end screens and cards, monetisation settings, trimming or blurring in the Studio editor.
- **Quota**: the Data API allows 10,000 units a day by default, and uploads are expensive.
- **Apps Script**: a call may run for at most 6 minutes, and request headers are not readable, which is why the key is in the URL. Treat the endpoint URL as a password.
- **Security**: anyone with the endpoint URL controls every connected channel. Refresh tokens sit in Script Properties, visible to editors of the script project, so do not share the project.

## Development

```bash
npm test          # unit tests against in-memory Apps Script fakes
npm run coverage
npm run build     # src/*.js -> dist/Code.gs
```

Sources are in [src/](src/), ordered by filename. Apps Script shares one global scope across files, so there are no imports.
