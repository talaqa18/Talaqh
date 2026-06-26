#!/usr/bin/env bash
# mac-build.sh — one-shot iOS build prep on a Mac (no Codemagic).
# Run from the repo root:  bash mac-build.sh
# When done, Xcode opens with App.xcworkspace ready to Archive + Upload.

set -e
cd "$(dirname "$0")"

echo "▶ 1/8  Pull latest from git"
git pull --rebase || true

echo "▶ 2/8  Install npm deps"
npm install

echo "▶ 3/8  Refresh dist/ from root  (NEVER 'npm run build' — would mangle index.html)"
npm run dist:copy

echo "▶ 4/8  Add iOS platform if missing"
if [ ! -d "ios" ]; then npx cap add ios; fi

echo "▶ 5/8  Lock to iPhone-only  (drop iPad from Targeted Device Family)"
PBXPROJ="ios/App/App.xcodeproj/project.pbxproj"
sed -i.bak 's/TARGETED_DEVICE_FAMILY = "1,2"/TARGETED_DEVICE_FAMILY = "1"/g' "$PBXPROJ"
rm -f "$PBXPROJ.bak"
echo "   TARGETED_DEVICE_FAMILY now:"
grep TARGETED_DEVICE_FAMILY "$PBXPROJ" | head -3

echo "▶ 6/8  Inject Info.plist keys  (mic permission + encryption + portrait lock)"
PLIST="ios/App/App/Info.plist"
MIC="نحتاج الميكروفون لتسجيل نطقك وتقييمه وللمحادثة الصوتية مع المعلّم."
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string $MIC" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :NSMicrophoneUsageDescription $MIC" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :ITSAppUsesNonExemptEncryption false" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :UISupportedInterfaceOrientations" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UISupportedInterfaceOrientations:0 string UIInterfaceOrientationPortrait" "$PLIST"

echo "▶ 7/8  Sync + generate icons/splash  (uses the new spark star)"
npx cap sync ios
npx @capacitor/assets generate --ios

echo "▶ 8/8  Install CocoaPods"
( cd ios/App && pod install )

echo ""
echo "✅ Done. Opening Xcode workspace…"
echo ""
echo "In Xcode:"
echo "  1. Top bar:  set target to 'Any iOS Device (arm64)'"
echo "  2. Menu:     Product → Archive"
echo "  3. Wait for the Organizer to open"
echo "  4. Click:    Distribute App → App Store Connect → Upload → follow prompts"
echo ""
open ios/App/App.xcworkspace
