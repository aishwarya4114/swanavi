import Foundation

nonisolated struct ExperienceReason: Hashable, Identifiable, Sendable {
    var symbol: String
    var text: String
    var weight: Double

    var id: String { text }
}

nonisolated struct LifeExperience: Identifiable, Hashable, Sendable {
    var id: UUID
    var key: String
    var title: String
    var place: String
    var landmark: String?
    var country: String?
    var homePlace: String?
    var category: String
    var year: String
    var monthYear: String
    var summary: String
    var whyItMattered: String
    var reasons: [ExperienceReason]
    var photoIDs: [String]
    var tags: [String]
    var labels: [String]
    var hasPeople: Bool
    var peopleCount: Int
    var favoriteCount: Int
    var momentCount: Int
    var visitIndex: Int
    var visitTotal: Int
    var score: Double
    var latitude: Double?
    var longitude: Double?
    var distanceFromHomeKM: Double?
    var start: Date?
    var end: Date?
    var placeKey: String?
    var tripKey: String?
    var tripTitle: String?
    var tripDays: Int
    var tripDayIndex: Int
    var dayCount: Int
    var timeOfDay: String
    var facts: ExperienceFacts
    var selfPhotoIDs: [String] = []
    var othersPhotoIDs: [String] = []

    var coverAssetID: String? { photoIDs.first }
    var includesMe: Bool { !selfPhotoIDs.isEmpty }
    var includesOthers: Bool { !othersPhotoIDs.isEmpty }

    /// Photos for a people scope. "Just me" keeps every photo nobody else is in (scenery included).
    func photoIDs(for scope: PeopleScope) -> [String] {
        switch scope {
        case .everyone: return photoIDs
        case .justMe:
            let others = Set(othersPhotoIDs)
            return photoIDs.filter { !others.contains($0) }
        }
    }
}

/// Several experiences away from home that belong to one journey.
nonisolated struct LifeTrip: Identifiable, Hashable, Sendable {
    var id: String { key }
    var key: String
    var title: String
    var subtitle: String
    var places: [String]
    var countries: [String]
    var start: Date
    var end: Date
    var dayCount: Int
    var photoCount: Int
    var coverAssetID: String?
    var score: Double
    var distanceFromHomeKM: Double?
    var homePlace: String?
    var experiences: [LifeExperience]
    var reasons: [ExperienceReason]

    var year: String { start.formatted(.dateTime.year()) }
    var dateRange: String {
        let sameMonth = Calendar.current.isDate(start, equalTo: end, toGranularity: .month)
        if sameMonth {
            return "\(start.formatted(.dateTime.month(.abbreviated).day())) – \(end.formatted(.dateTime.day().year()))"
        }
        return "\(start.formatted(.dateTime.month(.abbreviated).day())) – \(end.formatted(.dateTime.month(.abbreviated).day().year()))"
    }
}

nonisolated struct ExperienceFacts: Hashable, Sendable {
    var place: String
    var landmark: String?
    var country: String?
    var homePlace: String?
    var category: String
    var labels: [String]
    var photoCount: Int
    var momentCount: Int
    var dayCount: Int
    var durationHours: Double
    var weekday: String
    var timeOfDay: String
    var monthYear: String
    var hasPeople: Bool
    var peopleCount: Int
    var favoriteCount: Int
    var distanceFromHomeKM: Double?
    var visitIndex: Int
    var visitTotal: Int
    var isFirstInCountry: Bool
    var isLongestTripOfYear: Bool
    var categoryCountInLibrary: Int
    var tripTitle: String?
    var tripDays: Int
    var tripDayIndex: Int
    var selfPhotoCount: Int = 0
    var othersPhotoCount: Int = 0

    var hash: String {
        var hasher = Hasher()
        hasher.combine(self)
        return String(hasher.finalize(), radix: 36)
    }

    var placeName: String? {
        landmark ?? (place.isEmpty ? nil : place)
    }
}

nonisolated enum ExperienceCopy {
    private static let categoryRules: [(String, [String])] = [
        ("Culinary", ["food", "restaurant", "dining", "sushi", "meal", "cafe", "coffee", "dessert", "cake", "pizza", "ramen", "noodle", "drink", "cocktail", "wine", "beer", "bar", "breakfast", "lunch", "dinner", "bakery", "market"]),
        ("Wildlife", ["animal", "wildlife", "bird", "zoo", "monkey", "whale", "aquarium", "deer", "elephant", "dog", "cat", "horse", "fish", "safari"]),
        ("Nature", ["mountain", "beach", "ocean", "coast", "forest", "snow", "lake", "hiking", "waterfall", "river", "valley", "desert", "canyon", "sunset", "sunrise", "garden", "flower", "cherry", "island", "volcano", "glacier", "cliff", "trail", "camping"]),
        ("Culture", ["temple", "shrine", "museum", "castle", "cathedral", "church", "palace", "monument", "statue", "architecture", "pagoda", "ruins", "historic", "gallery", "painting", "sculpture", "theater", "library", "landmark"]),
        ("City", ["city", "skyline", "skyscraper", "street", "downtown", "bridge", "tower", "night", "neon", "subway", "train", "station", "harbor", "market", "square"]),
        ("Event", ["concert", "festival", "stage", "stadium", "parade", "fireworks", "wedding", "party", "ceremony", "graduation", "birthday", "performance", "sport", "game", "race", "match"]),
        ("Adventure", ["ski", "snowboard", "surf", "dive", "kayak", "boat", "sailing", "climbing", "bike", "cycling", "roller", "amusement", "ride", "flight", "airplane", "helicopter"])
    ]

    static func category(for labels: [String]) -> String {
        let text = labels.map { $0.lowercased() }
        var scores: [String: Int] = [:]
        for (position, label) in text.enumerated() {
            for (category, words) in categoryRules where words.contains(where: { label.contains($0) }) {
                scores[category, default: 0] += max(1, 5 - position)
            }
        }
        return scores.max { $0.value < $1.value }?.key ?? "Travel"
    }

    static func timeOfDay(start: Date?, end: Date?) -> String {
        guard let start else { return "" }
        let hour = Calendar.current.component(.hour, from: start)
        if let end, end.timeIntervalSince(start) > 8 * 3600 { return "day" }
        switch hour {
        case 5..<9: return "morning"
        case 9..<12: return "late morning"
        case 12..<17: return "afternoon"
        case 17..<21: return "evening"
        default: return "night"
        }
    }

    static func humanize(_ label: String) -> String {
        label.replacingOccurrences(of: "_", with: " ").lowercased()
    }

    // MARK: Title

    static func fallbackTitle(_ facts: ExperienceFacts) -> String {
        let place = facts.placeName
        let labels = facts.labels.map(humanize)
        let first = labels.first
        if facts.tripDays >= 2, facts.tripDayIndex >= 1, let city = facts.place.isEmpty ? place : facts.place {
            if let landmark = facts.landmark, landmark != facts.place { return landmark }
            return "Day \(facts.tripDayIndex) in \(city)"
        }
        if facts.dayCount >= 2, let place {
            return "\(facts.dayCount) days in \(place)"
        }
        switch facts.category {
        case "Culinary":
            if let place { return facts.timeOfDay == "evening" || facts.timeOfDay == "night" ? "Dinner in \(place)" : "A meal in \(place)" }
            return "A meal worth remembering"
        case "Wildlife":
            if let animal = labels.first(where: { !["animal", "wildlife"].contains($0) }) {
                return place.map { "\(animal.capitalized) in \($0)" } ?? "Meeting \(animal)s"
            }
            return place.map { "Wildlife in \($0)" } ?? "Close to wildlife"
        case "Nature":
            if let first, let place { return "\(first.capitalized) at \(place)" }
            return place.map { "Outdoors in \($0)" } ?? "A day outdoors"
        case "Culture":
            if let landmark = facts.landmark { return "Visiting \(landmark)" }
            return place.map { "Old \($0)" } ?? "A cultural stop"
        case "City":
            if let place { return facts.timeOfDay == "night" || facts.timeOfDay == "evening" ? "\(place) after dark" : "Walking \(place)" }
            return "City streets"
        case "Event":
            if let first, let place { return "\(first.capitalized) in \(place)" }
            return "A night out"
        case "Adventure":
            if let first, let place { return "\(first.capitalized) in \(place)" }
            return "An adventure"
        default:
            if let place {
                return facts.hasPeople ? "Together in \(place)" : "A \(facts.timeOfDay.isEmpty ? "day" : facts.timeOfDay) in \(place)"
            }
            return facts.hasPeople ? "Time with people" : "Moments worth remembering"
        }
    }

    // MARK: Summary

    static func fallbackSummary(_ facts: ExperienceFacts) -> String {
        var sentences: [String] = []

        var opening = ""
        let when: String = {
            if facts.weekday.isEmpty { return facts.monthYear.isEmpty ? "" : "In \(facts.monthYear)" }
            let time = facts.timeOfDay == "day" || facts.timeOfDay.isEmpty ? "" : " \(facts.timeOfDay)"
            return "On a \(facts.weekday)\(time)" + (facts.monthYear.isEmpty ? "" : " in \(facts.monthYear)")
        }()
        let duration: String = {
            if facts.dayCount >= 2 { return "\(facts.dayCount) days" }
            if facts.durationHours >= 1.5 { return "about \(Int(facts.durationHours.rounded())) hours" }
            if facts.durationHours >= 0.4 { return "an hour or so" }
            return "a short while"
        }()
        let where_: String = {
            if let landmark = facts.landmark, !facts.place.isEmpty, landmark != facts.place { return "around \(landmark) in \(facts.place)" }
            if let name = facts.placeName { return "in \(name)" }
            return facts.homePlace.map { "near home in \($0)" } ?? "close to home"
        }()
        opening = "\(when.isEmpty ? "You" : when + ", you") spent \(duration) \(where_)"
        let things = facts.labels.prefix(3).map(humanize)
        if !things.isEmpty {
            opening += " — " + join(things)
        }
        sentences.append(opening + ".")

        var scale = "\(facts.photoCount) photo\(facts.photoCount == 1 ? "" : "s")"
        if facts.momentCount >= 2 { scale += " across \(facts.momentCount) moments" }
        if facts.favoriteCount > 0 { scale += ", \(facts.favoriteCount) of them favorites" }
        sentences.append(scale + ".")

        if facts.selfPhotoCount > 0, facts.othersPhotoCount > 0 {
            sentences.append("You're in \(facts.selfPhotoCount) of them, with others in \(facts.othersPhotoCount).")
        } else if facts.selfPhotoCount > 0 {
            sentences.append("You're in \(facts.selfPhotoCount) of them.")
        } else if facts.peopleCount > 0 {
            sentences.append(facts.peopleCount >= 3 ? "People are in \(facts.peopleCount) of the photos." : "You weren't alone.")
        }
        if let trip = facts.tripTitle {
            sentences.append("Part of your \(trip).")
        }
        return sentences.joined(separator: " ")
    }

    // MARK: Why it mattered

    static func reasons(_ facts: ExperienceFacts) -> [ExperienceReason] {
        var reasons: [ExperienceReason] = []
        if facts.isFirstInCountry, let country = facts.country {
            reasons.append(ExperienceReason(symbol: "flag", text: "Your first photos in \(country)", weight: 1))
        }
        if let distance = facts.distanceFromHomeKM, distance >= 60 {
            let rounded = distance >= 1000 ? (distance / 100).rounded() * 100 : (distance / 10).rounded() * 10
            let from = facts.homePlace.map { " from home in \($0)" } ?? " from home"
            reasons.append(ExperienceReason(symbol: "airplane", text: "\(Int(rounded).formatted()) km\(from)", weight: min(0.95, 0.5 + distance / 20_000)))
        }
        if facts.visitTotal == 1, let place = facts.placeName {
            reasons.append(ExperienceReason(symbol: "sparkle", text: "The only time you've been to \(place)", weight: 0.85))
        } else if facts.visitIndex == 1, facts.visitTotal > 1, let place = facts.placeName {
            reasons.append(ExperienceReason(symbol: "1.circle", text: "Your first of \(facts.visitTotal) visits to \(place)", weight: 0.7))
        }
        if facts.isLongestTripOfYear, facts.tripDays >= 3 {
            reasons.append(ExperienceReason(symbol: "suitcase", text: "Part of your longest trip that year — \(facts.tripDays) days", weight: 0.8))
        } else if facts.tripDays >= 2 {
            reasons.append(ExperienceReason(symbol: "suitcase", text: "Day \(facts.tripDayIndex) of a \(facts.tripDays)-day trip", weight: 0.45))
        }
        if facts.favoriteCount > 0 {
            reasons.append(ExperienceReason(symbol: "heart", text: "You favorited \(facts.favoriteCount) photo\(facts.favoriteCount == 1 ? "" : "s") here", weight: 0.6 + min(0.3, Double(facts.favoriteCount) * 0.1)))
        }
        if facts.selfPhotoCount > 0, facts.othersPhotoCount > 0 {
            reasons.append(ExperienceReason(symbol: "person.2", text: "You and others in \(facts.othersPhotoCount) photo\(facts.othersPhotoCount == 1 ? "" : "s")", weight: 0.55))
        } else if facts.othersPhotoCount >= 3 {
            reasons.append(ExperienceReason(symbol: "person.2", text: "People in \(facts.othersPhotoCount) photos", weight: 0.5))
        } else if facts.selfPhotoCount > 0 {
            reasons.append(ExperienceReason(symbol: "person.crop.circle", text: "You're in \(facts.selfPhotoCount) photo\(facts.selfPhotoCount == 1 ? "" : "s")", weight: 0.45))
        } else if facts.peopleCount > 0 {
            reasons.append(ExperienceReason(symbol: "person", text: "You weren't alone", weight: 0.3))
        }
        if facts.dayCount >= 2 {
            reasons.append(ExperienceReason(symbol: "calendar", text: "Stretched over \(facts.dayCount) days", weight: 0.5))
        } else if facts.momentCount >= 3 {
            reasons.append(ExperienceReason(symbol: "clock", text: "\(facts.momentCount) separate moments through the \(facts.timeOfDay == "day" || facts.timeOfDay.isEmpty ? "day" : facts.timeOfDay)", weight: 0.4))
        }
        if facts.categoryCountInLibrary > 0, facts.categoryCountInLibrary <= 2 {
            reasons.append(ExperienceReason(symbol: "star", text: "One of only \(facts.categoryCountInLibrary) \(facts.category.lowercased()) experiences in your library", weight: 0.65))
        }
        if facts.photoCount >= 40 {
            reasons.append(ExperienceReason(symbol: "photo.stack", text: "\(facts.photoCount) photos — you kept shooting", weight: 0.35))
        }
        if reasons.isEmpty {
            reasons.append(ExperienceReason(symbol: "photo", text: "A moment you chose to keep", weight: 0.1))
        }
        return reasons.sorted { $0.weight > $1.weight }
    }

    static func fallbackWhy(_ facts: ExperienceFacts) -> String {
        let top = reasons(facts).prefix(2).map(\.text)
        guard let first = top.first else { return "A moment you chose to keep." }
        if top.count == 2 {
            return "\(first). \(top[1])."
        }
        return first + "."
    }

    private static func join(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default: return items.dropLast().joined(separator: ", ") + " and " + items.last!
        }
    }
}

nonisolated enum ExperienceBoard {
    static func make(moments: [ExperienceMoment], places: [String: PlaceInfo] = [:]) -> [LifeExperience] {
        let calendar = Calendar.current
        let ordered = moments
            .filter { !$0.photoIDs.isEmpty }
            .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }

        // Trip context.
        var tripDays: [String: Set<Date>] = [:]
        var tripStart: [String: Date] = [:]
        var tripPlaces: [String: [String]] = [:]
        for moment in ordered {
            guard let trip = moment.tripKey, let start = moment.startDate else { continue }
            tripDays[trip, default: []].insert(calendar.startOfDay(for: start))
            if let end = moment.endDate { tripDays[trip, default: []].insert(calendar.startOfDay(for: end)) }
            tripStart[trip] = min(tripStart[trip] ?? start, start)
            if let key = moment.region, let place = places[key]?.display, !place.isEmpty {
                tripPlaces[trip, default: []].append(place)
            }
        }
        var longestTripByYear: [Int: (String, Int)] = [:]
        for (trip, days) in tripDays {
            guard let start = tripStart[trip] else { continue }
            let year = calendar.component(.year, from: start)
            if days.count > (longestTripByYear[year]?.1 ?? 0) { longestTripByYear[year] = (trip, days.count) }
        }

        // Library-wide context: categories and countries seen so far (chronologically).
        var categoryCounts: [String: Int] = [:]
        let categories = ordered.map { ExperienceCopy.category(for: $0.topLabels) }
        for category in categories { categoryCounts[category, default: 0] += 1 }
        var seenCountries = Set<String>()

        var experiences: [LifeExperience] = []
        for (index, moment) in ordered.enumerated() {
            let labels = moment.topLabels
            let key = moment.region
            let info = key.flatMap { places[$0] }
            let place = info?.display ?? ""
            let homePlace = moment.homeKey.flatMap { places[$0]?.display }
            let category = categories[index]
            let start = moment.startDate
            let end = moment.endDate
            let year = start?.formatted(.dateTime.year()) ?? ""
            let monthYear = start?.formatted(.dateTime.month(.wide).year()) ?? ""
            let weekday = start?.formatted(.dateTime.weekday(.wide)) ?? ""
            let dayCount: Int = {
                guard let start, let end else { return 1 }
                return (calendar.dateComponents([.day], from: calendar.startOfDay(for: start), to: calendar.startOfDay(for: end)).day ?? 0) + 1
            }()
            let durationHours = (start.flatMap { s in end.map { $0.timeIntervalSince(s) } } ?? 0) / 3600
            let tripDayCount = moment.tripKey.flatMap { tripDays[$0]?.count } ?? 0
            let tripDayIndex: Int = {
                guard let trip = moment.tripKey, let first = tripStart[trip], let start else { return 0 }
                return (calendar.dateComponents([.day], from: calendar.startOfDay(for: first), to: calendar.startOfDay(for: start)).day ?? 0) + 1
            }()
            let tripTitle: String? = moment.tripKey.flatMap { trip in
                guard tripDayCount >= 2 else { return nil }
                let names = Array(Set(tripPlaces[trip] ?? [])).sorted()
                let where_ = names.count == 1 ? names[0] : (names.count > 1 ? "\(names[0]) and more" : "away")
                return "\(tripDayCount)-day trip to \(where_)"
            }
            let isLongestTrip = moment.tripKey.flatMap { trip in
                start.map { longestTripByYear[calendar.component(.year, from: $0)]?.0 == trip }
            } ?? false
            let isFirstInCountry: Bool = {
                guard let country = info?.country, (moment.distanceFromHomeKM ?? 0) >= ExperienceGrouper.awayFromHomeKM else { return false }
                return seenCountries.insert(country).inserted
            }()
            let timeOfDay = ExperienceCopy.timeOfDay(start: start, end: end)
            let facts = ExperienceFacts(
                place: place,
                landmark: info?.landmark,
                country: info?.country,
                homePlace: homePlace,
                category: category,
                labels: labels,
                photoCount: moment.photoIDs.count,
                momentCount: moment.momentCount,
                dayCount: dayCount,
                durationHours: durationHours,
                weekday: weekday,
                timeOfDay: timeOfDay,
                monthYear: monthYear,
                hasPeople: moment.hasPeople,
                peopleCount: moment.peopleCount,
                favoriteCount: moment.favoriteCount,
                distanceFromHomeKM: moment.distanceFromHomeKM,
                visitIndex: moment.visitIndex,
                visitTotal: moment.visitTotal,
                isFirstInCountry: isFirstInCountry,
                isLongestTripOfYear: isLongestTrip,
                categoryCountInLibrary: categoryCounts[category] ?? 0,
                tripTitle: tripTitle,
                tripDays: tripDayCount,
                tripDayIndex: tripDayIndex,
                selfPhotoCount: moment.selfPhotoIDs.count,
                othersPhotoCount: moment.othersPhotoIDs.count
            )
            let reasons = ExperienceCopy.reasons(facts)
            let tags = Array(Set([category] + labels.prefix(2).map { ExperienceCopy.humanize($0).capitalized })).sorted()
            experiences.append(LifeExperience(
                id: moment.id,
                key: moment.key,
                title: ExperienceCopy.fallbackTitle(facts),
                place: place,
                landmark: info?.landmark,
                country: info?.country,
                homePlace: homePlace,
                category: category,
                year: year,
                monthYear: monthYear,
                summary: ExperienceCopy.fallbackSummary(facts),
                whyItMattered: ExperienceCopy.fallbackWhy(facts),
                reasons: reasons,
                photoIDs: moment.photoIDs,
                tags: tags,
                labels: labels,
                hasPeople: moment.hasPeople,
                peopleCount: moment.peopleCount,
                favoriteCount: moment.favoriteCount,
                momentCount: moment.momentCount,
                visitIndex: moment.visitIndex,
                visitTotal: moment.visitTotal,
                score: min(1, moment.confidence + (isFirstInCountry ? 0.08 : 0)),
                latitude: moment.latitude,
                longitude: moment.longitude,
                distanceFromHomeKM: moment.distanceFromHomeKM,
                start: start,
                end: end,
                placeKey: key,
                tripKey: moment.tripKey,
                tripTitle: tripTitle,
                tripDays: tripDayCount,
                tripDayIndex: tripDayIndex,
                dayCount: dayCount,
                timeOfDay: timeOfDay,
                facts: facts,
                selfPhotoIDs: moment.selfPhotoIDs,
                othersPhotoIDs: moment.othersPhotoIDs
            ))
        }
        return experiences.sorted { ($0.start ?? .distantPast) > ($1.start ?? .distantPast) }
    }

    static func facts(_ experience: LifeExperience) -> ExperienceFacts {
        experience.facts
    }

    /// Folds experiences that share a trip into one `LifeTrip`, newest first.
    static func trips(from experiences: [LifeExperience]) -> [LifeTrip] {
        let calendar = Calendar.current
        var groups: [String: [LifeExperience]] = [:]
        for experience in experiences {
            guard let key = experience.tripKey else { continue }
            groups[key, default: []].append(experience)
        }
        var longestByYear: [Int: Int] = [:]
        var built: [LifeTrip] = []
        for (key, members) in groups {
            let ordered = members.sorted { ($0.start ?? .distantPast) < ($1.start ?? .distantPast) }
            guard let start = ordered.first?.start, let end = ordered.compactMap(\.end).max() else { continue }
            let dayCount = (calendar.dateComponents([.day], from: calendar.startOfDay(for: start), to: calendar.startOfDay(for: end)).day ?? 0) + 1
            guard dayCount >= 2 || ordered.count >= 3 else { continue }

            var placeCounts: [String: Int] = [:]
            for experience in ordered where !experience.place.isEmpty {
                placeCounts[experience.place, default: 0] += experience.photoIDs.count
            }
            let places = placeCounts.sorted { $0.value > $1.value }.map(\.key)
            let countries = Array(Set(ordered.compactMap(\.country))).sorted()
            let photoCount = ordered.reduce(0) { $0 + $1.photoIDs.count }
            let best = ordered.max { $0.score < $1.score }
            let distance = ordered.compactMap(\.distanceFromHomeKM).max()
            let homePlace = ordered.compactMap(\.homePlace).first

            let title: String
            if countries.count > 1 {
                title = countries.prefix(2).joined(separator: " & ") + (countries.count > 2 ? " and more" : "")
            } else if places.count >= 2 {
                title = "\(places[0]) & \(places[1])"
            } else if let place = places.first {
                title = place
            } else if let country = countries.first {
                title = country
            } else {
                title = "A trip away"
            }
            let subtitle = "\(dayCount) days · \(ordered.count) experiences · \(photoCount) photos"

            var reasons: [ExperienceReason] = []
            if let distance, distance >= 60 {
                let rounded = distance >= 1000 ? (distance / 100).rounded() * 100 : (distance / 10).rounded() * 10
                reasons.append(ExperienceReason(symbol: "airplane", text: "\(Int(rounded).formatted()) km from home\(homePlace.map { " in \($0)" } ?? "")", weight: 0.8))
            }
            if countries.count > 1 {
                reasons.append(ExperienceReason(symbol: "globe", text: "\(countries.count) countries in one trip", weight: 0.75))
            }
            if let first = ordered.first(where: { $0.reasons.contains { $0.symbol == "flag" } }), let country = first.country {
                reasons.append(ExperienceReason(symbol: "flag", text: "Your first time in \(country)", weight: 0.95))
            }
            let favorites = ordered.reduce(0) { $0 + $1.favoriteCount }
            if favorites > 0 {
                reasons.append(ExperienceReason(symbol: "heart", text: "\(favorites) favorited photo\(favorites == 1 ? "" : "s")", weight: 0.6))
            }
            if places.count >= 3 {
                reasons.append(ExperienceReason(symbol: "map", text: "\(places.count) places: \(places.prefix(3).joined(separator: ", "))", weight: 0.55))
            }
            reasons.append(ExperienceReason(symbol: "calendar", text: "\(dayCount) days away", weight: 0.4))

            let year = calendar.component(.year, from: start)
            longestByYear[year] = max(longestByYear[year] ?? 0, dayCount)
            let score = min(1, (best?.score ?? 0.5) + min(0.25, Double(dayCount) * 0.03) + min(0.1, Double(ordered.count) * 0.01))
            built.append(LifeTrip(
                key: key, title: title, subtitle: subtitle, places: places, countries: countries,
                start: start, end: end, dayCount: dayCount, photoCount: photoCount,
                coverAssetID: best?.coverAssetID ?? ordered.first?.coverAssetID, score: score,
                distanceFromHomeKM: distance, homePlace: homePlace, experiences: ordered,
                reasons: reasons.sorted { $0.weight > $1.weight }
            ))
        }
        for index in built.indices {
            let year = calendar.component(.year, from: built[index].start)
            if longestByYear[year] == built[index].dayCount, built[index].dayCount >= 3 {
                built[index].reasons.insert(ExperienceReason(symbol: "suitcase", text: "Your longest trip of \(year)", weight: 0.9), at: 0)
                built[index].score = min(1, built[index].score + 0.05)
            }
        }
        return built.sorted { $0.start > $1.start }
    }

    static func placeKey(latitude: Double, longitude: Double) -> String {
        String(format: "%.2f,%.2f", latitude, longitude)
    }
}
