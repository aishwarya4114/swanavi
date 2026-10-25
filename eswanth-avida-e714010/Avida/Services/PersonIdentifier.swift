import CoreGraphics
import Foundation
import Photos

/// Tells the owner apart from other people in photos.
///
/// iOS has no public face-identity API, so Avida builds its own reference set: face crops from the
/// Selfies album (front-camera shots are almost always the owner) plus any photo the user explicitly
/// marks as "this is me". Every detected face is compared to that set with Vision feature prints.
/// Everything stays on device.
actor PersonIdentifier {
    static let shared = PersonIdentifier()

    nonisolated static let selfDistance: Float = 0.62
    private static let maximumReferences = 32

    private var references: [FeaturePrint] = []
    private var loaded = false

    private var fileURL: URL {
        URL.applicationSupportDirectory.appending(path: "SelfFaces.plist")
    }

    /// Snapshot of reference prints plus a version string that changes whenever the set changes.
    func snapshot() -> PersonReferences {
        load()
        return PersonReferences(prints: references, version: versionString())
    }

    func referenceCount() -> Int {
        load()
        return references.count
    }

    /// Seeds the reference set from the Selfies smart album. Returns how many faces were added.
    @discardableResult
    func seedFromSelfies(limit: Int = 40) async -> Int {
        load()
        let assetIDs = await Task.detached(priority: .utility) { () -> [String] in
            let albums = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumSelfPortraits, options: nil)
            guard let album = albums.firstObject else { return [] }
            let options = PHFetchOptions()
            options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
            options.fetchLimit = limit
            var ids: [String] = []
            PHAsset.fetchAssets(in: album, options: options).enumerateObjects { asset, _, _ in
                ids.append(asset.localIdentifier)
            }
            return ids
        }.value
        var added = 0
        for assetID in assetIDs where references.count < Self.maximumReferences {
            if let print = await Self.largestFacePrint(assetID: assetID) {
                references.append(print)
                added += 1
            }
        }
        if added > 0 { persist() }
        return added
    }

    /// Adds the largest face in the given photo as a reference for the owner.
    @discardableResult
    func addSelf(assetID: String) async -> Bool {
        load()
        guard let print = await Self.largestFacePrint(assetID: assetID, minimumArea: 0.01) else { return false }
        if references.count >= Self.maximumReferences { references.removeFirst() }
        references.append(print)
        persist()
        return true
    }

    func reset() {
        references.removeAll()
        persist()
    }

    /// Classifies every face in `image` against the reference set.
    nonisolated static func classify(faces: [CGRect], in image: CGImage, references: PersonReferences) -> (selfCount: Int, otherCount: Int) {
        guard !faces.isEmpty else { return (0, 0) }
        var selfCount = 0
        var otherCount = 0
        for rect in faces {
            guard let print = PhotoAnalyzer.facePrint(for: rect, in: image) else { continue }
            if !references.prints.isEmpty, let best = references.prints.compactMap({ print.distance(to: $0) }).min(), best < selfDistance {
                selfCount += 1
            } else {
                otherCount += 1
            }
        }
        return (selfCount, otherCount)
    }

    // MARK: - Private

    private nonisolated static func largestFacePrint(assetID: String, minimumArea: CGFloat = 0.03) async -> FeaturePrint? {
        await Task.detached(priority: .utility) { () -> FeaturePrint? in
            guard let image = PhotoLibraryClient.thumbnail(assetID: assetID, side: 640) else { return nil }
            let faces = PhotoAnalyzer.detectFaces(in: image)
            guard let largest = faces.max(by: { $0.width * $0.height < $1.width * $1.height }) else { return nil }
            return PhotoAnalyzer.facePrint(for: largest, in: image, minimumArea: minimumArea)
        }.value
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let data = try? Data(contentsOf: fileURL),
              let blobs = try? PropertyListDecoder().decode([Data].self, from: data) else { return }
        references = blobs.map { FeaturePrint(data: $0) }
    }

    private func persist() {
        let blobs = references.compactMap(\.data)
        if let data = try? PropertyListEncoder().encode(blobs) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    private func versionString() -> String {
        var hasher = Hasher()
        hasher.combine(references.count)
        for print in references.prefix(8) { hasher.combine(print.data?.count ?? 0) }
        return String(hasher.finalize(), radix: 36)
    }
}

nonisolated struct PersonReferences: Sendable {
    var prints: [FeaturePrint]
    var version: String

    var isEmpty: Bool { prints.isEmpty }
}
