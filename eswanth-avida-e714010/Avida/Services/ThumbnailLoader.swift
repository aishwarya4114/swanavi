import Photos
import UIKit

/// Decodes thumbnails off the main thread and keeps a bounded in-memory cache so lists scroll without
/// re-requesting PhotoKit for images that were just on screen.
actor ThumbnailLoader {
    static let shared = ThumbnailLoader()

    private let manager = PHCachingImageManager()
    private var cache: [String: UIImage] = [:]
    private var order: [String] = []
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private let limit = 900

    func image(assetID: String, pixelSide: CGFloat) async -> UIImage? {
        let bucket = Self.bucket(pixelSide)
        let key = "\(assetID)|\(bucket)"
        if let cached = cache[key] {
            return cached
        }
        if let running = inFlight[key] {
            return await running.value
        }
        let task = Task<UIImage?, Never> { [manager] in
            guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else {
                return nil
            }
            return await Self.request(manager: manager, asset: asset, side: CGFloat(bucket))
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image {
            store(image, for: key)
        }
        return image
    }

    private func store(_ image: UIImage, for key: String) {
        if cache[key] == nil { order.append(key) }
        cache[key] = image
        while order.count > limit, let oldest = order.first {
            order.removeFirst()
            cache[oldest] = nil
        }
    }

    /// Snap requested sizes to a few buckets so the same decoded image serves many slightly different frames.
    private static func bucket(_ pixelSide: CGFloat) -> Int {
        switch pixelSide {
        case ..<200: return 180
        case ..<360: return 360
        case ..<640: return 640
        default: return 1200
        }
    }

    private static func request(manager: PHCachingImageManager, asset: PHAsset, side: CGFloat) async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.deliveryMode = .highQualityFormat
            options.resizeMode = .fast
            options.isNetworkAccessAllowed = false
            options.isSynchronous = false
            nonisolated(unsafe) var resumed = false
            manager.requestImage(
                for: asset,
                targetSize: CGSize(width: side, height: side),
                contentMode: .aspectFill,
                options: options
            ) { image, info in
                let cancelled = (info?[PHImageCancelledKey] as? Bool) ?? false
                if resumed || cancelled { return }
                resumed = true
                continuation.resume(returning: image)
            }
        }
    }
}
