import Foundation
import SwiftData
import SwiftUI

/// Main-actor façade over `ScanEngine`. Views observe this; all heavy work happens in the engine.
@MainActor
@Observable
final class LibraryScanModel {
    static let shared = LibraryScanModel()

    var progress = 0.0
    var processed = 0
    var total = 0
    var unchanged = 0
    var analyzed = 0
    var pendingAnalysis = 0
    var status: ScanStatus = .idle
    var errorMessage: String?
    var thumbnailAssetIDs: [String] = []
    var placeCount = 0
    var peopleCount = 0
    var periodCount = 0
    var experienceCount = 0
    var homes: [HomeEstimate] = []
    var access: PhotoAccess = PhotoLibraryClient.currentAccess()
    var startedAt: Date?
    var finishedAt: Date?

    /// Called once per run with `true` when the scan completed and `false` when it was interrupted.
    var completionHandlers: [(Bool) -> Void] = []

    private var container: ModelContainer?
    private var scanTask: Task<Void, Never>?
    private var backgroundAssertion: UIBackgroundTaskIdentifier = .invalid

    var isRunning: Bool { status == .running }

    var estimatedRemaining: TimeInterval? {
        guard status == .running, let startedAt, analyzed >= 8 else { return nil }
        let perPhoto = Date.now.timeIntervalSince(startedAt) / Double(analyzed)
        let remaining = max(0, pendingAnalysis - analyzed)
        return perPhoto * Double(remaining)
    }

    func configure(container: ModelContainer) {
        self.container = container
    }

    func start() {
        guard let container, status != .running else { return }
        scanTask?.cancel()
        status = .running
        errorMessage = nil
        progress = 0
        processed = 0
        unchanged = 0
        analyzed = 0
        pendingAnalysis = 0
        startedAt = .now
        finishedAt = nil
        let engine = ScanEngine(container: container)
        let access = access
        BackgroundScanCoordinator.shared.requestContinuation()
        let report: @Sendable (ScanSnapshot) -> Void = { snapshot in
            Task { @MainActor in LibraryScanModel.shared.apply(snapshot) }
        }
        scanTask = Task {
            await engine.run(access: access, report: report)
            LibraryScanModel.shared.finish()
        }
    }

    func cancel() {
        scanTask?.cancel()
    }

    /// Keeps the scan alive for the short grace period iOS grants when the app leaves the foreground, in
    /// case the continued-processing task was not granted.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            guard status == .running, backgroundAssertion == .invalid else { return }
            backgroundAssertion = UIApplication.shared.beginBackgroundTask(withName: "avida.scan") { [weak self] in
                self?.endAssertion()
            }
            BackgroundScanCoordinator.shared.scheduleRefresh()
        case .active:
            endAssertion()
        default:
            break
        }
    }

    private func apply(_ snapshot: ScanSnapshot) {
        progress = snapshot.progress
        processed = snapshot.processed
        total = snapshot.total
        unchanged = snapshot.unchanged
        analyzed = snapshot.analyzed
        pendingAnalysis = snapshot.pendingAnalysis
        placeCount = snapshot.placeCount
        peopleCount = snapshot.peopleCount
        periodCount = snapshot.periodCount
        experienceCount = snapshot.experienceCount
        if !snapshot.thumbnailAssetIDs.isEmpty { thumbnailAssetIDs = snapshot.thumbnailAssetIDs }
        if !snapshot.homes.isEmpty { homes = snapshot.homes }
        errorMessage = snapshot.errorMessage
        if snapshot.status != .idle { status = snapshot.status }
    }

    private func finish() {
        if status == .running { status = .interrupted }
        finishedAt = .now
        endAssertion()
        let success = status == .completed
        let handlers = completionHandlers
        completionHandlers.removeAll()
        for handler in handlers { handler(success) }
        BackgroundScanCoordinator.shared.scheduleRefresh()
    }

    private func endAssertion() {
        guard backgroundAssertion != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundAssertion)
        backgroundAssertion = .invalid
    }
}
