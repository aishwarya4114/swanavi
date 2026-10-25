import Foundation

nonisolated struct ExperienceCandidate: Sendable, Equatable {
    var assetID: String
    var capturedAt: Date?
    var latitude: Double?
    var longitude: Double?
    var quality: Double
    var isFavorite: Bool
    var containsPerson: Bool = false
    var labels: [String] = []
}

/// A stretch of time during which one area was "home".
nonisolated struct HomeEstimate: Sendable, Equatable {
    var latitude: Double
    var longitude: Double
    var radiusKM: Double
    var start: Date = .distantPast
    var end: Date = .distantFuture
    var dayCount: Int = 0

    func contains(_ date: Date) -> Bool {
        date >= start && date <= end
    }
}

nonisolated struct ExperienceCluster: Sendable, Equatable, Identifiable {
    var id: String { key }
    var key: String
    var photoIDs: [String]
    var start: Date
    var end: Date
    var latitude: Double?
    var longitude: Double?
    var distanceFromHomeKM: Double?
    var home: HomeEstimate?
    var topLabels: [String]
    var hasPeople: Bool
    var peopleCount: Int
    var favoriteCount: Int
    var momentCount: Int
    var averageQuality: Double
    var score: Double
    var tripKey: String?
    var visitIndex: Int = 1
    var visitTotal: Int = 1
}

nonisolated enum ExperienceGrouper {
    static let momentGap: TimeInterval = 90 * 60
    static let momentDistanceKM = 3.0
    static let experienceGap: TimeInterval = 4 * 60 * 60
    static let experienceDistanceKM = 15.0
    static let tripGap: TimeInterval = 48 * 60 * 60
    static let awayFromHomeKM = 60.0
    static let homeRadiusKM = 3.0
    private static let homeAreaMergeKM = 6.0

    // MARK: - Homes

    /// The most recent home, for callers that only need one.
    static func estimateHome(_ photos: [ExperienceCandidate]) -> HomeEstimate? {
        estimateHomes(photos).last
    }

    /// Infers every place the person has lived, in chronological order. Works month by month: the area
    /// with the most *distinct days* of photos in a month is that month's home candidate; a new area only
    /// becomes home once it dominates two consecutive months (or very clearly dominates one), so long
    /// trips don't register as moves.
    static func estimateHomes(_ photos: [ExperienceCandidate]) -> [HomeEstimate] {
        let calendar = Calendar(identifier: .gregorian)
        struct Cell { var latitude: Double; var longitude: Double; var count: Int; var days: Set<Int> }
        var cells: [String: Cell] = [:]
        var observations: [(cell: String, month: Int, day: Int)] = []

        for photo in photos {
            guard let latitude = photo.latitude, let longitude = photo.longitude, let date = photo.capturedAt else { continue }
            let key = "\(Int((latitude / 0.02).rounded())),\(Int((longitude / 0.02).rounded()))"
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            let month = (parts.year ?? 0) * 12 + (parts.month ?? 1) - 1
            let day = Int(calendar.startOfDay(for: date).timeIntervalSince1970 / 86_400)
            var cell = cells[key] ?? Cell(latitude: 0, longitude: 0, count: 0, days: [])
            cell.latitude += latitude
            cell.longitude += longitude
            cell.count += 1
            cell.days.insert(day)
            cells[key] = cell
            observations.append((key, month, day))
        }
        guard !cells.isEmpty else { return [] }

        // Merge nearby cells into areas so a neighbourhood counts as one place.
        struct Area { var latitude: Double; var longitude: Double; var weight: Int }
        var areas: [Area] = []
        var areaForCell: [String: Int] = [:]
        for (key, cell) in cells.sorted(by: { $0.value.days.count > $1.value.days.count }) {
            let latitude = cell.latitude / Double(cell.count)
            let longitude = cell.longitude / Double(cell.count)
            if let index = areas.firstIndex(where: { distanceKM($0.latitude, $0.longitude, latitude, longitude) < homeAreaMergeKM }) {
                let area = areas[index]
                let total = Double(area.weight + cell.count)
                areas[index] = Area(
                    latitude: (area.latitude * Double(area.weight) + latitude * Double(cell.count)) / total,
                    longitude: (area.longitude * Double(area.weight) + longitude * Double(cell.count)) / total,
                    weight: area.weight + cell.count
                )
                areaForCell[key] = index
            } else {
                areas.append(Area(latitude: latitude, longitude: longitude, weight: cell.count))
                areaForCell[key] = areas.count - 1
            }
        }

        var daysByMonthArea: [Int: [Int: Set<Int>]] = [:]
        for observation in observations {
            guard let area = areaForCell[observation.cell] else { continue }
            daysByMonthArea[observation.month, default: [:]][area, default: []].insert(observation.day)
        }
        guard let firstMonth = daysByMonthArea.keys.min(), let lastMonth = daysByMonthArea.keys.max() else { return [] }

        func dominant(_ month: Int) -> (area: Int, days: Int)? {
            guard let byArea = daysByMonthArea[month],
                  let best = byArea.max(by: { $0.value.count < $1.value.count }),
                  best.value.count >= 2 else { return nil }
            return (best.key, best.value.count)
        }

        var monthHome: [Int: Int] = [:]
        var current: Int?
        for month in firstMonth...lastMonth {
            if let candidate = dominant(month) {
                if current == nil {
                    current = candidate.area
                } else if candidate.area != current {
                    let persists = dominant(month + 1)?.area == candidate.area
                    let overwhelming = candidate.days >= 12
                    let isLast = month == lastMonth
                    if persists || overwhelming || (isLast && candidate.days >= 6) {
                        current = candidate.area
                    }
                }
            }
            if let current { monthHome[month] = current }
        }
        guard !monthHome.isEmpty else { return [] }

        // Collapse months into periods.
        var periods: [(area: Int, firstMonth: Int, lastMonth: Int)] = []
        for month in firstMonth...lastMonth {
            guard let area = monthHome[month] else { continue }
            if let last = periods.last, last.area == area {
                periods[periods.count - 1].lastMonth = month
            } else {
                periods.append((area, month, month))
            }
        }

        // Drop short, thin periods (a long trip that squeaked through) by folding into the previous period.
        var cleaned: [(area: Int, firstMonth: Int, lastMonth: Int)] = []
        for period in periods {
            let days = (period.firstMonth...period.lastMonth).reduce(0) { $0 + (daysByMonthArea[$1]?[period.area]?.count ?? 0) }
            let months = period.lastMonth - period.firstMonth + 1
            if months <= 1 && days < 8, !cleaned.isEmpty {
                cleaned[cleaned.count - 1].lastMonth = period.lastMonth
            } else if let last = cleaned.last, last.area == period.area {
                cleaned[cleaned.count - 1].lastMonth = period.lastMonth
            } else {
                cleaned.append(period)
            }
        }

        func monthStart(_ month: Int) -> Date {
            var parts = DateComponents()
            parts.year = month / 12
            parts.month = month % 12 + 1
            parts.day = 1
            return calendar.date(from: parts) ?? .distantPast
        }

        return cleaned.enumerated().map { index, period in
            let area = areas[period.area]
            let days = (period.firstMonth...period.lastMonth).reduce(0) { $0 + (daysByMonthArea[$1]?[period.area]?.count ?? 0) }
            let start = index == 0 ? Date.distantPast : monthStart(period.firstMonth)
            let end = index == cleaned.count - 1 ? Date.distantFuture : monthStart(period.lastMonth + 1).addingTimeInterval(-1)
            return HomeEstimate(latitude: area.latitude, longitude: area.longitude, radiusKM: homeRadiusKM, start: start, end: end, dayCount: days)
        }
    }

    static func home(at date: Date, in homes: [HomeEstimate]) -> HomeEstimate? {
        homes.first { $0.contains(date) } ?? homes.last
    }

    // MARK: - Clustering

    static func cluster(_ photos: [ExperienceCandidate], home: HomeEstimate?) -> [ExperienceCluster] {
        cluster(photos, homes: home.map { [$0] } ?? [])
    }

    static func cluster(_ photos: [ExperienceCandidate], homes: [HomeEstimate]) -> [ExperienceCluster] {
        let dated = photos.filter { $0.capturedAt != nil }
            .sorted { $0.capturedAt! < $1.capturedAt! }
        guard !dated.isEmpty else { return [] }

        var moments: [[ExperienceCandidate]] = []
        for photo in dated {
            if let last = moments.last?.last, continuesMoment(from: last, to: photo) {
                moments[moments.count - 1].append(photo)
            } else {
                moments.append([photo])
            }
        }

        var experiences: [[[ExperienceCandidate]]] = []
        for moment in moments {
            if let previous = experiences.last, continuesExperience(from: previous.flatMap { $0 }, to: moment) {
                experiences[experiences.count - 1].append(moment)
            } else {
                experiences.append([moment])
            }
        }

        var clusters = experiences.compactMap { build($0, homes: homes) }
        assignTrips(&clusters)
        applyRarity(&clusters)
        return clusters
    }

    static func distanceKM(_ lat1: Double, _ lon1: Double, _ lat2: Double, _ lon2: Double) -> Double {
        let earth = 6371.0
        let dLat = (lat2 - lat1) * .pi / 180
        let dLon = (lon2 - lon1) * .pi / 180
        let a = sin(dLat / 2) * sin(dLat / 2)
            + cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * earth * asin(min(1, sqrt(a)))
    }

    private static func continuesMoment(from previous: ExperienceCandidate, to photo: ExperienceCandidate) -> Bool {
        guard let last = previous.capturedAt, let next = photo.capturedAt else { return false }
        if next.timeIntervalSince(last) > momentGap { return false }
        if let d = distance(previous, photo), d > momentDistanceKM { return false }
        return true
    }

    private static func continuesExperience(from previous: [ExperienceCandidate], to moment: [ExperienceCandidate]) -> Bool {
        guard let last = previous.last?.capturedAt, let next = moment.first?.capturedAt else { return false }
        let gap = next.timeIntervalSince(last)
        if gap > experienceGap { return false }
        if let a = centroid(previous), let b = centroid(moment), distanceKM(a.0, a.1, b.0, b.1) > experienceDistanceKM {
            return false
        }
        if gap > 45 * 60 {
            let overlap = labelOverlap(previous, moment)
            if overlap < 0.15 { return false }
        }
        return true
    }

    private static func build(_ moments: [[ExperienceCandidate]], homes: [HomeEstimate]) -> ExperienceCluster? {
        let group = moments.flatMap { $0 }
        guard let first = group.first?.capturedAt, let last = group.last?.capturedAt else { return nil }
        let favorites = group.filter(\.isFavorite).count
        let center = centroid(group)
        let home = home(at: first, in: homes)
        let distanceFromHome = center.flatMap { c in home.map { distanceKM(c.0, c.1, $0.latitude, $0.longitude) } }
        let atHome = (distanceFromHome ?? .infinity) < (home?.radiusKM ?? 0)
        let peopleCount = group.filter(\.containsPerson).count
        let hasPeople = peopleCount > 0
        let quality = group.map(\.quality).reduce(0, +) / Double(group.count)

        let minimum: Int
        if atHome {
            minimum = hasPeople ? 6 : 10
        } else if favorites > 0 {
            minimum = 1
        } else {
            minimum = 3
        }
        guard group.count >= minimum || (group.count >= 2 && quality > 0.6 && !atHome) else { return nil }

        let labels = topLabels(group)
        let span = last.timeIntervalSince(first)
        let size = min(1, log2(Double(group.count) + 1) / 5)
        let variety = min(1, Double(Set(group.flatMap { $0.labels.prefix(3) }).count) / 12)
        let away = distanceFromHome.map { min(1, log10(max(1, $0)) / 3.5) } ?? 0.35
        let duration = min(1, span / (8 * 3600))
        let favoriteRatio = min(1, Double(favorites) / 3)
        let people = min(1, Double(peopleCount) / Double(max(group.count, 1)))
        var score = size * 0.18 + quality * 0.14 + variety * 0.1 + away * 0.3 + duration * 0.08 + favoriteRatio * 0.1 + people * 0.1
        if atHome { score *= 0.6 }

        return ExperienceCluster(
            key: group.first!.assetID,
            photoIDs: group.map(\.assetID),
            start: first,
            end: last,
            latitude: center?.0,
            longitude: center?.1,
            distanceFromHomeKM: distanceFromHome,
            home: home,
            topLabels: labels,
            hasPeople: hasPeople,
            peopleCount: peopleCount,
            favoriteCount: favorites,
            momentCount: moments.count,
            averageQuality: quality,
            score: min(1, score),
            tripKey: nil
        )
    }

    private static func assignTrips(_ clusters: inout [ExperienceCluster]) {
        var currentTrip: String?
        var previousEnd: Date?
        for index in clusters.indices {
            let away = (clusters[index].distanceFromHomeKM ?? 0) >= awayFromHomeKM
            if away {
                if let previousEnd, let trip = currentTrip, clusters[index].start.timeIntervalSince(previousEnd) <= tripGap {
                    clusters[index].tripKey = trip
                } else {
                    currentTrip = clusters[index].key
                    clusters[index].tripKey = clusters[index].key
                }
                previousEnd = clusters[index].end
            } else {
                currentTrip = nil
                previousEnd = nil
            }
        }
        var counts: [String: Int] = [:]
        for cluster in clusters {
            if let trip = cluster.tripKey { counts[trip, default: 0] += 1 }
        }
        for index in clusters.indices {
            if let trip = clusters[index].tripKey, counts[trip, default: 0] < 2 {
                clusters[index].tripKey = nil
            }
        }
    }

    /// Counts how many separate visits each area received so first visits and rare places rank higher.
    private static func applyRarity(_ clusters: inout [ExperienceCluster]) {
        var visits: [String: Int] = [:]
        var distinctVisitDays: [String: Set<Int>] = [:]
        for cluster in clusters {
            if let cell = cell(cluster) {
                distinctVisitDays[cell, default: []].insert(Int(cluster.start.timeIntervalSince1970 / 86_400))
            }
        }
        var seenSoFar: [String: Int] = [:]
        for index in clusters.indices {
            guard let cell = cell(clusters[index]) else { continue }
            let total = distinctVisitDays[cell]?.count ?? 1
            seenSoFar[cell, default: 0] += 1
            visits[cell] = total
            clusters[index].visitTotal = total
            clusters[index].visitIndex = seenSoFar[cell, default: 1]
            let rarity = 1 / Double(max(1, total)).squareRoot()
            clusters[index].score = min(1, clusters[index].score + rarity * 0.12)
        }
    }

    private static func cell(_ cluster: ExperienceCluster) -> String? {
        guard let latitude = cluster.latitude, let longitude = cluster.longitude else { return nil }
        return "\(Int((latitude / 0.05).rounded())),\(Int((longitude / 0.05).rounded()))"
    }

    private static func distance(_ a: ExperienceCandidate, _ b: ExperienceCandidate) -> Double? {
        guard let lat1 = a.latitude, let lon1 = a.longitude, let lat2 = b.latitude, let lon2 = b.longitude else { return nil }
        return distanceKM(lat1, lon1, lat2, lon2)
    }

    private static func centroid(_ group: [ExperienceCandidate]) -> (Double, Double)? {
        let located = group.compactMap { photo -> (Double, Double)? in
            guard let latitude = photo.latitude, let longitude = photo.longitude else { return nil }
            return (latitude, longitude)
        }
        guard !located.isEmpty else { return nil }
        let count = Double(located.count)
        return (located.map(\.0).reduce(0, +) / count, located.map(\.1).reduce(0, +) / count)
    }

    private static func labelOverlap(_ a: [ExperienceCandidate], _ b: [ExperienceCandidate]) -> Double {
        let left = Set(a.flatMap { $0.labels.prefix(4) })
        let right = Set(b.flatMap { $0.labels.prefix(4) })
        guard !left.isEmpty, !right.isEmpty else { return 1 }
        return Double(left.intersection(right).count) / Double(left.union(right).count)
    }

    private static func topLabels(_ group: [ExperienceCandidate]) -> [String] {
        var scores: [String: Double] = [:]
        for photo in group {
            for (position, label) in photo.labels.prefix(5).enumerated() {
                scores[label, default: 0] += 1.0 / Double(position + 1)
            }
        }
        return scores.sorted { $0.value > $1.value }.prefix(6).map(\.key)
    }
}
