# Branding Wrapper Layer

Lớp wrapper rebrand cho fork này: đổi tên + logo Open WebUI sang thương hiệu riêng
**mà không commit bất kỳ thay đổi nào vào file upstream** — nhờ vậy `git pull` từ
upstream luôn merge sạch, không conflict.

> ⚠️ **License**: mục 4 của `LICENSE` (upstream) cấm thay đổi branding Open WebUI
> trừ khi deployment có **≤ 50 end-users trong 30 ngày**, có giấy phép bằng văn bản,
> hoặc enterprise license. Tự xác nhận điều kiện trước khi triển khai production.

## Cấu trúc

| File | Vai trò |
|---|---|
| `brand.json` | Nguồn sự thật duy nhất: tên, slug, website, màu, feature flags |
| `patches.json` | Bảng patch: `{file, find, replace, count, unless, flag}` + danh sách asset copies |
| `apply-branding.mjs` | Engine (Node stdlib, không dependency). Modes: `--apply` `--check` `--report` `--restore` |
| `assets/` | Bộ assets đủ kích thước (generate từ logo nguồn, được commit) |
| `tools/generate-assets.mjs` | sharp pipeline tạo assets từ 1 logo nguồn (npm install cục bộ) |
| `i18n-overrides.json` | Override bản dịch runtime (nhập qua Admin → Settings → General → UI Translations) |

## Sử dụng (chạy từ repo root)

```bash
make -f branding/Makefile report           # xem trạng thái, không ghi gì
make -f branding/Makefile apply            # áp patch (uncommitted) + copy assets
make -f branding/Makefile check            # CI: cây đã brand đầy đủ? exit 1 nếu chưa/drift
make -f branding/Makefile restore          # git restore mọi file upstream bị patch
make -f branding/Makefile sync-upstream    # restore → fetch/merge upstream/main → apply lại
make -f branding/Makefile generate-assets  # tạo lại assets từ assests/logo_hangtho.png
make -f branding/Makefile build            # docker build (hook trong image verify lại)
```

Hoặc gọi trực tiếp: `node branding/apply-branding.mjs --apply`

## Nguyên tắc hoạt động

- **Chỉ commit `branding/`** (file mới — upstream không bao giờ tạo path này → merge
  tự động sạch). Mọi patch vào file upstream **giữ uncommitted** trong working tree.
- Dockerfile có hook `RUN node branding/apply-branding.mjs --apply` sau `COPY . .`
  → image luôn đúng brand từ bất kỳ checkout nào có `branding/`; nếu upstream drift
  làm hỏng anchor, **docker build fail ngay tại hook** (fail-fast có chủ đích).
- Engine trạng thái mỗi patch: `APPLIED` / `NOOP` (đã áp từ trước) / `SKIP` (flag
  hoặc marker `unless`) / `DRIFT` (anchor không còn khớp upstream — cần cập nhật
  `patches.json`) / `ERROR`. Re-run luôn cho cây byte-identical.

## Đồng bộ upstream

```bash
make -f branding/Makefile sync-upstream
# DRIFT? Đọc anchor mới của upstream, sửa dòng tương ứng trong patches.json, chạy lại apply.
```

KHÔNG dùng `make update` của root Makefile (bare `git pull` + compose up — không an toàn
với working tree có patch).

## brand.json

| Trường | Ý nghĩa |
|---|---|
| `name` | Tên hiển thị chính (UI title, sidebar, notification, TOTP issuer, OAuth client…) |
| `shortName` | Tên ngắn (site.webmanifest `short_name`) |
| `slug` | tên kebab-case (package.json `name`, container name) |
| `website` | URL thương hiệu (banner khởi động, User-Agent crawler) |
| `themeColorDark` / `themeColorLight` | màu chrome trình duyệt (đang = mặc định upstream) |

### Flags

| Flag | Mặc định | Công dụng |
|---|---|---|
| `patchThemeColor` | on | Đổi meta theme-color (đặt màu mới trong brand.json rồi bật) |
| `patchAsciiBannerFallback` | on | Banner khởi động backend |
| `patchCliEcho` | on | `open-webui --version` in tên mới |
| `patchDockerfileHook` | on | Hook apply trong Dockerfile |
| `patchSwaggerFavicon` | on | Favicon trang /docs |
| `patchHttpReferer` | **off** | Header `HTTP-Referer` gửi OpenRouter (attribution) |
| `patchJwtIss` | **off** | JWT `iss` claim (downstream verifier có thể pin) |
| `patchPyproject` | **off** | Đổi tên package Python (cần cập nhật `uv.lock` kèm) |
| `patchDockerCompose` | **off** | Tên container/volume compose |
| `patchHatchBuild` | **off** | Log strings khi build wheel |

## Assets

Generate từ 1 logo nguồn (`assests/logo_hangtho.png`), letterbox canvas vuông trong suốt:

| File | Size | Dùng ở |
|---|---|---|
| `favicon.png` | 512² | favicon chính, sidebar logo, avatar fallback |
| `favicon-96x96.png` | 96² | favicon |
| `favicon.ico` | 16/32/48/64 | shortcut icon |
| `favicon.svg` | 512² raster wrap | favicon SVG |
| `apple-touch-icon.png` | 180² | iOS home screen |
| `web-app-manifest-192/512.png` | 192²/512² | PWA maskable |
| `logo.png` | 500² | `/manifest.json` PWA icon |
| `splash.png` / `splash-dark.png` | 500² | splash light/dark (dark = copy light nếu không truyền `--dark`) |
| `swagger-favicon.png` | 32² | /docs |
| `custom.css` / `loader.js` | trống | injection stubs chính thức, load trên mọi trang |

Có SVG gốc? Đưa thẳng vào `assets/favicon.svg` và bỏ qua bước wrap PNG.
Đổi tên/thương hiệu thật: sửa `brand.json` → `apply` → `build` lại.

## KHÔNG ĐƯỢC ĐỔI (identifier hành vi/protocol)

Package Python `open_webui`; `importlib.metadata.version('open-webui')`; HKDF info
`open-webui/mfa-encryption/v1`; hash domain `Open WebUI temporary chat identity v1`
(`crypto/encryption/src/lib.rs`); MIME `application/x-open-webui-*`; structured-output
`open_webui:*`; header `X-OpenWebUI-*`; `COMMUNITY_ORIGINS`; các link
openwebui.com/docs.openwebui.com/github (chức năng); `"version"` trong `package.json`.

## Checklist verify sau khi build

1. Splash pre-hydration (disable cache): logo + title đúng ở light & dark
2. Login/Onboarding wordmark, favicon, title tab
3. Sidebar: icon + `$WEBUI_NAME`
4. `/api/config` → `"name"` không có đuôi `(Open WebUI)`
5. `/manifest.json`, `/opensearch.xml`, đủ file `/static/*` so bytes với `assets/`
6. `/api/version` vẫn đúng version upstream
7. `/docs` (ENV=dev): title + swagger favicon
8. Push notification test + webhook sender
9. `--check` exit 0; `--apply` ×2 → all NOOP
