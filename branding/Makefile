# Branding layer helpers — run from the repo root:
#   make -f branding/Makefile <target>

BRANDING_DIR := $(dir $(lastword $(MAKEFILE_LIST)))

.PHONY: apply check report restore sync-upstream generate-assets build

apply:
	node $(BRANDING_DIR)apply-branding.mjs --apply

check:
	node $(BRANDING_DIR)apply-branding.mjs --check

report:
	node $(BRANDING_DIR)apply-branding.mjs --report

restore:
	node $(BRANDING_DIR)apply-branding.mjs --restore

# Pull upstream and re-apply branding. Branding patches are never committed,
# so the merge itself is always conflict-free.
sync-upstream:
	node $(BRANDING_DIR)apply-branding.mjs --restore
	git fetch upstream --tags
	git merge upstream/main
	node $(BRANDING_DIR)apply-branding.mjs --apply

# Regenerate branding/assets/ from the source logo
# (source path is relative to the repo root).
generate-assets:
	npm install --prefix $(BRANDING_DIR)tools
	node $(BRANDING_DIR)tools/generate-assets.mjs assests/logo_hangtho.png

# Build the branded Docker image (the Dockerfile hook re-applies branding
# in-image and fails the build if upstream drift breaks a patch).
build:
	docker build -t open-webui-branded:local .
