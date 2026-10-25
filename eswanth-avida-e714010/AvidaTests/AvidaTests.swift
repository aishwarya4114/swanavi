import Foundation
import Testing
@testable import Avida

private func facts(
    place: String = "Tokyo", landmark: String? = nil, country: String? = "Japan", homePlace: String? = "New York",
    category: String = "Culinary", labels: [String] = ["restaurant", "food"], photoCount: Int = 6, momentCount: Int = 1,
    dayCount: Int = 1, durationHours: Double = 2, weekday: String = "Saturday", timeOfDay: String = "evening",
    monthYear: String = "October 2026", peopleCount: Int = 2, favoriteCount: Int = 0, distanceFromHomeKM: Double? = 10_800,
    visitIndex: Int = 1, visitTotal: Int = 1, isFirstInCountry: Bool = false, isLongestTripOfYear: Bool = false,
    categoryCountInLibrary: Int = 5, tripTitle: String? = nil, tripDays: Int = 0, tripDayIndex: Int = 0,
    selfPhotoCount: Int = 0, othersPhotoCount: Int = 0
) -> ExperienceFacts {
    ExperienceFacts(
        place: place, landmark: landmark, country: country, homePlace: homePlace, category: category, labels: labels,
        photoCount: photoCount, momentCount: momentCount, dayCount: dayCount, durationHours: durationHours, weekday: weekday,
        timeOfDay: timeOfDay, monthYear: monthYear, hasPeople: peopleCount > 0, peopleCount: peopleCount,
        favoriteCount: favoriteCount, distanceFromHomeKM: distanceFromHomeKM, visitIndex: visitIndex, visitTotal: visitTotal,
        isFirstInCountry: isFirstInCountry, isLongestTripOfYear: isLongestTripOfYear,
        categoryCountInLibrary: categoryCountInLibrary, tripTitle: tripTitle, tripDays: tripDays, tripDayIndex: tripDayIndex,
        selfPhotoCount: selfPhotoCount, othersPhotoCount: othersPhotoCount
    )
}

struct PeopleScopeTests {
    @Test func justMeHidesPhotosWithOtherPeople() {
        let experience = LifeExperience(
            id: UUID(), key: "k", title: "", place: "Tokyo", landmark: nil, country: "Japan", homePlace: nil, category: "",
            year: "", monthYear: "", summary: "", whyItMattered: "", reasons: [], photoIDs: ["a", "b", "c", "d"], tags: [],
            labels: [], hasPeople: true, peopleCount: 2, favoriteCount: 0, momentCount: 1, visitIndex: 1, visitTotal: 1,
            score: 0, latitude: nil, longitude: nil, distanceFromHomeKM: nil, start: nil, end: nil, placeKey: nil,
            tripKey: nil, tripTitle: nil, tripDays: 0, tripDayIndex: 0, dayCount: 1, timeOfDay: "", facts: facts(),
            selfPhotoIDs: ["a", "b"], othersPhotoIDs: ["b", "c"]
        )
        #expect(experience.photoIDs(for: .everyone) == ["a", "b", "c", "d"])
        #expect(experience.photoIDs(for: .justMe) == ["a", "d"])
        #expect(experience.includesMe && experience.includesOthers)
    }

    @Test func reasonsMentionTheOwner() {
        let reasons = ExperienceCopy.reasons(facts(selfPhotoCount: 3, othersPhotoCount: 0))
        #expect(reasons.contains { $0.text == "You're in 3 photos" })
        let shared = ExperienceCopy.reasons(facts(selfPhotoCount: 2, othersPhotoCount: 4))
        #expect(shared.contains { $0.text == "You and others in 4 photos" })
    }
}

struct ExperienceCopyTests {
    @Test func culinaryEveningBecomesDinner() {
        #expect(ExperienceCopy.fallbackTitle(facts()) == "Dinner in Tokyo")
        #expect(ExperienceCopy.category(for: ["sushi", "restaurant", "sky"]) == "Culinary")
        #expect(ExperienceCopy.category(for: ["temple", "pagoda"]) == "Culture")
    }

    @Test func multiDayExperienceUsesDayCount() {
        let kyoto = facts(place: "Kyoto", category: "Culture", labels: ["temple"], photoCount: 40, dayCount: 3, timeOfDay: "day", favoriteCount: 2, distanceFromHomeKM: 400)
        #expect(ExperienceCopy.fallbackTitle(kyoto) == "3 days in Kyoto")
    }

    @Test func tripDaysGetNumberedTitles() {
        let day2 = facts(place: "Lisbon", country: "Portugal", tripTitle: "5-day trip to Lisbon", tripDays: 5, tripDayIndex: 2)
        #expect(ExperienceCopy.fallbackTitle(day2) == "Day 2 in Lisbon")
        let landmark = facts(place: "Lisbon", landmark: "Belém Tower", country: "Portugal", tripTitle: "5-day trip to Lisbon", tripDays: 5, tripDayIndex: 3)
        #expect(ExperienceCopy.fallbackTitle(landmark) == "Belém Tower")
    }

    @Test func summaryIsConcreteAndReasonsAreRanked() {
        let summary = ExperienceCopy.fallbackSummary(facts(momentCount: 3, favoriteCount: 1))
        #expect(summary.contains("On a Saturday evening in October 2026"))
        #expect(summary.contains("in Tokyo"))
        #expect(summary.contains("restaurant and food"))
        #expect(summary.contains("6 photos across 3 moments, 1 of them favorites."))

        let reasons = ExperienceCopy.reasons(facts(isFirstInCountry: true))
        #expect(reasons.first?.text == "Your first photos in Japan")
        #expect(reasons.contains { $0.text == "10,800 km from home in New York" })
        #expect(reasons.contains { $0.text == "The only time you've been to Tokyo" })
    }
}

struct HomeEstimateTests {
    private let day: TimeInterval = 86_400

    private func photos(at latitude: Double, _ longitude: Double, from start: Date, days: Int, perDay: Int = 2, prefix: String) -> [ExperienceCandidate] {
        var result: [ExperienceCandidate] = []
        for d in 0..<days {
            for n in 0..<perDay {
                result.append(ExperienceCandidate(assetID: "\(prefix)-\(d)-\(n)", capturedAt: start.addingTimeInterval(Double(d) * day + Double(n) * 3600 + 36_000), latitude: latitude, longitude: longitude, quality: 0, isFavorite: false))
            }
        }
        return result
    }

    @Test func detectsAMoveBetweenCities() {
        let jan2024 = Date(timeIntervalSince1970: 1_704_067_200)
        var all: [ExperienceCandidate] = []
        // Lived in Hyderabad Jan–Jun 2024 (photos every few days), then New York from Aug 2024 on.
        for month in 0..<6 {
            all += photos(at: 17.385, 78.486, from: jan2024.addingTimeInterval(Double(month) * 30 * day), days: 6, prefix: "hyd\(month)")
        }
        for month in 7..<14 {
            all += photos(at: 40.73, -73.99, from: jan2024.addingTimeInterval(Double(month) * 30 * day), days: 6, prefix: "nyc\(month)")
        }
        // A 10-day trip to Tokyo in March 2024 should not count as a move.
        all += photos(at: 35.68, 139.76, from: jan2024.addingTimeInterval(70 * day), days: 10, perDay: 6, prefix: "tokyo")

        let homes = ExperienceGrouper.estimateHomes(all)

        #expect(homes.count == 2)
        #expect(abs((homes.first?.latitude ?? 0) - 17.385) < 0.05)
        #expect(abs((homes.last?.latitude ?? 0) - 40.73) < 0.05)
        #expect(homes.first?.start == .distantPast)
        #expect(homes.last?.end == .distantFuture)
        if let boundary = homes.first?.end {
            #expect(boundary > jan2024.addingTimeInterval(150 * day))
            #expect(boundary < jan2024.addingTimeInterval(260 * day))
        }

        let tokyoDay = jan2024.addingTimeInterval(72 * day)
        let homeThen = ExperienceGrouper.home(at: tokyoDay, in: homes)
        #expect(abs((homeThen?.latitude ?? 0) - 17.385) < 0.05)
    }
}

struct ExperienceGrouperTests {
    private let home = HomeEstimate(latitude: 40.7, longitude: -74.0, radiusKM: 2.5)

    @Test func splitsSeparateActivitiesOnTheSameDay() {
        let morning = Date(timeIntervalSince1970: 1_700_000_000)
        let lunch = morning.addingTimeInterval(5 * 3600)
        var photos: [ExperienceCandidate] = []
        for index in 0..<4 {
            photos.append(ExperienceCandidate(assetID: "hike\(index)", capturedAt: morning.addingTimeInterval(Double(index) * 600), latitude: 35.0, longitude: 139.0, quality: 0.8, isFavorite: false, labels: ["mountain", "trail"]))
        }
        for index in 0..<4 {
            photos.append(ExperienceCandidate(assetID: "meal\(index)", capturedAt: lunch.addingTimeInterval(Double(index) * 300), latitude: 35.3, longitude: 139.3, quality: 0.7, isFavorite: false, labels: ["food", "restaurant"]))
        }

        let clusters = ExperienceGrouper.cluster(photos, home: home)

        #expect(clusters.count == 2)
        #expect(clusters[0].photoIDs.first == "hike0")
        #expect(clusters[1].photoIDs.first == "meal0")
        #expect(clusters.allSatisfy { ($0.distanceFromHomeKM ?? 0) > 1000 })
        #expect(clusters[0].momentCount == 1)
        #expect(clusters[0].visitTotal == 1)
    }

    @Test func dropsSmallClustersAtHome() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        let photos = (0..<3).map { index in
            ExperienceCandidate(assetID: "home\(index)", capturedAt: start.addingTimeInterval(Double(index) * 60), latitude: 40.7, longitude: -74.0, quality: 0.5, isFavorite: false)
        }
        #expect(ExperienceGrouper.cluster(photos, home: home).isEmpty)
    }

    @Test func groupsConsecutiveAwayDaysIntoATrip() {
        let day1 = Date(timeIntervalSince1970: 1_700_000_000)
        let day2 = day1.addingTimeInterval(24 * 3600)
        var photos: [ExperienceCandidate] = []
        for index in 0..<3 {
            photos.append(ExperienceCandidate(assetID: "a\(index)", capturedAt: day1.addingTimeInterval(Double(index) * 600), latitude: 35.0, longitude: 139.0, quality: 0.8, isFavorite: false, labels: ["temple"]))
            photos.append(ExperienceCandidate(assetID: "b\(index)", capturedAt: day2.addingTimeInterval(Double(index) * 600), latitude: 35.0, longitude: 139.1, quality: 0.8, isFavorite: false, labels: ["food"]))
        }

        let clusters = ExperienceGrouper.cluster(photos, home: home)

        #expect(clusters.count == 2)
        #expect(clusters[0].tripKey == clusters[1].tripKey)
        #expect(clusters[0].tripKey != nil)
    }

    @Test func homeIsTheMostFrequentCell() {
        let start = Date(timeIntervalSince1970: 1_700_000_000)
        var photos: [ExperienceCandidate] = []
        for day in 0..<5 {
            photos.append(ExperienceCandidate(assetID: "h\(day)", capturedAt: start.addingTimeInterval(Double(day) * 86_400), latitude: 40.7, longitude: -74.0, quality: 0, isFavorite: false))
        }
        for index in 0..<20 {
            photos.append(ExperienceCandidate(assetID: "t\(index)", capturedAt: start.addingTimeInterval(Double(index) * 60), latitude: 35.0, longitude: 139.0, quality: 0, isFavorite: false))
        }
        let home = ExperienceGrouper.estimateHome(photos)
        #expect(home != nil)
        #expect(abs((home?.latitude ?? 0) - 40.7) < 0.01)
    }

    @Test func screenshotsAreNotRelevant() {
        #expect(PhotoAnalyzer.isRelevant(isScreenshot: true, isDuplicate: false, quality: 0.9, labels: [], containsPerson: false) == false)
        #expect(PhotoAnalyzer.isRelevant(isScreenshot: false, isDuplicate: false, quality: 0.9, labels: [AnalyzedLabel(name: "document", confidence: 0.95)], containsPerson: false) == false)
        #expect(PhotoAnalyzer.isRelevant(isScreenshot: false, isDuplicate: false, quality: 0.6, labels: [AnalyzedLabel(name: "beach", confidence: 0.8)], containsPerson: false))
    }
}

struct ScanPlannerTests {
    @Test func newPhotosAreInsertedAndKnownPhotosAreSkipped() {
        let captured = Date(timeIntervalSince1970: 1_700_000_000)
        let fetched = [
            photo("new", modified: captured),
            photo("kept", modified: captured),
            photo("edited", modified: captured.addingTimeInterval(90))
        ]
        let stored = [
            StoredPhotoStamp(assetID: "kept", modificationDate: captured),
            StoredPhotoStamp(assetID: "edited", modificationDate: captured),
            StoredPhotoStamp(assetID: "gone", modificationDate: captured)
        ]

        let plan = ScanPlanner.plan(fetched: fetched, stored: stored)

        #expect(plan.insertIDs == ["new"])
        #expect(plan.refreshIDs == ["edited"])
        #expect(plan.unchangedIDs == ["kept"])
        #expect(plan.missingIDs == ["gone"])
    }

    private func photo(_ id: String, modified: Date) -> IndexedPhoto {
        IndexedPhoto(
            assetID: id,
            capturedAt: modified,
            modificationDate: modified,
            latitude: 35.6,
            longitude: 139.7,
            mediaType: "image",
            pixelWidth: 100,
            pixelHeight: 100,
            duration: 0,
            isFavorite: false,
            sourceType: "library",
            isHidden: false,
            burstIdentifier: nil,
            isLocallyAvailable: true,
            isScreenshot: false
        )
    }
}
