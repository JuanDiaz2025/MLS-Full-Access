#!/usr/bin/env sh
# Builds dist/whatsapp-reader.exe for Windows (no C compiler needed).
set -e
cd "$(dirname "$0")"
go test ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags "-s -w" -o dist/whatsapp-reader.exe .
echo "Built dist/whatsapp-reader.exe"
