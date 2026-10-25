import SwiftData
import SwiftUI

@main
struct AvidaApp: App {
    @Environment(\.scenePhase) private var scenePhase

    let sharedModelContainer: ModelContainer

    init() {
        let schema = Schema([
            PhotoIndex.self,
            PhotoLabel.self,
            ExperienceMoment.self,
            TripRecord.self,
            ExperienceDraft.self,
            ScanCheckpoint.self,
            HomeBase.self,
            Post.self
        ])
        let support = URL.applicationSupportDirectory
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let storeURL = support.appending(path: "AvidaLibrary.store")
        let configuration = ModelConfiguration(schema: schema, url: storeURL)
        do {
            sharedModelContainer = try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            // A migration or temporary access failure must never erase user data.
            // Preserve the store and its journal files for recovery.
            fatalError("Could not open ModelContainer; existing data was preserved: \(error)")
        }
        LibraryScanModel.shared.configure(container: sharedModelContainer)
        BackgroundScanCoordinator.shared.register()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        .modelContainer(sharedModelContainer)
        .onChange(of: scenePhase) { _, phase in
            LibraryScanModel.shared.handleScenePhase(phase)
        }
    }
}
