# Zupu circular prototype → Nest API wiring

This frontend is the **circular Apple-style React prototype** (not the Vue admin).
Vite serves it on **port 8888** and proxies `/dev-api` → Nest `http://localhost:8080`.

## Run

```bash
cd zupu-frontend
npm install
# Nest backend must already listen on :8080
npm run dev
# open http://localhost:8888
```

Default login: `admin` / `admin123` (hint shown on login form).

## Auth

- `POST /auth/login` `{username,password}` → `{token,user}`
- Token stored in `localStorage` keys `zupu_token` / `zupu_user`
- JSON calls: `Authorization: Bearer <token>`
- `<img>` / download links: append `access_token=` query (see `authImageUrl` / `downloadUrl`)

## Nest endpoints used

| UI action | API |
|-----------|-----|
| Login | `POST /auth/login` |
| Task list | `GET /tasks` |
| Create task | `POST /tasks` body `{ name, sourceFolder }` |
| Start batch | `POST /tasks/:id/process` then poll `GET /tasks/:id` |
| Open review | `GET /tasks/:id` + `GET /tasks/:id/images` |
| Live preview | `POST /tasks/:id/images/:imageId/preview` → PNG blob (debounce 280ms) |
| Pass page | `PUT .../reprocess` then `POST .../confirm` |
| Finish task | `POST /tasks/:id/confirm` |
| Download zip | `GET /tasks/:id/download?access_token=` |
| Folder pick | `GET /files/default-folder`, `GET /files/browse?path=` |

## Param mapping (prototype UI ↔ Nest ScanWash)

| Prototype slider | Nest field | Formula |
|------------------|------------|---------|
| `denoiseStrength` 0–100 | `denoise` 0–12 | `denoise = denoiseStrength/100*12` |
| `contrastThreshold` 0–100 | `threshold` 80–220 | `threshold = 80 + contrastThreshold/100*140` |
| `sharpenStrength` 0–100 | `contrast` 0.8–3 | `contrast = 0.8 + sharpenStrength/100*2.2` |
| `autoCrop` | `autoCrop` | always `false` from UI (no dynamic crop; manual cropBox only) |
| `safetyMargin` | `cropPadding` | passthrough (px) |
| always | `preset` | `'auto'` |

Manual crop: UI stores normalized `{x,y,width,height}` (0–1). API receives pixel `{x,y,w,h}` via `uiCropToNest` using image `originalWidth/Height`. Reverse on load via `nestCropToUi`.

## Task / image shape mapping

- Nest `totalCount` → UI `totalPages`
- Nest `confirmedCount` → UI `reviewedPages`
- Nest `sourceFolder` → UI `folderPath` (create still posts `sourceFolder`)
- Nest status `processing` / `reviewing` → UI card status `reviewing`
- Nest status `failed` → treated like pending (show「开始处理」)
- Image `sourceUrl` / `resultUrl` / `thumbUrl` → `originalUrl` / `processedUrl` / `thumbnailUrl` (with `/dev-api` + token)
- Image `status === 'confirmed'` → `reviewStatus: 'passed'`

## Files

- `src/api/client.ts` — fetch helpers, auth, preview blob, URLs
- `src/api/params.ts` — UI ↔ Nest param/crop mapping
- `src/api/mappers.ts` — Nest task/image → prototype `Task` / `ScanItem`
- `src/App.tsx` — auth gate, list/create/process/poll, workbench routing
- `src/components/LoginView.tsx` — real login
- `src/components/TaskCenterView.tsx` — list/filter + server folder browser + server zip download
- `src/components/ReviewWorkbench.tsx` — Nest preview/reprocess/confirm; prototype JSX/classes kept
- `src/utils/imageProcessor.ts` — **unused** for clean pipeline (left in tree)

## Assumptions

1. Create body field is **`sourceFolder`** (matches prior Vue admin), not `folderPath`.
2. Nest listens on **8080**; vite rewrite strips `/dev-api` prefix.
3. Image `params` / `cropBox` may arrive as JSON strings from Nest — parsers tolerate both.
4. Client-side canvas `processScanImage` is not used for the clean result; ScanWash stays on the backend.
