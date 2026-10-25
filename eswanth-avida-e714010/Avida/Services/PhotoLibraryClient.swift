import CoreGraphics
import Foundation
import Photos
import UIKit

nonisolated enum PhotoLibraryClient {
    static func currentAccess() -> PhotoAccess {
        map(PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    static func requestAccess() async -> PhotoAccess {
        let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return map(status)
    }

    static func listTripCollections() async -> [TripCollection] {
        await MainActor.run {
            loadCollections()
        }
    }

    static func fetchLibraryMetadata() async -> [IndexedPhoto] {
        await Task.detached(priority: .userInitiated) {
            var photos: [IndexedPhoto] = []
            let result = PHAsset.fetchAssets(with: .image, options: recentFirst())
            photos.reserveCapacity(result.count)
            result.enumerateObjects { asset, _, _ in
                photos.append(metadata(for: asset))
            }
            return photos
        }.value
    }

    static func thumbnail(assetID: String, side: CGFloat) -> CGImage? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else {
            return nil
        }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        options.isSynchronous = true
        var image: CGImage?
        PHImageManager.default().requestImage(
            for: asset,
            targetSize: CGSize(width: side, height: side),
            contentMode: .aspectFill,
            options: options
        ) { result, _ in
            image = result?.cgImage
        }
        return image
    }

    static func fetchMetadata(in collection: TripCollection) async -> [IndexedPhoto] {
        await Task.detached(priority: .userInitiated) {
            loadMetadata(in: collection)
        }.value
    }

    private static func map(_ status: PHAuthorizationStatus) -> PhotoAccess {
        switch status {
        case .notDetermined: .notDetermined
        case .restricted: .restricted
        case .denied: .denied
        case .limited: .limited
        case .authorized: .authorized
        @unknown default: .denied
        }
    }

    private static func loadCollections() -> [TripCollection] {
        var folderTitleByAlbumID: [String: String] = [:]
        var collections: [TripCollection] = []
        var seen = Set<String>()

        let folders = PHCollectionList.fetchCollectionLists(with: .folder, subtype: .any, options: nil)
        folders.enumerateObjects { folder, _, _ in
            guard seen.insert(folder.localIdentifier).inserted else { return }
            let summary = folderSummary(folder)
            folderTitleByAlbumID.merge(summary.albumTitles) { _, new in new }
            collections.append(
                TripCollection(
                    id: folder.localIdentifier,
                    title: folder.localizedTitle ?? "Untitled folder",
                    containerTitle: nil,
                    count: summary.count,
                    kind: .folder,
                    coverAssetID: summary.coverAssetID
                )
            )
        }

        let albums = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        albums.enumerateObjects { album, _, _ in
            guard seen.insert(album.localIdentifier).inserted else { return }
            let summary = albumSummary(album)
            collections.append(
                TripCollection(
                    id: album.localIdentifier,
                    title: album.localizedTitle ?? "Untitled album",
                    containerTitle: folderTitleByAlbumID[album.localIdentifier],
                    count: summary.count,
                    kind: .album,
                    coverAssetID: summary.coverAssetID
                )
            )
        }

        return collections.sorted { lhs, rhs in
            if lhs.kind != rhs.kind { return lhs.kind == .folder }
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }
    }

    private static func folderSummary(_ folder: PHCollectionList) -> (count: Int, coverAssetID: String?, albumTitles: [String: String]) {
        var count = 0
        var cover: String?
        var albumTitles: [String: String] = [:]
        let title = folder.localizedTitle
        let children = PHCollection.fetchCollections(in: folder, options: nil)
        children.enumerateObjects { child, _, _ in
            if let album = child as? PHAssetCollection {
                let summary = albumSummary(album)
                count += summary.count
                if cover == nil { cover = summary.coverAssetID }
                albumTitles[album.localIdentifier] = title
            } else if let nested = child as? PHCollectionList {
                let summary = folderSummary(nested)
                count += summary.count
                if cover == nil { cover = summary.coverAssetID }
                albumTitles.merge(summary.albumTitles) { _, new in new }
            }
        }
        return (count, cover, albumTitles)
    }

    private static func albumSummary(_ album: PHAssetCollection) -> (count: Int, coverAssetID: String?) {
        let count = PHAsset.fetchAssets(in: album, options: nil).count
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = 1
        let cover = PHAsset.fetchAssets(in: album, options: options).firstObject?.localIdentifier
        return (count, cover)
    }

    private static func loadMetadata(in collection: TripCollection) -> [IndexedPhoto] {
        let assets = assets(for: collection)
        var seen = Set<String>()
        var photos: [IndexedPhoto] = []
        photos.reserveCapacity(assets.count)
        for asset in assets where seen.insert(asset.localIdentifier).inserted {
            photos.append(metadata(for: asset))
        }
        return photos
    }

    private static func assets(for collection: TripCollection) -> [PHAsset] {
        switch collection.kind {
        case .album:
            guard let album = fetchAlbum(collection.id) else { return [] }
            return assets(in: album)
        case .folder:
            guard let folder = fetchFolder(collection.id) else { return [] }
            return assets(inFolder: folder)
        }
    }

    private static func fetchAlbum(_ identifier: String) -> PHAssetCollection? {
        PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [identifier], options: nil).firstObject
    }

    private static func fetchFolder(_ identifier: String) -> PHCollectionList? {
        PHCollectionList.fetchCollectionLists(withLocalIdentifiers: [identifier], options: nil).firstObject
    }

    private static func assets(in album: PHAssetCollection) -> [PHAsset] {
        var items: [PHAsset] = []
        let result = PHAsset.fetchAssets(in: album, options: recentFirst())
        result.enumerateObjects { asset, _, _ in
            items.append(asset)
        }
        return items
    }

    private static func assets(inFolder folder: PHCollectionList) -> [PHAsset] {
        var items: [PHAsset] = []
        let children = PHCollection.fetchCollections(in: folder, options: nil)
        children.enumerateObjects { child, _, _ in
            if let album = child as? PHAssetCollection {
                items.append(contentsOf: assets(in: album))
            } else if let nested = child as? PHCollectionList {
                items.append(contentsOf: assets(inFolder: nested))
            }
        }
        items.sort { ($0.creationDate ?? .distantPast) > ($1.creationDate ?? .distantPast) }
        return items
    }

    private static func recentFirst() -> PHFetchOptions {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return options
    }

    private static func metadata(for asset: PHAsset) -> IndexedPhoto {
        IndexedPhoto(
            assetID: asset.localIdentifier,
            capturedAt: asset.creationDate,
            modificationDate: asset.modificationDate,
            latitude: asset.location?.coordinate.latitude,
            longitude: asset.location?.coordinate.longitude,
            mediaType: mediaName(asset.mediaType),
            pixelWidth: asset.pixelWidth,
            pixelHeight: asset.pixelHeight,
            duration: asset.duration,
            isFavorite: asset.isFavorite,
            sourceType: sourceName(asset.sourceType),
            isHidden: asset.isHidden,
            burstIdentifier: asset.burstIdentifier,
            isLocallyAvailable: locallyAvailable(asset),
            isScreenshot: asset.mediaSubtypes.contains(.photoScreenshot)
        )
    }

    private static func mediaName(_ type: PHAssetMediaType) -> String {
        switch type {
        case .image: "image"
        case .video: "video"
        case .audio: "audio"
        case .unknown: "unknown"
        @unknown default: "unknown"
        }
    }

    private static func sourceName(_ source: PHAssetSourceType) -> String {
        var parts: [String] = []
        if source.contains(.typeUserLibrary) { parts.append("library") }
        if source.contains(.typeCloudShared) { parts.append("shared") }
        if source.contains(.typeiTunesSynced) { parts.append("synced") }
        return parts.joined(separator: ",")
    }

    private static func locallyAvailable(_ asset: PHAsset) -> Bool {
        let resources = PHAssetResource.assetResources(for: asset)
        guard !resources.isEmpty else { return false }
        return resources.allSatisfy { resource in
            (resource.value(forKey: "locallyAvailable") as? Bool) ?? true
        }
    }
}
