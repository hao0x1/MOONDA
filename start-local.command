#!/bin/zsh
# Double-click to run MOONDA on this Mac (production build). Keep this window open while presenting.
cd "$(dirname "$0")/app" || exit 1
[ -d node_modules ] || npm install
npm run build && open "http://127.0.0.1:5191/" && npx vite preview --host 127.0.0.1 --port 5191
