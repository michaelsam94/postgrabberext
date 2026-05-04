# PostGrabber

Chrome extension (Manifest V3) for **Facebook**: capture post text and media references from the feed, keep a **local queue**, and paste items into the **Create post** composer—including optional **Next** / **Post** automation for the English UI.

Repository: [github.com/michaelsam94/postgrabberext](https://github.com/michaelsam94/postgrabberext)

## Features

- **Context menu (right‑click)** on Facebook pages: copy post payload, or **save a post snapshot** into your queue.
- **Queue (options page)**: JSON-backed list in the browser; **export / import** queue as JSON, clear, reload.
- **Load next into composer**: fills the open Facebook composer with the next queued item (text + optional direct image/video URLs).
- **Publish flows**: optional automation to click **Next** then **Post** after filling (English Facebook UI); supports publishing the first item or the whole queue.
- **“Load next” + auto-advance**: optional checkbox so **Load next** can run the same Next/Post steps as Publish (queue removal still follows the button you use).
- **Media**: when a saved post includes direct CDN-style image/video URLs, the extension can attach them via the composer file input (fetches through the extension where needed for CORS).
- **Logging**: optional in-page logs (`postgrabberLogCopy()` in the Facebook tab console) for debugging.

Facebook’s DOM changes often—verify content before publishing.

## Privacy & data

- **Saved posts live only on your device** in [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage)—there is **no PostGrabber server**, **no analytics endpoint**, and **no account** tied to the extension.
- **Nothing is sent to a third-party backend** operated by this project. Data stays in your browser profile unless **you** export JSON or copy text to the clipboard.
- **Facebook** and **image/CDN hosts** (e.g. `*.fbcdn.net`) are contacted **only as part of normal browsing** (you are already on Facebook) and for **fetching media URLs** you chose to load into the composer. Those requests go to those hosts directly, not through a PostGrabber relay.
- **Clipboard**: used only when you choose **copy** actions, subject to Chrome’s permission prompts and your OS clipboard behavior.

You are responsible for what you save, export, and publish.

## Permissions (summary)

| Permission        | Why |
|------------------|-----|
| `contextMenus`   | Facebook submenu entries. |
| `clipboardWrite` | Copy post text / payload when you use copy. |
| `storage`        | Local queue JSON in `chrome.storage.local`. |
| `tabs`           | Open/focus Facebook and send fill messages to the tab. |
| Host permissions | Facebook + common FB CDN hosts for the content script and media fetch. |

## Install (developer / unpacked)

1. Clone this repo.
2. Open Chrome → **Extensions** → enable **Developer mode** → **Load unpacked** → select the `postgrabberext` folder (the one containing `manifest.json`).

## License

MIT — see [LICENSE](./LICENSE).
