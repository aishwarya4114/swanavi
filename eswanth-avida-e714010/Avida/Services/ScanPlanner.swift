import Foundation

enum PhotoAccess: String, Sendable {
    case notDetermined
    case restricted
    case denied
    case limited
    case authorized
}

enum ScanStatus: String, Sendable {
    case idle
    case running
    case completed
    case failed
    case interrupted
}

nonisolated struct IndexedPhoto: Sendable, Identifiable, Hashable {
    var id: String { assetID }
    let assetID: String
    let capturedAt: Date?
    let modificationDate: Date?
    let latitude: Double?
    let longitude: Double?
    let mediaType: String
    let pixelWidth: Int
    let pixelHeight: Int
    let duration: Double
    let isFavorite: Bool
    let sourceType: String
    let isHidden: Bool
    let burstIdentifier: String?
    let isLocallyAvailable: Bool
    let isScreenshot: Bool
}

nonisolated enum LibraryScope {
    static let entireLibrary = "library"
}

nonisolated struct StoredPhotoStamp: Sendable, Equatable {
    let assetID: String
    let modificationDate: Date?
}

nonisolated struct ScanPlan: Sendable, Equatable {
    var insertIDs: [String]
    var refreshIDs: [String]
    var unchangedIDs: [String]
    var missingIDs: [String]
}

nonisolated enum ScanPlanner {
    static func plan(fetched: [IndexedPhoto], stored: [StoredPhotoStamp]) -> ScanPlan {
        let fetchedByID = Dictionary(fetched.map { ($0.assetID, $0) }, uniquingKeysWith: { first, _ in first })
        let storedByID = Dictionary(stored.map { ($0.assetID, $0) }, uniquingKeysWith: { first, _ in first })

        var insertIDs: [String] = []
        var refreshIDs: [String] = []
        var unchangedIDs: [String] = []

        for photo in fetched {
            if let existing = storedByID[photo.assetID] {
                if sameInstant(existing.modificationDate, photo.modificationDate) {
                    unchangedIDs.append(photo.assetID)
                } else {
                    refreshIDs.append(photo.assetID)
                }
            } else {
                insertIDs.append(photo.assetID)
            }
        }

        let missingIDs = stored.map(\.assetID).filter { fetchedByID[$0] == nil }
        return ScanPlan(insertIDs: insertIDs, refreshIDs: refreshIDs, unchangedIDs: unchangedIDs, missingIDs: missingIDs)
    }

    static func sameInstant(_ lhs: Date?, _ rhs: Date?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil):
            return true
        case let (left?, right?):
            return abs(left.timeIntervalSince(right)) < 1
        default:
            return false
        }
    }
}

nonisolated struct TripCollection: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable {
        case folder
        case album
    }

    let id: String
    let title: String
    let containerTitle: String?
    let count: Int
    let kind: Kind
    let coverAssetID: String?
}
