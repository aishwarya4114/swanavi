import SwiftData
import SwiftUI

struct PhotoGridView: View {
    var albumID: String
    var albumTitle: String

    @Query(sort: \PhotoIndex.capturedAt, order: .reverse) private var photos: [PhotoIndex]
    @State private var selected: PhotoIndex?

    private var tripPhotos: [PhotoIndex] {
        photos.filter { $0.albumID == albumID && $0.isAvailable }
    }

    private let columns = [
        GridItem(.flexible(), spacing: 6),
        GridItem(.flexible(), spacing: 6),
        GridItem(.flexible(), spacing: 6)
    ]

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(albumTitle.isEmpty ? "Your trip" : albumTitle)
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                    Text("\(tripPhotos.count.formatted()) photos in your library")
                        .font(.system(size: 15))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.bottom, 8)

                    LazyVGrid(columns: columns, spacing: 6) {
                        ForEach(tripPhotos) { photo in
                            Button {
                                selected = photo
                            } label: {
                                AssetThumbnail(assetID: photo.assetID, side: 118, cornerRadius: 8)
                                    .frame(maxWidth: .infinity)
                                    .aspectRatio(1, contentMode: .fit)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
        .sheet(item: $selected) { photo in
            PhotoDetailView(photo: photo)
        }
    }
}

struct PhotoDetailView: View {
    var photo: PhotoIndex
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            AvidaScreen {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        AssetThumbnail(assetID: photo.assetID, side: 280, cornerRadius: 16)
                            .frame(maxWidth: .infinity)
                        fact("Captured", value: photo.capturedAt?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown")
                        fact("Location", value: locationText)
                        fact("Media", value: photo.mediaType)
                        fact("Size", value: "\(photo.pixelWidth) × \(photo.pixelHeight)")
                        if photo.duration > 0 {
                            fact("Duration", value: photo.duration.formatted())
                        }
                        fact("Source", value: photo.sourceType.isEmpty ? "Library" : photo.sourceType)
                        fact("On this iPhone", value: photo.isLocallyAvailable ? "Original available" : "iCloud original not on device")
                        fact("Favorite", value: photo.isFavorite ? "Yes" : "No")
                        if let quality = photo.quality {
                            fact("Quality", value: "\(Int((quality * 100).rounded()))%")
                        }
                        fact("Relevant", value: photo.isRelevant ? "Yes" : "No")
                        if !photo.labels.isEmpty {
                            let names = photo.labels
                                .sorted { $0.confidence > $1.confidence }
                                .prefix(5)
                                .map { "\($0.name) \(Int(($0.confidence * 100).rounded()))%" }
                                .joined(separator: ", ")
                            fact("Labels", value: names)
                        }
                        fact("Asset ID", value: photo.assetID)
                    }
                    .padding(24)
                }
            }
            .navigationTitle("Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var locationText: String {
        guard let latitude = photo.latitude, let longitude = photo.longitude else {
            return "No GPS"
        }
        return String(format: "%.5f, %.5f", latitude, longitude)
    }

    private func fact(_ label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(AvidaColor.tertiary)
            Text(value)
                .font(.system(size: 16))
                .foregroundStyle(AvidaColor.ink)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
