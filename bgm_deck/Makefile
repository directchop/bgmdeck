
.PHONY: bundle set-build-number codesign verify-sign zip notarize staple bundle-signed open install-bundler

APP_NAME := BGM Deck
APP_PATH := target/release/bundle/osx/$(APP_NAME).app
BIN_PATH := $(APP_PATH)/Contents/MacOS/bgm_deck
APP_ZIP  := target/release/$(APP_NAME).zip

# Build a macOS .app using cargo-bundle
bundle:
	cargo bundle --release

# Optionally set CFBundleVersion from BUILD_NUMBER env var
set-build-number:
	@if [ -n "$(BUILD_NUMBER)" ] && [ -f "$(APP_PATH)/Contents/Info.plist" ]; then \
		echo "Setting CFBundleVersion=$(BUILD_NUMBER)"; \
		/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(BUILD_NUMBER)" "$(APP_PATH)/Contents/Info.plist" || true; \
	fi

# Codesign the app; requires DEVELOPER_ID_APP set (e.g. "Developer ID Application: Your Name (TEAMID)")
codesign:
	@if [ -z "$(DEVELOPER_ID_APP)" ]; then echo "Set DEVELOPER_ID_APP to your Developer ID Application identity"; exit 1; fi
	# Sign the main binary first
	codesign --force --timestamp --options runtime -s "$(DEVELOPER_ID_APP)" "$(BIN_PATH)"
	# Then sign the app bundle
	codesign --force --timestamp --options runtime -s "$(DEVELOPER_ID_APP)" "$(APP_PATH)"

verify-sign:
	codesign --verify --deep --strict --verbose=2 "$(APP_PATH)"

zip:
	ditto -c -k --keepParent "$(APP_PATH)" "$(APP_ZIP)"

# Notarize using a stored notarytool profile (set NOTARY_PROFILE via `xcrun notarytool store-credentials`)
notarize:
	@if [ -z "$(NOTARY_PROFILE)" ]; then echo "Set NOTARY_PROFILE (created by 'xcrun notarytool store-credentials')"; exit 1; fi
	xcrun notarytool submit "$(APP_ZIP)" --keychain-profile "$(NOTARY_PROFILE)" --wait

staple:
	xcrun stapler staple "$(APP_PATH)"

# Full pipeline: build, set build number, sign, verify, zip, notarize, staple
bundle-signed: bundle set-build-number codesign verify-sign zip notarize staple

# Open the built .app in Finder
open:
	open "$(APP_PATH)"

# Install cargo-bundle if not present
install-bundler:
	cargo install cargo-bundle
