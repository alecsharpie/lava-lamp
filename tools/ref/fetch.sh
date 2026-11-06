#!/bin/sh
# Re-downloads the reference clips used by tools/ref/metrics.py (not stored in the repo).
# Needs yt-dlp and curl. Run from the repo root.
set -e
mkdir -p reference/video && cd reference/video
yt-dlp -f "bv*[height<=480][ext=mp4]/bv*[height<=480]/b[height<=480]/b" --download-sections "*0-240" \
  -o "%(id)s.%(ext)s" --write-info-json --no-playlist -i -- \
  zaWkiPb4KQ0 Q_7gE0uSs3U vQPoICVkCeQ
for n in 01 02; do
  curl -sfL -A "lava-lamp-reference/1.0" -o "commons_Lava_lamp_oT_${n}_ies.ogv" \
    "https://commons.wikimedia.org/wiki/Special:FilePath/Lava_lamp_(oT)_${n}_ies.ogv"
  sleep 5
done
