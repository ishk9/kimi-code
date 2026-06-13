Drive a real, persistent web browser (Chromium via Playwright) to interact with websites that need rendering, clicking, form input, or file downloads. Use this when `WebSearch`/`FetchURL` are not enough — e.g. JavaScript-heavy pages, multi-step navigation, picking a region/place from a map or dropdown, or downloading CSV/Excel data files.

One browser page persists across calls within the session, so you build up state: navigate once, then click/type/read/download in follow-up calls. Call `close` when finished to free resources.

Pass a single `action` plus the fields that action needs:

- `navigate` — open a page. Requires `url`. Returns the page title, URL, visible text, and on-page links.
- `snapshot` — re-read the current page (title, text, links) after something changed.
- `click` — click an element. Provide either `selector` (CSS) or `text` (visible link/button text). Returns the resulting page snapshot.
- `type` — fill an input. Requires `selector` and `value`; set `submit: true` to press Enter afterwards.
- `links` — list links on the page. Filter with `contains` (substring of href or text) and/or `extensions` (e.g. `["csv","xlsx","xls"]`) to find downloadable data files.
- `download` — save a file locally. Provide a direct `url`, or a `selector`/`text` of a link/button that triggers the download. Optionally set `subdir` (folder under the downloads dir) and `filename`. Returns the absolute saved path and size.
- `screenshot` — capture the current page to a PNG; set `full_page: true` for the whole scrollable page. Returns the saved path.
- `close` — close the browser.

Notes:
- Links returned by `navigate`/`snapshot`/`links` always have absolute `href`s, so you can download them directly with `download` + `url`.
- Prefer `download` with a direct `url` for files you already see in the links list; use `selector`/`text` only when the download is triggered by a button/JavaScript.
- Downloads are written under the workspace downloads directory; report the saved paths back to the user.
