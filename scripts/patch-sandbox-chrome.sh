#!/usr/bin/env bash
# 给沙箱浏览器做一份补了蓝牙用途说明的副本（sandbox/chrome/），修复 Google 登录时被 macOS 杀掉（闪退）的问题。
# 原因：Chrome for Testing 的 Info.plist 没有 NSBluetoothAlwaysUsageDescription，
#      登录页尝试蓝牙通行密钥时，macOS 隐私保护（TCC）会直接终止进程。补上后改为弹出系统授权框，可以选「不允许」。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$HOME/Library/Caches/ms-playwright"
VER="$(ls "$CACHE" | grep -E '^chromium-[0-9]+$' | sort | tail -1)"
SRC="$CACHE/$VER/chrome-mac-arm64/Google Chrome for Testing.app"
DST="$ROOT/sandbox/chrome/Google Chrome for Testing.app"

rm -rf "$ROOT/sandbox/chrome"
mkdir -p "$ROOT/sandbox/chrome"
cp -R "$SRC" "$DST"
/usr/libexec/PlistBuddy -c "Add :NSBluetoothAlwaysUsageDescription string 喵团沙箱浏览器：登录页（如 Google 账号）可能会询问是否用蓝牙连接手机或安全密钥，可以选择不允许。" "$DST/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :NSBluetoothPeripheralUsageDescription string 喵团沙箱浏览器：登录页可能会询问蓝牙权限，可以选择不允许。" "$DST/Contents/Info.plist"
codesign --force --deep --sign - "$DST"
codesign --verify --deep "$DST"
echo "patched: $DST"
