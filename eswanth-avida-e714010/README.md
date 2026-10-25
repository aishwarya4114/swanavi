# Avida iOS app

Teammate-provided SwiftUI/SwiftData photo-experience app. This is a standalone
prototype; it does not yet call the Swanavi payment API or AgentCore. Social and
publishing screens include local/demo behavior.

Open `Avida.xcodeproj` on a Mac with an Xcode/iOS SDK that supports the project's
iOS 27.0 deployment target. Select your own signing team for device builds, then
build and run the Avida target. Run the AvidaTests and AvidaUITests targets in
Xcode. Device photo access and background scanning need device validation.

The source was reviewed before import, but no Xcode build or iOS tests could be
run in the Windows workspace. No embedded credentials were found by the source
scan. The checked-in development-team identifier is a signing configuration
identifier, not a credential.

Import corrections:

- A failed SwiftData initialization preserves the database and journal files.
  Startup still stops with an error; a user-facing recovery flow remains future
  work. Do not delete user data to work around migration failures.
- The photo permission text describes scanning all authorized photos, including
  the full library when full access is granted.
