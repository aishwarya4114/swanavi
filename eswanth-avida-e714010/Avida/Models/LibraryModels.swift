import Foundation
import SwiftData

@Model
final class PhotoIndex {
    @Attribute(.unique) var assetID: String
    var albumID: String
    var capturedAt: Date?
    var modificationDate: Date?
    var latitude: Double?
    var longitude: Double?
    var mediaType: String
    var pixelWidth: Int
    var pixelHeight: Int
    var duration: Double
    var isFavorite: Bool
    var sourceType: String
    var isHidden: Bool
    var burstIdentifier: String?
    var isLocallyAvailable: Bool
    var quality: Double?
    var modelVersion: String
    var lastSeen: Date
    var isAvailable: Bool
    var faceCount: Int
    var containsPerson: Bool
    var isDuplicate: Bool
    var isRelevant: Bool
    var duplicateOfAssetID: String?
    /// Descriptive labels (generic words removed), best first, joined by "|". Lets clustering avoid loading `labels`.
    var labelSummary: String = ""
    /// Faces matched to the owner / to other people, and the identity model version used.
    var selfFaceCount: Int = 0
    var otherFaceCount: Int = 0
    var peopleVersion: String = ""
    @Attribute(.externalStorage) var featurePrintData: Data?
    @Relationship(deleteRule: .cascade, inverse: \PhotoLabel.photo)
    var labels: [PhotoLabel]

    init(
        assetID: String,
        albumID: String,
        capturedAt: Date?,
        modificationDate: Date?,
        latitude: Double?,
        longitude: Double?,
        mediaType: String,
        pixelWidth: Int,
        pixelHeight: Int,
        duration: Double,
        isFavorite: Bool,
        sourceType: String,
        isHidden: Bool,
        burstIdentifier: String?,
        isLocallyAvailable: Bool,
        modelVersion: String,
        lastSeen: Date
    ) {
        self.assetID = assetID
        self.albumID = albumID
        self.capturedAt = capturedAt
        self.modificationDate = modificationDate
        self.latitude = latitude
        self.longitude = longitude
        self.mediaType = mediaType
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.duration = duration
        self.isFavorite = isFavorite
        self.sourceType = sourceType
        self.isHidden = isHidden
        self.burstIdentifier = burstIdentifier
        self.isLocallyAvailable = isLocallyAvailable
        self.quality = nil
        self.modelVersion = modelVersion
        self.lastSeen = lastSeen
        self.isAvailable = true
        self.faceCount = 0
        self.containsPerson = false
        self.isDuplicate = false
        self.isRelevant = false
        self.duplicateOfAssetID = nil
        self.featurePrintData = nil
        self.labels = []
    }
}

@Model
final class PhotoLabel {
    var name: String
    var confidence: Double
    var photo: PhotoIndex?

    init(name: String, confidence: Double) {
        self.name = name
        self.confidence = confidence
    }
}

@Model
final class ExperienceMoment {
    var id: UUID
    var key: String = ""
    var photoIDs: [String]
    var startDate: Date?
    var endDate: Date?
    var region: String?
    var confidence: Double
    var latitude: Double?
    var longitude: Double?
    var distanceFromHomeKM: Double?
    var topLabels: [String] = []
    var hasPeople: Bool = false
    var peopleCount: Int = 0
    var favoriteCount: Int = 0
    var momentCount: Int = 1
    var visitIndex: Int = 1
    var visitTotal: Int = 1
    var averageQuality: Double = 0
    var homeKey: String?
    var tripKey: String?
    var updatedAt: Date = Date.now
    /// Photos in which the owner appears, and photos in which someone else appears.
    var selfPhotoIDs: [String] = []
    var othersPhotoIDs: [String] = []
    var trip: TripRecord?

    init(photoIDs: [String] = [], startDate: Date? = nil, endDate: Date? = nil, region: String? = nil, confidence: Double = 0) {
        self.id = UUID()
        self.photoIDs = photoIDs
        self.startDate = startDate
        self.endDate = endDate
        self.region = region
        self.confidence = confidence
    }
}

/// Something the owner chose to share from an experience. Stored locally; a remote publisher can sync it later.
@Model
final class Post {
    var id: UUID = UUID()
    var experienceKey: String = ""
    var title: String = ""
    var caption: String = ""
    var placeName: String = ""
    var photoIDs: [String] = []
    var coverAssetID: String?
    var peopleScope: String = PeopleScope.everyone.rawValue
    var visibility: String = PostVisibility.onlyMe.rawValue
    var createdAt: Date = Date.now
    var status: String = "local"

    init() {}
}

nonisolated enum PeopleScope: String, CaseIterable, Sendable, Identifiable {
    case everyone
    case justMe

    var id: String { rawValue }
    var title: String {
        switch self {
        case .everyone: "Everyone"
        case .justMe: "Just me"
        }
    }
}

nonisolated enum PostVisibility: String, CaseIterable, Sendable, Identifiable {
    case onlyMe
    case friends
    case everyone

    var id: String { rawValue }
    var title: String {
        switch self {
        case .onlyMe: "Only me"
        case .friends: "Friends"
        case .everyone: "Everyone"
        }
    }
    var symbol: String {
        switch self {
        case .onlyMe: "lock"
        case .friends: "person.2"
        case .everyone: "globe"
        }
    }
}

/// A place the person lived for a stretch of time, inferred from where photos cluster on ordinary days.
@Model
final class HomeBase {
    var key: String = ""
    var latitude: Double = 0
    var longitude: Double = 0
    var startDate: Date = Date.distantPast
    var endDate: Date = Date.distantFuture
    var dayCount: Int = 0
    var isCurrent: Bool = false

    init() {}
}

@Model
final class TripRecord {
    var id: UUID
    var title: String
    var photoIDs: [String]
    var startDate: Date?
    var endDate: Date?
    var region: String?
    var confidence: Double
    @Relationship(deleteRule: .cascade, inverse: \ExperienceMoment.trip)
    var moments: [ExperienceMoment]

    init(title: String, photoIDs: [String] = [], startDate: Date? = nil, endDate: Date? = nil, region: String? = nil, confidence: Double = 0) {
        self.id = UUID()
        self.title = title
        self.photoIDs = photoIDs
        self.startDate = startDate
        self.endDate = endDate
        self.region = region
        self.confidence = confidence
        self.moments = []
    }
}

@Model
final class ExperienceDraft {
    var id: UUID
    var momentIDs: [String]
    var momentKey: String = ""
    var title: String
    var coverAssetID: String?
    var score: Double
    var reviewState: String
    var summary: String
    var whyItMattered: String = ""
    var category: String = ""
    var generator: String = ""
    var factsHash: String = ""

    init(momentIDs: [String] = [], title: String = "", coverAssetID: String? = nil, score: Double = 0, reviewState: String = "draft", summary: String = "") {
        self.id = UUID()
        self.momentIDs = momentIDs
        self.title = title
        self.coverAssetID = coverAssetID
        self.score = score
        self.reviewState = reviewState
        self.summary = summary
    }
}

@Model
final class ScanCheckpoint {
    var albumLocalIdentifier: String
    var albumTitle: String
    var albumKind: String
    var batchCursor: String?
    var permissionState: String
    var modelVersion: String
    var status: String
    var processedCount: Int
    var totalCount: Int
    var lastError: String?
    var updatedAt: Date

    init() {
        self.albumLocalIdentifier = ""
        self.albumTitle = ""
        self.albumKind = ""
        self.batchCursor = nil
        self.permissionState = PhotoAccess.notDetermined.rawValue
        self.modelVersion = LibraryModelVersion.current
        self.status = ScanStatus.idle.rawValue
        self.processedCount = 0
        self.totalCount = 0
        self.lastError = nil
        self.updatedAt = .now
    }
}

nonisolated enum LibraryModelVersion {
    static let current = "4.0-engine"
}
