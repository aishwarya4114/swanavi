import CoreImage
import Foundation
import Vision

nonisolated struct AnalyzedLabel: Sendable, Equatable {
    var name: String
    var confidence: Double
}

nonisolated struct PhotoAnalysis: Sendable {
    var labels: [AnalyzedLabel]
    var quality: Double
    var faceCount: Int
    /// Normalized face rectangles (Vision coordinates, origin bottom-left).
    var faceRects: [CGRect]
    var containsPerson: Bool
    var containsAnimal: Bool
    var featurePrint: FeaturePrint?
    var selfFaceCount = 0
    var otherFaceCount = 0
}

/// An immutable Vision feature print that can be compared without re-decoding it every time.
nonisolated final class FeaturePrint: @unchecked Sendable {
    private let stored: Data?
    private var cached: VNFeaturePrintObservation?

    init(observation: VNFeaturePrintObservation) {
        cached = observation
        stored = nil
    }

    init(data: Data) {
        stored = data
        cached = nil
    }

    var observation: VNFeaturePrintObservation? {
        if let cached { return cached }
        guard let stored else { return nil }
        let decoded = try? NSKeyedUnarchiver.unarchivedObject(ofClass: VNFeaturePrintObservation.self, from: stored)
        cached = decoded
        return decoded
    }

    var data: Data? {
        if let stored { return stored }
        guard let cached else { return nil }
        return try? NSKeyedArchiver.archivedData(withRootObject: cached, requiringSecureCoding: true)
    }

    func distance(to other: FeaturePrint) -> Float? {
        guard let a = observation, let b = other.observation else { return nil }
        var distance: Float = 1
        guard (try? a.computeDistance(&distance, to: b)) != nil else { return nil }
        return distance
    }
}

nonisolated struct FeaturePrintStamp: Sendable {
    var assetID: String
    var capturedAt: Date?
    var print: FeaturePrint
}

nonisolated enum PhotoAnalyzer {
    private static let personWords = ["person", "people", "face", "portrait", "human", "man", "woman", "child", "boy", "girl", "crowd", "selfie", "adult", "baby"]
    private static let documentWords = ["document", "paper", "receipt", "newspaper", "letter", "menu", "whiteboard", "screenshot", "computer", "monitor", "screen", "text", "qr", "barcode", "ticket", "card", "poster", "sign", "book", "magazine", "map", "diagram", "chart", "keyboard", "laptop", "phone"]
    private static let genericLabels: Set<String> = [
        "outdoor", "indoor", "sky", "plant", "structure", "people", "adult", "land", "water", "nature", "cloud", "daytime",
        "material", "object", "vehicle", "person", "human", "tree", "grass", "wood", "floor", "wall", "ceiling", "furniture",
        "light", "dark", "room", "interior", "exterior", "equipment", "tool", "clothing", "hand", "arm", "leg", "foot", "face", "head",
        "machine", "device", "container", "surface", "ground", "field", "space", "pattern", "shape", "color", "line", "art"
    ]
    private static let duplicateDistance: Float = 0.28
    private static let duplicateWindow: TimeInterval = 12 * 60

    static func analyze(image: CGImage, capturedAt: Date?, recentPrints: [FeaturePrintStamp]) -> (PhotoAnalysis, duplicateOf: String?) {
        let analysis = analyze(image: image)
        return (analysis, duplicateMatch(analysis.featurePrint, capturedAt: capturedAt, recentPrints: recentPrints))
    }

    /// Runs every Vision request for one photo. Safe to call from several threads at once.
    static func analyze(image: CGImage) -> PhotoAnalysis {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let classify = VNClassifyImageRequest()
        let faces = VNDetectFaceRectanglesRequest()
        let humans = VNDetectHumanRectanglesRequest()
        humans.upperBodyOnly = true
        let animals = VNRecognizeAnimalsRequest()
        let feature = VNGenerateImageFeaturePrintRequest()
        try? handler.perform([classify, faces, humans, animals, feature])

        let rawLabels = (classify.results ?? [])
            .filter { $0.confidence > 0.08 }
            .prefix(14)
            .map { AnalyzedLabel(name: $0.identifier, confidence: Double($0.confidence)) }
        let labels = Array(rawLabels.prefix(10))
        let faceRects = (faces.results ?? []).map(\.boundingBox)
        let faceCount = faceRects.count
        let humanCount = humans.results?.filter { $0.confidence > 0.5 }.count ?? 0
        let containsPerson = faceCount > 0 || humanCount > 0 || labels.contains { label in
            label.confidence > 0.45 && personWords.contains { label.name.lowercased().contains($0) }
        }
        let containsAnimal = (animals.results?.contains { $0.confidence > 0.6 } ?? false)
        let print = feature.results?.first.map { FeaturePrint(observation: $0) }
        let exposureScore = exposure(image)
        let quality = min(1, (sharpness(image) * 0.6) + (exposureScore * 0.4))
        return PhotoAnalysis(
            labels: labels,
            quality: quality,
            faceCount: faceCount,
            faceRects: faceRects,
            containsPerson: containsPerson,
            containsAnimal: containsAnimal,
            featurePrint: print
        )
    }

    /// Face rectangles only (used for the incremental people pass).
    static func detectFaces(in image: CGImage) -> [CGRect] {
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let faces = VNDetectFaceRectanglesRequest()
        try? handler.perform([faces])
        return (faces.results ?? []).map(\.boundingBox)
    }

    /// Crops a face (with some margin) and returns its feature print, or nil when the face is too small to be useful.
    static func facePrint(for rect: CGRect, in image: CGImage, minimumArea: CGFloat = 0.012) -> FeaturePrint? {
        guard rect.width * rect.height >= minimumArea else { return nil }
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let expanded = rect.insetBy(dx: -rect.width * 0.3, dy: -rect.height * 0.35)
        let pixelRect = CGRect(
            x: max(0, expanded.minX * width),
            y: max(0, (1 - expanded.maxY) * height),
            width: min(width, expanded.width * width),
            height: min(height, expanded.height * height)
        ).integral
        guard pixelRect.width > 24, pixelRect.height > 24, let crop = image.cropping(to: pixelRect) else { return nil }
        let handler = VNImageRequestHandler(cgImage: crop, options: [:])
        let request = VNGenerateImageFeaturePrintRequest()
        try? handler.perform([request])
        return request.results?.first.map { FeaturePrint(observation: $0) }
    }

    static func duplicateMatch(_ print: FeaturePrint?, capturedAt: Date?, recentPrints: [FeaturePrintStamp]) -> String? {
        guard let print else { return nil }
        for stamp in recentPrints.reversed() {
            if let capturedAt, let other = stamp.capturedAt, abs(capturedAt.timeIntervalSince(other)) > duplicateWindow {
                continue
            }
            guard let distance = print.distance(to: stamp.print) else { continue }
            if distance < duplicateDistance {
                return stamp.assetID
            }
        }
        return nil
    }

    static func isRelevant(isScreenshot: Bool, isDuplicate: Bool, quality: Double, labels: [AnalyzedLabel], containsPerson: Bool) -> Bool {
        if isScreenshot || isDuplicate || quality < 0.2 { return false }
        let documentScore = labels.reduce(0.0) { partial, label in
            let name = label.name.lowercased()
            return documentWords.contains { name.contains($0) } ? partial + label.confidence : partial
        }
        if documentScore > 0.9 && !containsPerson { return false }
        return true
    }

    static func descriptiveLabels(_ labels: [AnalyzedLabel]) -> [String] {
        labels
            .filter { !genericLabels.contains($0.name.lowercased()) && $0.confidence > 0.2 }
            .map(\.name)
    }

    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    private static func sharpness(_ image: CGImage) -> Double {
        let source = CIImage(cgImage: image)
        guard let edges = CIFilter(name: "CIEdges", parameters: [
            kCIInputImageKey: source,
            kCIInputIntensityKey: 2.0
        ])?.outputImage else { return 0.4 }
        return averageRed(edges, scale: 44)
    }

    private static func exposure(_ image: CGImage) -> Double {
        let source = CIImage(cgImage: image)
        let brightness = averageRed(source, scale: 255)
        if brightness < 0.08 || brightness > 0.96 { return 0.2 }
        if brightness < 0.18 || brightness > 0.9 { return 0.6 }
        return 1
    }

    private static func averageRed(_ image: CIImage, scale: Double) -> Double {
        let extent = image.extent.integral
        guard extent.width > 1, extent.height > 1,
              let average = CIFilter(name: "CIAreaAverage", parameters: [
                kCIInputImageKey: image,
                kCIInputExtentKey: CIVector(cgRect: extent)
              ])?.outputImage else { return 0.4 }
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(
            average,
            toBitmap: &pixel,
            rowBytes: 4,
            bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
            format: .RGBA8,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return min(1, Double(pixel[0]) / scale)
    }
}
