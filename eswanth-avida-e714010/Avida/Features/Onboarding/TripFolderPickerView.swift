import SwiftUI
import UIKit

struct TripFolderPickerView: View {
    var access: PhotoAccess
    var onSelect: (TripCollection) -> Void

    @State private var collections: [TripCollection] = []
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var visibleAccess: PhotoAccess = .notDetermined

    var body: some View {
        AvidaScreen {
            VStack(alignment: .leading, spacing: 0) {
                Text("Choose a trip")
                    .font(.system(size: 36, weight: .bold))
                    .foregroundStyle(AvidaColor.ink)
                    .padding(.top, 8)
                    .padding(.horizontal, 24)
                Text("Pick one folder or album. Avida scans only that set.")
                    .font(.system(size: 16))
                    .foregroundStyle(AvidaColor.secondary)
                    .padding(.top, 8)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)

                if visibleAccess == .limited {
                    Button(action: openSettings) {
                        Text("Full Access is required to see trip folders. Open Settings.")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AvidaColor.accent)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                }

                if isLoading && collections.isEmpty {
                    ProgressView("Loading your folders")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let loadError, collections.isEmpty {
                    Text(loadError)
                        .font(.system(size: 16))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else if collections.isEmpty {
                    Text("No albums or folders are visible. In Settings, set Photos access for Avida to Full Access, then come back.")
                        .font(.system(size: 16))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                } else {
                    List {
                        if !folders.isEmpty {
                            Section("Folders") {
                                ForEach(folders) { collection in
                                    row(collection)
                                }
                            }
                        }
                        if !albums.isEmpty {
                            Section("Albums") {
                                ForEach(albums) { collection in
                                    row(collection)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                    .scrollContentBackground(.hidden)
                }
            }
        }
        .task { await reload() }
        .refreshable { await reload() }
    }

    private var folders: [TripCollection] {
        collections.filter { $0.kind == .folder }
    }

    private var albums: [TripCollection] {
        collections.filter { $0.kind == .album }
    }

    private func row(_ collection: TripCollection) -> some View {
        Button {
            onSelect(collection)
        } label: {
            HStack(spacing: 12) {
                if let cover = collection.coverAssetID {
                    AssetThumbnail(assetID: cover, side: 56, cornerRadius: 10)
                } else {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(AvidaColor.card)
                        .frame(width: 56, height: 56)
                        .overlay {
                            Image(systemName: collection.kind == .folder ? "folder" : "photo")
                                .foregroundStyle(AvidaColor.secondary)
                        }
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(collection.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                        .lineLimit(1)
                    Text(subtitle(for: collection))
                        .font(.system(size: 14))
                        .foregroundStyle(AvidaColor.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AvidaColor.tertiary)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .listRowBackground(AvidaColor.background)
    }

    private func subtitle(for collection: TripCollection) -> String {
        let count = "\(collection.count) photo\(collection.count == 1 ? "" : "s")"
        if let container = collection.containerTitle, !container.isEmpty {
            return "In \(container) · \(count)"
        }
        let kind = collection.kind == .folder ? "Folder" : "Album"
        return "\(kind) · \(count)"
    }

    private func reload() async {
        isLoading = collections.isEmpty
        loadError = nil
        let current = PhotoLibraryClient.currentAccess()
        visibleAccess = current
        guard current == .authorized || current == .limited else {
            loadError = "Photo access is required before Avida can list your trip folders."
            isLoading = false
            return
        }
        collections = await PhotoLibraryClient.listTripCollections()
        isLoading = false
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
