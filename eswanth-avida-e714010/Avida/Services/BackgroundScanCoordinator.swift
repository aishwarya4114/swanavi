import BackgroundTasks
import Foundation

/// Lets analysis keep going when Avida is not on screen.
///
/// Two mechanisms are combined:
/// * A continued-processing task is submitted whenever the user starts a scan, so the work the user began
///   in the foreground keeps running after they leave the app (iOS shows its progress in the system UI).
/// * A processing task is scheduled for later so new photos get analyzed while the device is idle, even
///   if the app has not been opened.
@MainActor
final class BackgroundScanCoordinator {
    static let shared = BackgroundScanCoordinator()

    nonisolated static let continuedIdentifier = "com.eswanth.Avida.scan.continued"
    nonisolated static let refreshIdentifier = "com.eswanth.Avida.scan.refresh"

    private var registered = false
    private var continuationGranted = false

    func register() {
        guard !registered else { return }
        registered = true
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.continuedIdentifier, using: nil) { task in
            Task { @MainActor in
                guard let task = task as? BGContinuedProcessingTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                BackgroundScanCoordinator.shared.handleContinued(task)
            }
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshIdentifier, using: nil) { task in
            Task { @MainActor in
                guard let task = task as? BGProcessingTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                BackgroundScanCoordinator.shared.handleRefresh(task)
            }
        }
    }

    /// Ask the system to let the current scan continue after the app leaves the foreground.
    func requestContinuation() {
        let request = BGContinuedProcessingTaskRequest(
            identifier: Self.continuedIdentifier,
            title: "Analyzing your photos",
            subtitle: "Avida is finding your life experiences"
        )
        request.strategy = .fail
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            continuationGranted = false
        }
    }

    /// Schedule a later, system-chosen window to pick up new photos.
    func scheduleRefresh() {
        BGTaskScheduler.shared.getPendingTaskRequests { requests in
            guard !requests.contains(where: { $0.identifier == Self.refreshIdentifier }) else { return }
            let request = BGProcessingTaskRequest(identifier: Self.refreshIdentifier)
            request.requiresNetworkConnectivity = false
            request.requiresExternalPower = false
            request.earliestBeginDate = Date(timeIntervalSinceNow: 2 * 3600)
            try? BGTaskScheduler.shared.submit(request)
        }
    }

    private func handleContinued(_ task: BGContinuedProcessingTask) {
        continuationGranted = true
        let scan = LibraryScanModel.shared
        task.progress.totalUnitCount = 1000
        task.progress.completedUnitCount = Int64(scan.progress * 1000)
        guard scan.isRunning else {
            task.setTaskCompleted(success: true)
            return
        }
        task.expirationHandler = {
            Task { @MainActor in
                LibraryScanModel.shared.cancel()
            }
        }
        scan.completionHandlers.append { success in
            task.progress.completedUnitCount = task.progress.totalUnitCount
            task.setTaskCompleted(success: success)
        }
        observeProgress(for: task, scan: scan)
    }

    private func observeProgress(for task: BGContinuedProcessingTask, scan: LibraryScanModel) {
        Task { @MainActor in
            while scan.isRunning {
                task.progress.completedUnitCount = Int64(scan.progress * 1000)
                let remaining = scan.total - scan.processed
                task.updateTitle("Analyzing your photos", subtitle: remaining > 0 ? "\(remaining.formatted()) photos left" : "Finishing up")
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func handleRefresh(_ task: BGProcessingTask) {
        let scan = LibraryScanModel.shared
        if !scan.isRunning {
            scan.access = PhotoLibraryClient.currentAccess()
            guard scan.access == .authorized || scan.access == .limited else {
                task.setTaskCompleted(success: false)
                return
            }
            scan.start()
        }
        task.expirationHandler = {
            Task { @MainActor in
                LibraryScanModel.shared.cancel()
            }
        }
        scan.completionHandlers.append { success in
            task.setTaskCompleted(success: success)
        }
    }
}
