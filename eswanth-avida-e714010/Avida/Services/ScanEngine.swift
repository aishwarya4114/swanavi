import Foundation
import SwiftData

nonisolated struct ScanSnapshot: Sendable, Equatable {
    var status: ScanStatus = .idle
    var progress = 0.0
    var processed = 0
    var total = 0
    var unchanged = 0
    var analyzed = 0
    var pendingAnalysis = 0
    var placeCount = 0
    var peopleCount = 0
    var periodCount = 0
    var experienceCount = 0
    var thumbnailAssetIDs: [String] = []
    var homes: [HomeEstimate] = []
    var errorMessage: String?
}

/// Owns a private `ModelContext` and does every expensive part of a library scan off the main thread:
/// PhotoKit enumeration, Vision analysis (several photos at a time), duplicate detection, clustering and
/// persistence. The UI only receives small `ScanSnapshot` values.
actor ScanEngine {
    private let container: ModelContainer
    private let context: ModelContext
    private let concurrency = 4
    private let chunkSize = 12
    private let clusterEvery = 400
    private let thumbnailSide: CGFloat = 384

    private var snapshot = ScanSnapshot()
    private var placeCells = Set<String>()
    private var months = Set<String>()
    private var peopleIDs = Set<String>()

    init(container: ModelContainer) {
        self.container = container
        let context = ModelContext(container)
        context.autosaveEnabled = false
        self.context = context
    }

    func run(access: PhotoAccess, report: @escaping @Sendable (ScanSnapshot) -> Void) async {
        snapshot = ScanSnapshot(status: .running)
        report(snapshot)

        let checkpoint = checkpoint()
        checkpoint.albumLocalIdentifier = LibraryScope.entireLibrary
        checkpoint.albumTitle = "Library"
        checkpoint.albumKind = "library"
        checkpoint.permissionState = access.rawValue
        checkpoint.modelVersion = LibraryModelVersion.current
        checkpoint.status = ScanStatus.running.rawValue
        checkpoint.lastError = nil
        checkpoint.updatedAt = .now
        save()

        // Who is the owner? Seed from the Selfies album the first time, then reuse.
        var people = await PersonIdentifier.shared.snapshot()
        if people.isEmpty, !UserDefaults.standard.bool(forKey: "avida.selfSeeded") {
            UserDefaults.standard.set(true, forKey: "avida.selfSeeded")
            await PersonIdentifier.shared.seedFromSelfies()
            people = await PersonIdentifier.shared.snapshot()
        }
        let peopleVersion = "p1-" + people.version

        let fetched = await PhotoLibraryClient.fetchLibraryMetadata()
        if Task.isCancelled { return interrupt(checkpoint, report) }

        snapshot.total = fetched.count
        snapshot.thumbnailAssetIDs = Array(fetched.prefix(4).map(\.assetID))

        let stored = (try? context.fetch(FetchDescriptor<PhotoIndex>())) ?? []
        var existing = Dictionary(stored.map { ($0.assetID, $0) }, uniquingKeysWith: { first, _ in first })
        let plan = ScanPlanner.plan(
            fetched: fetched,
            stored: stored.map { StoredPhotoStamp(assetID: $0.assetID, modificationDate: $0.modificationDate) }
        )
        let refreshIDs = Set(plan.refreshIDs)
        seedStats(from: stored)
        snapshot.pendingAnalysis = fetched.filter { photo in
            guard let record = existing[photo.assetID] else { return true }
            if refreshIDs.contains(photo.assetID) || record.modelVersion != LibraryModelVersion.current || record.quality == nil { return true }
            return record.faceCount > 0 && record.peopleVersion != peopleVersion
        }.count
        report(snapshot)

        var recentPrints: [FeaturePrintStamp] = []
        var seenBursts: [String: String] = [:]
        var sinceCluster = 0
        var index = 0

        while index < fetched.count {
            if Task.isCancelled { return interrupt(checkpoint, report) }
            let chunk = Array(fetched[index..<min(index + chunkSize, fetched.count)])
            index += chunk.count

            struct Pending { let photo: IndexedPhoto; let record: PhotoIndex }
            var pending: [Pending] = []
            var peoplePending: [Pending] = []

            for photo in chunk {
                let record = upsert(photo, existing: &existing)
                let alreadyAnalyzed = record.modelVersion == LibraryModelVersion.current && record.quality != nil && !refreshIDs.contains(photo.assetID)

                if let burst = photo.burstIdentifier {
                    if let original = seenBursts[burst], original != photo.assetID {
                        record.isDuplicate = true
                        record.duplicateOfAssetID = original
                        record.isRelevant = false
                        record.modelVersion = LibraryModelVersion.current
                        if record.quality == nil { record.quality = 0 }
                        continue
                    }
                    seenBursts[burst] = photo.assetID
                }

                if alreadyAnalyzed {
                    snapshot.unchanged += 1
                    if let data = record.featurePrintData, !record.isDuplicate {
                        recentPrints.append(FeaturePrintStamp(assetID: photo.assetID, capturedAt: photo.capturedAt, print: FeaturePrint(data: data)))
                    }
                    if record.peopleVersion != peopleVersion {
                        if record.faceCount > 0, photo.isLocallyAvailable {
                            peoplePending.append(Pending(photo: photo, record: record))
                        } else {
                            record.peopleVersion = peopleVersion
                        }
                    }
                } else if photo.isLocallyAvailable {
                    pending.append(Pending(photo: photo, record: record))
                } else {
                    record.isLocallyAvailable = false
                    record.modelVersion = LibraryModelVersion.current
                }
            }

            // Vision runs for several photos concurrently; results are applied in library order so
            // duplicate detection stays deterministic.
            let results = await analyze(pending.map(\.photo.assetID), people: people)
            for item in pending {
                guard let analysis = results[item.photo.assetID] else {
                    item.record.isLocallyAvailable = false
                    continue
                }
                let duplicateOf = PhotoAnalyzer.duplicateMatch(analysis.featurePrint, capturedAt: item.photo.capturedAt, recentPrints: recentPrints)
                apply(analysis, duplicateOf: duplicateOf, screenshot: item.photo.isScreenshot, peopleVersion: peopleVersion, to: item.record)
                if let print = analysis.featurePrint, duplicateOf == nil {
                    recentPrints.append(FeaturePrintStamp(assetID: item.photo.assetID, capturedAt: item.photo.capturedAt, print: print))
                }
                snapshot.analyzed += 1
            }

            // Incremental people pass for photos that were analyzed before the identity model changed.
            if !peoplePending.isEmpty {
                let faces = await classifyFaces(peoplePending.map(\.photo.assetID), people: people)
                for item in peoplePending {
                    if let counts = faces[item.photo.assetID] {
                        item.record.selfFaceCount = counts.selfCount
                        item.record.otherFaceCount = counts.otherCount
                    }
                    item.record.peopleVersion = peopleVersion
                    snapshot.analyzed += 1
                }
            }
            if recentPrints.count > 60 { recentPrints.removeFirst(recentPrints.count - 60) }

            for photo in chunk { track(existing[photo.assetID]) }
            snapshot.processed = index
            snapshot.progress = fetched.isEmpty ? 1 : Double(index) / Double(fetched.count)
            snapshot.placeCount = placeCells.count
            snapshot.periodCount = months.count
            snapshot.peopleCount = peopleIDs.count
            sinceCluster += chunk.count

            if sinceCluster >= clusterEvery {
                rebuildExperiences()
                sinceCluster = 0
            }
            checkpoint.batchCursor = chunk.last?.assetID
            checkpoint.processedCount = index
            checkpoint.totalCount = fetched.count
            checkpoint.updatedAt = .now
            save()
            report(snapshot)
            await Task.yield()
        }

        for assetID in plan.missingIDs {
            existing[assetID]?.isAvailable = false
            existing[assetID]?.lastSeen = .now
        }

        rebuildExperiences()
        snapshot.processed = fetched.count
        snapshot.progress = 1
        snapshot.status = .completed
        checkpoint.status = ScanStatus.completed.rawValue
        checkpoint.processedCount = fetched.count
        checkpoint.totalCount = fetched.count
        checkpoint.updatedAt = .now
        checkpoint.lastError = nil
        save()
        report(snapshot)
    }

    // MARK: - Analysis

    private func analyze(_ assetIDs: [String], people: PersonReferences) async -> [String: PhotoAnalysis] {
        let side = thumbnailSide
        return await parallel(assetIDs) { assetID in
            guard let image = PhotoLibraryClient.thumbnail(assetID: assetID, side: side) else { return nil }
            var analysis = PhotoAnalyzer.analyze(image: image)
            if !analysis.faceRects.isEmpty {
                let counts = PersonIdentifier.classify(faces: analysis.faceRects, in: image, references: people)
                analysis.selfFaceCount = counts.selfCount
                analysis.otherFaceCount = counts.otherCount
            }
            return analysis
        }
    }

    private func classifyFaces(_ assetIDs: [String], people: PersonReferences) async -> [String: (selfCount: Int, otherCount: Int)] {
        let side = thumbnailSide
        return await parallel(assetIDs) { assetID in
            guard let image = PhotoLibraryClient.thumbnail(assetID: assetID, side: side) else { return nil }
            let faces = PhotoAnalyzer.detectFaces(in: image)
            return PersonIdentifier.classify(faces: faces, in: image, references: people)
        }
    }

    /// Runs `work` for each id on background threads, `concurrency` at a time.
    private func parallel<T: Sendable>(_ assetIDs: [String], _ work: @escaping @Sendable (String) -> T?) async -> [String: T] {
        guard !assetIDs.isEmpty else { return [:] }
        return await withTaskGroup(of: (String, T?).self, returning: [String: T].self) { group in
            var results: [String: T] = [:]
            var iterator = assetIDs.makeIterator()
            var active = 0
            func enqueue() {
                guard let assetID = iterator.next() else { return }
                active += 1
                group.addTask {
                    let value = await Task.detached(priority: .utility) { work(assetID) }.value
                    return (assetID, value)
                }
            }
            for _ in 0..<concurrency { enqueue() }
            while active > 0, let (assetID, value) = await group.next() {
                active -= 1
                if let value { results[assetID] = value }
                enqueue()
            }
            return results
        }
    }

    private func apply(_ analysis: PhotoAnalysis, duplicateOf: String?, screenshot: Bool, peopleVersion: String, to record: PhotoIndex) {
        let duplicate = duplicateOf != nil
        record.quality = analysis.quality
        record.faceCount = analysis.faceCount
        record.selfFaceCount = analysis.selfFaceCount
        record.otherFaceCount = analysis.otherFaceCount
        record.peopleVersion = peopleVersion
        record.containsPerson = analysis.containsPerson
        record.isDuplicate = duplicate
        record.duplicateOfAssetID = duplicateOf
        record.featurePrintData = analysis.featurePrint?.data
        record.isRelevant = PhotoAnalyzer.isRelevant(
            isScreenshot: screenshot,
            isDuplicate: duplicate,
            quality: analysis.quality,
            labels: analysis.labels,
            containsPerson: analysis.containsPerson
        )
        record.modelVersion = LibraryModelVersion.current
        for label in record.labels {
            context.delete(label)
        }
        record.labels.removeAll()
        var labels = analysis.labels
        if analysis.containsAnimal, !labels.contains(where: { $0.name == "animal" }) {
            labels.insert(AnalyzedLabel(name: "animal", confidence: 0.9), at: 0)
        }
        for label in labels.prefix(8) {
            let row = PhotoLabel(name: label.name, confidence: label.confidence)
            row.photo = record
            record.labels.append(row)
        }
        record.labelSummary = PhotoAnalyzer.descriptiveLabels(labels).prefix(6).joined(separator: "|")
    }

    private func upsert(_ photo: IndexedPhoto, existing: inout [String: PhotoIndex]) -> PhotoIndex {
        if let record = existing[photo.assetID] {
            record.albumID = LibraryScope.entireLibrary
            record.capturedAt = photo.capturedAt
            record.modificationDate = photo.modificationDate
            record.latitude = photo.latitude
            record.longitude = photo.longitude
            record.mediaType = photo.mediaType
            record.pixelWidth = photo.pixelWidth
            record.pixelHeight = photo.pixelHeight
            record.duration = photo.duration
            record.isFavorite = photo.isFavorite
            record.sourceType = photo.sourceType
            record.isHidden = photo.isHidden
            record.burstIdentifier = photo.burstIdentifier
            record.isLocallyAvailable = photo.isLocallyAvailable
            record.lastSeen = .now
            record.isAvailable = true
            return record
        }
        let record = PhotoIndex(
            assetID: photo.assetID,
            albumID: LibraryScope.entireLibrary,
            capturedAt: photo.capturedAt,
            modificationDate: photo.modificationDate,
            latitude: photo.latitude,
            longitude: photo.longitude,
            mediaType: photo.mediaType,
            pixelWidth: photo.pixelWidth,
            pixelHeight: photo.pixelHeight,
            duration: photo.duration,
            isFavorite: photo.isFavorite,
            sourceType: photo.sourceType,
            isHidden: photo.isHidden,
            burstIdentifier: photo.burstIdentifier,
            isLocallyAvailable: photo.isLocallyAvailable,
            modelVersion: "pending",
            lastSeen: .now
        )
        context.insert(record)
        existing[photo.assetID] = record
        return record
    }

    // MARK: - Stats

    private func seedStats(from stored: [PhotoIndex]) {
        placeCells.removeAll()
        months.removeAll()
        peopleIDs.removeAll()
        for record in stored where record.isAvailable {
            track(record)
        }
    }

    private func track(_ record: PhotoIndex?) {
        guard let record, record.isAvailable else { return }
        if let latitude = record.latitude, let longitude = record.longitude {
            placeCells.insert(String(format: "%.2f,%.2f", latitude, longitude))
        }
        if let date = record.capturedAt {
            let parts = Calendar.current.dateComponents([.year, .month], from: date)
            months.insert("\(parts.year ?? 0)-\(parts.month ?? 0)")
        }
        if record.containsPerson && !record.isDuplicate && record.isRelevant {
            peopleIDs.insert(record.assetID)
        }
    }

    // MARK: - Experiences

    private func rebuildExperiences() {
        let library = LibraryScope.entireLibrary
        var located = FetchDescriptor<PhotoIndex>(predicate: #Predicate { $0.isAvailable && $0.albumID == library && $0.latitude != nil })
        located.propertiesToFetch = [\.assetID, \.capturedAt, \.latitude, \.longitude]
        let allLocated = ((try? context.fetch(located)) ?? []).map { photo in
            ExperienceCandidate(assetID: photo.assetID, capturedAt: photo.capturedAt, latitude: photo.latitude, longitude: photo.longitude, quality: 0, isFavorite: false)
        }
        let homes = ExperienceGrouper.estimateHomes(allLocated)

        var relevant = FetchDescriptor<PhotoIndex>(predicate: #Predicate { $0.isAvailable && $0.albumID == library && $0.isRelevant && !$0.isDuplicate })
        relevant.propertiesToFetch = [\.assetID, \.capturedAt, \.latitude, \.longitude, \.quality, \.isFavorite, \.containsPerson, \.labelSummary, \.selfFaceCount, \.otherFaceCount]
        let photos = (try? context.fetch(relevant)) ?? []
        let selfIDs = Set(photos.filter { $0.selfFaceCount > 0 }.map(\.assetID))
        let othersIDs = Set(photos.filter { $0.otherFaceCount > 0 }.map(\.assetID))
        let candidates = photos.map { photo in
            ExperienceCandidate(
                assetID: photo.assetID,
                capturedAt: photo.capturedAt,
                latitude: photo.latitude,
                longitude: photo.longitude,
                quality: photo.quality ?? 0,
                isFavorite: photo.isFavorite,
                containsPerson: photo.containsPerson,
                labels: photo.labelSummary.isEmpty ? [] : photo.labelSummary.split(separator: "|").map(String.init)
            )
        }
        let coverScore = Dictionary(uniqueKeysWithValues: photos.map { ($0.assetID, ($0.quality ?? 0) + ($0.isFavorite ? 0.5 : 0) + ($0.containsPerson ? 0.1 : 0)) })
        let clusters = ExperienceGrouper.cluster(candidates, homes: homes)

        let existingMoments = (try? context.fetch(FetchDescriptor<ExperienceMoment>())) ?? []
        var byKey: [String: ExperienceMoment] = [:]
        for moment in existingMoments {
            if moment.key.isEmpty || byKey[moment.key] != nil {
                context.delete(moment)
            } else {
                byKey[moment.key] = moment
            }
        }
        var keep = Set<String>()
        for cluster in clusters {
            keep.insert(cluster.key)
            let moment = byKey[cluster.key] ?? {
                let created = ExperienceMoment()
                created.key = cluster.key
                context.insert(created)
                return created
            }()
            let ordered = cluster.photoIDs
            let cover = ordered.max { (coverScore[$0] ?? 0) < (coverScore[$1] ?? 0) }
            let photoIDs = cover.map { c in [c] + ordered.filter { $0 != c } } ?? ordered
            let newSelf = photoIDs.filter { selfIDs.contains($0) }
            let newOthers = photoIDs.filter { othersIDs.contains($0) }
            let changed = moment.photoIDs != photoIDs || moment.confidence != cluster.score || moment.tripKey != cluster.tripKey
                || moment.selfPhotoIDs != newSelf || moment.othersPhotoIDs != newOthers
            moment.photoIDs = photoIDs
            moment.startDate = cluster.start
            moment.endDate = cluster.end
            moment.latitude = cluster.latitude
            moment.longitude = cluster.longitude
            moment.distanceFromHomeKM = cluster.distanceFromHomeKM
            moment.homeKey = cluster.home.map { ExperienceBoard.placeKey(latitude: $0.latitude, longitude: $0.longitude) }
            moment.topLabels = cluster.topLabels
            moment.hasPeople = cluster.hasPeople
            moment.peopleCount = cluster.peopleCount
            moment.selfPhotoIDs = newSelf
            moment.othersPhotoIDs = newOthers
            moment.favoriteCount = cluster.favoriteCount
            moment.momentCount = cluster.momentCount
            moment.visitIndex = cluster.visitIndex
            moment.visitTotal = cluster.visitTotal
            moment.averageQuality = cluster.averageQuality
            moment.confidence = cluster.score
            moment.tripKey = cluster.tripKey
            moment.region = cluster.latitude.flatMap { lat in cluster.longitude.map { ExperienceBoard.placeKey(latitude: lat, longitude: $0) } }
            if changed { moment.updatedAt = .now }
        }
        for (key, moment) in byKey where !keep.contains(key) {
            context.delete(moment)
        }

        let existingHomes = (try? context.fetch(FetchDescriptor<HomeBase>())) ?? []
        for home in existingHomes { context.delete(home) }
        for (index, home) in homes.enumerated() {
            let row = HomeBase()
            row.key = ExperienceBoard.placeKey(latitude: home.latitude, longitude: home.longitude)
            row.latitude = home.latitude
            row.longitude = home.longitude
            row.startDate = home.start
            row.endDate = home.end
            row.dayCount = home.dayCount
            row.isCurrent = index == homes.count - 1
            context.insert(row)
        }

        snapshot.homes = homes
        snapshot.experienceCount = clusters.count
        save()
    }

    // MARK: - Persistence helpers

    private func save() {
        do {
            try context.save()
        } catch {
            snapshot.errorMessage = "Couldn't save progress: \(error.localizedDescription)"
        }
    }

    private func interrupt(_ checkpoint: ScanCheckpoint, _ report: @Sendable (ScanSnapshot) -> Void) {
        snapshot.status = .interrupted
        checkpoint.status = ScanStatus.interrupted.rawValue
        checkpoint.updatedAt = .now
        save()
        report(snapshot)
    }

    private func checkpoint() -> ScanCheckpoint {
        if let existing = try? context.fetch(FetchDescriptor<ScanCheckpoint>()).first {
            return existing
        }
        let created = ScanCheckpoint()
        context.insert(created)
        return created
    }
}
