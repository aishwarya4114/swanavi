import SwiftData
import SwiftUI

enum AppRoute: Hashable {
    case access
    case analyzing
    case review
}

private enum LaunchGate {
    static var didResolve = false
}

struct RootView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(RootView.recentPhotos) private var photos: [PhotoIndex]
    @Query private var moments: [ExperienceMoment]
    @Query private var checkpoints: [ScanCheckpoint]

    private static var recentPhotos: FetchDescriptor<PhotoIndex> {
        var descriptor = FetchDescriptor<PhotoIndex>(sortBy: [SortDescriptor(\.capturedAt, order: .reverse)])
        descriptor.fetchLimit = 3
        return descriptor
    }
    @AppStorage("avida.enteredHome") private var enteredHome = false
    @State private var path: [AppRoute] = []
    @State private var declinedAccess = false

    private var scan: LibraryScanModel { LibraryScanModel.shared }

    var body: some View {
        Group {
            if enteredHome {
                MainTabView()
            } else {
                NavigationStack(path: $path) {
                    WelcomeView(previewAssetIDs: previewIDs) {
                        path.append(.access)
                    }
                    .navigationDestination(for: AppRoute.self) { route in
                        switch route {
                        case .access:
                            PhotoAccessView(
                                previewAssetIDs: previewIDs,
                                access: scan.access,
                                onAllow: allowAccess,
                                onNotNow: { declinedAccess = true }
                            )
                            .avidaNavigation()
                        case .analyzing:
                            AnalyzingView(scan: scan) {
                                path.append(.review)
                            }
                            .avidaNavigation()
                        case .review:
                            ReviewExperiencesView {
                                enteredHome = true
                            }
                            .avidaNavigation()
                        }
                    }
                }
            }
        }
        .tint(AvidaColor.ink)
        .task {
            guard !LaunchGate.didResolve else { return }
            LaunchGate.didResolve = true
            let finished = checkpoints.first?.status == ScanStatus.completed.rawValue || !moments.isEmpty
            if finished {
                enteredHome = true
            }
        }
    }

    private var previewIDs: [String] {
        photos.map(\.assetID)
    }

    private func allowAccess() {
        Task {
            let access = await PhotoLibraryClient.requestAccess()
            scan.access = access
            guard access == .authorized || access == .limited else { return }
            scan.start()
            if path.last != .analyzing {
                path.append(.analyzing)
            }
        }
    }
}

private struct AvidaNavigation: ViewModifier {
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(AvidaColor.ink)
                    }
                }
                ToolbarItem(placement: .principal) {
                    AvidaWordmark(size: 16)
                }
            }
            .toolbarBackground(AvidaColor.background, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
    }
}

extension View {
    func avidaNavigation() -> some View {
        modifier(AvidaNavigation())
    }
}
