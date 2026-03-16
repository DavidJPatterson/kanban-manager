#!/bin/bash
# Package Kanban Manager for Chrome Web Store upload
# Usage: bash package.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$SCRIPT_DIR/kanban-manager.zip"

# Remove old package if exists
rm -f "$OUT"

cd "$SCRIPT_DIR"

# Create zip excluding dev/docs files
zip -r "$OUT" \
  manifest.json \
  background.js \
  shared.js \
  popup.html \
  popup.js \
  board.html \
  board.js \
  options.html \
  options.js \
  icons/icon-16.png \
  icons/icon-48.png \
  icons/icon-128.png \
  -x "*.md" "*.sh" "*.html~" "icons/*.svg" "icons/generate-icons.html" "icons/convert-to-png.html"

echo ""
echo "Packaged: $OUT"
echo "Size: $(du -h "$OUT" | cut -f1)"
echo ""
echo "Next steps:"
echo "  1. Go to https://chrome.google.com/webstore/devconsole"
echo "  2. Click 'New Item' and upload $OUT"
echo "  3. Fill in the listing details (see STORE_LISTING.md)"
echo "  4. Upload screenshots (1280x800)"
echo "  5. Submit for review"
