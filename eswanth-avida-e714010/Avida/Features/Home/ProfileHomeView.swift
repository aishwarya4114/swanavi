import SwiftData
import SwiftUI

enum ProfileFilter: String, CaseIterable, Identifiable {
    case highlights = "Highlights"
    case trips = "Trips"
    case all = "All"
    case places = "Places"
    case people = "People"

    var id: String { rawValue }
}

struct ProfileHomeView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \ExperienceMoment.startDate, order: .reverse) private var moments: [ExperienceMoment]
    @Query(sort: \HomeBase.startDate) private var homes: [HomeBase]
    @AppStorage("avida.reviewedExperiences") private var reviewedExperiences = false
    @State private var places: [String: PlaceInfo] = [:]
    @State private var board: [LifeExperience] = []
    @State private var trips: [LifeTrip] = []
    @State private var filter: ProfileFilter = .highlights
    @State private var query = ""
    @State private var showScan = false
    @State private var showThisIsMe = false
    @State private var menuRoute: ProfileRoute?

    private var narrator: ExperienceNarrator { ExperienceNarrator.shared }
    private var scan: LibraryScanModel { LibraryScanModel.shared }

    /// Changes only when something that affects the board changes, so the board is rebuilt rarely.
    private var boardKey: String {
        let latest = moments.map(\.updatedAt).max() ?? .distantPast
        return "\(moments.count)|\(latest.timeIntervalSince1970)|\(places.count)"
    }

    private var filtered: [LifeExperience] {
        let searched = board.filter { experience in
            guard !query.isEmpty else { return true }
            let haystack = ([narrator.title(for: experience), experience.place, experience.category, experience.country ?? ""] + experience.tags + experience.labels)
                .joined(separator: " ").lowercased()
            return haystack.contains(query.lowercased())
        }
        switch filter {
        case .highlights:
            // Best experiences, but no single trip may crowd the list.
            var perTrip: [String: Int] = [:]
            return Array(searched.sorted { $0.score > $1.score }.filter { experience in
                guard let trip = experience.tripKey else { return true }
                perTrip[trip, default: 0] += 1
                return perTrip[trip, default: 0] <= 2
            }.prefix(12))
        case .trips:
            return []
        case .all:
            return searched
        case .places:
            var seen = Set<String>()
            return searched.sorted { $0.score > $1.score }.filter { experience in
                guard !experience.place.isEmpty else { return false }
                return seen.insert(experience.place).inserted
            }
        case .people:
            return searched.filter(\.hasPeople).sorted { $0.peopleCount > $1.peopleCount }
        }
    }

    private var filteredTrips: [LifeTrip] {
        guard !query.isEmpty else { return trips }
        let needle = query.lowercased()
        return trips.filter { trip in
            (trip.title + " " + trip.places.joined(separator: " ") + " " + trip.countries.joined(separator: " ")).lowercased().contains(needle)
        }
    }

    /// Hero carousel: the biggest trips first, then standout single experiences that aren't part of a trip.
    private var heroTrips: [LifeTrip] {
        Array(trips.sorted { $0.score > $1.score }.prefix(5))
    }

    private var heroExperiences: [LifeExperience] {
        Array(board.filter { $0.tripKey == nil }.sorted { $0.score > $1.score }.prefix(max(2, 6 - heroTrips.count)))
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                    header
                    identity
                    if scan.isRunning { scanningPill.padding(.top, 14) }
                    homesCard
                    search
                    if (!heroTrips.isEmpty || !heroExperiences.isEmpty) && query.isEmpty { highlightsCarousel }
                    filterTabs
                    rows
                    if !reviewedExperiences && !board.isEmpty {
                        reviewBanner
                    }
                }
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: UUID.self) { id in
            if let experience = board.first(where: { $0.id == id }) {
                LifeExperienceDetailView(experience: experience)
            }
        }
        .navigationDestination(for: TripRoute.self) { route in
            if let trip = trips.first(where: { $0.key == route.key }) {
                TripDetailView(trip: trip)
            }
        }
        .navigationDestination(item: $menuRoute) { route in
            destination(route)
        }
        .navigationDestination(for: ProfileRoute.self) { route in
            destination(route)
        }
        .sheet(isPresented: $showThisIsMe) {
            ThisIsMeView()
        }
        .sheet(isPresented: $showScan) {
            NavigationStack {
                AnalyzingView(scan: scan) {
                    showScan = false
                }
                .toolbar {
                    ToolbarItem(placement: .principal) { AvidaWordmark(size: 16) }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { showScan = false }
                            .foregroundStyle(AvidaColor.ink)
                    }
                }
                .toolbarBackground(AvidaColor.background, for: .navigationBar)
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .task {
            narrator.load(context: modelContext)
            await loadPlaces()
        }
        .task(id: boardKey) {
            let built = ExperienceBoard.make(moments: moments, places: places)
            let builtTrips = ExperienceBoard.trips(from: built)
            withAnimation(.snappy(duration: 0.25)) {
                board = built
                trips = builtTrips
            }
            narrator.ensure(built)
        }
    }

    @ViewBuilder
    private func destination(_ route: ProfileRoute) -> some View {
        switch route {
        case .review:
            ReviewExperiencesView {
                reviewedExperiences = true
            }
        case .library:
            PhotoGridView(albumID: LibraryScope.entireLibrary, albumTitle: "Your library")
        }
    }

    // MARK: - Sections

    private var header: some View {
        HStack {
            Color.clear.frame(width: 32, height: 32)
            Spacer()
            AvidaWordmark(size: 18)
            Spacer()
            Menu {
                Button("Review experiences", systemImage: "checklist") { menuRoute = .review }
                Button("All photos", systemImage: "photo.on.rectangle") { menuRoute = .library }
                Button("This is me", systemImage: "person.crop.circle.badge.checkmark") { showThisIsMe = true }
                Divider()
                Button(scan.isRunning ? "Show progress" : "Scan again", systemImage: scan.isRunning ? "waveform" : "arrow.clockwise") {
                    if !scan.isRunning { scan.start() }
                    showScan = true
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                    .frame(width: 32, height: 32)
                    .background(AvidaColor.card, in: Circle())
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    private var identity: some View {
        HStack(alignment: .center, spacing: 14) {
            Text("E")
                .font(.system(size: 24, weight: .semibold, design: .serif))
                .foregroundStyle(AvidaColor.ink)
                .frame(width: 64, height: 64)
                .background(AvidaColor.card, in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                Text("Eswanth")
                    .font(.system(size: 32, weight: .bold))
                    .foregroundStyle(AvidaColor.ink)
                Text(identityLine)
                    .font(.system(size: 12, weight: .medium))
                    .tracking(1.2)
                    .foregroundStyle(AvidaColor.tertiary)
                    .contentTransition(.numericText())
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
    }

    private var identityLine: String {
        var parts = ["\(board.count) EXPERIENCES"]
        if !trips.isEmpty { parts.append("\(trips.count) TRIPS") }
        let countries = Set(board.compactMap(\.country)).count
        if countries > 1 { parts.append("\(countries) COUNTRIES") }
        return parts.joined(separator: "  ·  ")
    }

    private var scanningPill: some View {
        Button {
            showScan = true
        } label: {
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                    .tint(AvidaColor.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Analyzing your library · \(Int((scan.progress * 100).rounded()))%")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                        .contentTransition(.numericText())
                    Text(remainingText)
                        .font(.system(size: 12))
                        .foregroundStyle(AvidaColor.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AvidaColor.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AvidaColor.hairline))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
    }

    private var remainingText: String {
        if let remaining = scan.estimatedRemaining {
            if remaining < 60 { return "Less than a minute left · keeps running in the background" }
            return "About \(Int((remaining / 60).rounded())) min left · keeps running in the background"
        }
        return "\(scan.processed.formatted()) of \(scan.total.formatted()) photos · keeps running in the background"
    }

    @ViewBuilder
    private var homesCard: some View {
        if !homes.isEmpty {
            HStack(spacing: 12) {
                Image(systemName: "house")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(AvidaColor.secondary)
                    .frame(width: 28, height: 28)
                    .background(AvidaColor.card, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(homesHeadline)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                    if let detail = homesDetail {
                        Text(detail)
                            .font(.system(size: 13))
                            .foregroundStyle(AvidaColor.secondary)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
        }
    }

    private func homeName(_ home: HomeBase) -> String {
        places[home.key]?.display ?? "Home"
    }

    private var homesHeadline: String {
        guard let current = homes.last else { return "" }
        let name = homeName(current)
        if homes.count == 1 { return "Home · \(name)" }
        let since = current.startDate == .distantPast ? "" : " since \(current.startDate.formatted(.dateTime.month(.abbreviated).year()))"
        return "Home · \(name)\(since)"
    }

    private var homesDetail: String? {
        guard homes.count > 1 else { return nil }
        let earlier = homes.dropLast().reversed().map { home -> String in
            let name = homeName(home)
            let start = home.startDate == .distantPast ? nil : home.startDate.formatted(.dateTime.year())
            let end = home.endDate == .distantFuture ? nil : home.endDate.formatted(.dateTime.year())
            if let start, let end, start != end { return "\(name) \(start)–\(end)" }
            if let end { return "\(name) until \(end)" }
            return name
        }
        return "Before that: " + earlier.joined(separator: " · ")
    }

    private var search: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AvidaColor.secondary)
            TextField("Search places, people, moments", text: $query)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(AvidaColor.tertiary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(AvidaColor.hairline))
        .padding(.horizontal, 20)
        .padding(.top, 16)
    }

    private var highlightsCarousel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What defines you")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(AvidaColor.ink)
                .padding(.horizontal, 20)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 12) {
                    ForEach(heroTrips) { trip in
                        NavigationLink(value: TripRoute(key: trip.key)) {
                            TripCard(trip: trip)
                        }
                        .buttonStyle(.plain)
                    }
                    ForEach(heroExperiences) { experience in
                        NavigationLink(value: experience.id) {
                            HighlightCard(experience: experience, title: narrator.title(for: experience))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 14)
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollIndicators(.hidden)
        }
        .padding(.top, 24)
    }

    private var filterTabs: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 6) {
                ForEach(ProfileFilter.allCases) { item in
                    let selected = filter == item
                    Button {
                        withAnimation(.snappy(duration: 0.25)) { filter = item }
                    } label: {
                        Text(item.rawValue)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(selected ? Color.white : AvidaColor.ink)
                            .padding(.horizontal, 14)
                            .frame(height: 34)
                            .background(selected ? AvidaColor.ink : Color.white, in: Capsule())
                            .overlay(Capsule().stroke(selected ? Color.clear : AvidaColor.hairline))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
        .scrollIndicators(.hidden)
        .padding(.top, 22)
        .sensoryFeedback(.selection, trigger: filter)
    }

    private var rows: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if filter == .trips {
                if filteredTrips.isEmpty {
                    tripsEmptyState
                } else {
                    ForEach(filteredTrips) { trip in
                        NavigationLink(value: TripRoute(key: trip.key)) {
                            TripRow(trip: trip)
                        }
                        .buttonStyle(RowPressStyle())
                    }
                }
            } else if filtered.isEmpty {
                emptyState
            } else if filter == .all {
                ForEach(yearGroups, id: \.year) { group in
                    Text(group.year)
                        .font(.system(size: 13, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(AvidaColor.tertiary)
                        .padding(.horizontal, 20)
                        .padding(.top, 22)
                        .padding(.bottom, 4)
                    ForEach(group.items) { experience in
                        row(experience)
                    }
                }
            } else {
                ForEach(Array(filtered.enumerated()), id: \.element.id) { index, experience in
                    row(experience, number: filter == .highlights ? index + 1 : nil)
                }
            }
        }
        .padding(.top, 8)
    }

    private var tripsEmptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No trips yet")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AvidaColor.ink)
            Text(homes.isEmpty
                 ? "Trips are found once Avida knows where home is — that needs photos with location over a few months."
                 : "A trip is two or more days of experiences 60 km or more from home. None found so far.")
                .font(.system(size: 15))
                .foregroundStyle(AvidaColor.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 32)
    }

    private struct YearGroup { let year: String; let items: [LifeExperience] }

    private var yearGroups: [YearGroup] {
        var order: [String] = []
        var map: [String: [LifeExperience]] = [:]
        for experience in filtered {
            let year = experience.year.isEmpty ? "Undated" : experience.year
            if map[year] == nil { order.append(year) }
            map[year, default: []].append(experience)
        }
        return order.map { YearGroup(year: $0, items: map[$0] ?? []) }
    }

    private func row(_ experience: LifeExperience, number: Int? = nil) -> some View {
        NavigationLink(value: experience.id) {
            ExperienceRow(experience: experience, title: narrator.title(for: experience), number: number)
        }
        .buttonStyle(RowPressStyle())
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(board.isEmpty ? "No experiences yet" : "Nothing here yet")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(AvidaColor.ink)
            Text(board.isEmpty
                 ? "Scan your library and Avida will find the days, trips and places that belong together."
                 : "Try another filter or clear the search.")
                .font(.system(size: 15))
                .foregroundStyle(AvidaColor.secondary)
            if board.isEmpty && !scan.isRunning {
                AvidaPrimaryButton(title: "Analyze your library", systemImage: "sparkles") {
                    scan.start()
                    showScan = true
                }
                .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 32)
    }

    private var reviewBanner: some View {
        NavigationLink(value: ProfileRoute.review) {
            HStack(spacing: 12) {
                Image(systemName: "tray")
                    .font(.system(size: 16))
                    .foregroundStyle(AvidaColor.secondary)
                Text("\(board.count) experiences ready for review")
                    .font(.system(size: 15))
                    .foregroundStyle(AvidaColor.ink)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AvidaColor.tertiary)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Data

    private func loadPlaces() async {
        places = await PlaceNameCache.shared.stored()
        var pending: [(key: String, latitude: Double, longitude: Double)] = []
        for home in homes where places[home.key] == nil {
            pending.append((home.key, home.latitude, home.longitude))
        }
        for moment in moments.sorted(by: { $0.confidence > $1.confidence }) {
            guard let key = moment.region, places[key] == nil, let latitude = moment.latitude, let longitude = moment.longitude else { continue }
            pending.append((key, latitude, longitude))
        }
        var seen = Set<String>()
        for item in pending where seen.insert(item.key).inserted {
            if let info = await PlaceNameCache.shared.resolve(latitude: item.latitude, longitude: item.longitude) {
                places[item.key] = info
            }
        }
    }
}

enum ProfileRoute: Hashable {
    case review
    case library
}

// MARK: - Components

struct ExperienceRow: View {
    let experience: LifeExperience
    let title: String
    var number: Int? = nil

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if let cover = experience.coverAssetID {
                AssetThumbnail(assetID: cover, side: 64, cornerRadius: 14)
                    .overlay(alignment: .bottomLeading) {
                        if let number {
                            Text("\(number)")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.black.opacity(0.55), in: Capsule())
                                .padding(5)
                        }
                    }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(meta)
                    .font(.system(size: 14))
                    .foregroundStyle(AvidaColor.secondary)
                    .lineLimit(1)
                if let reason = experience.reasons.first {
                    HStack(spacing: 5) {
                        Image(systemName: reason.symbol)
                            .font(.system(size: 11, weight: .semibold))
                        Text(reason.text)
                            .font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                    }
                    .foregroundStyle(AvidaColor.accent)
                }
            }
            Spacer(minLength: 6)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AvidaColor.tertiary)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle().fill(AvidaColor.hairline).frame(height: 1).padding(.leading, 98)
        }
    }

    private var meta: String {
        let place = experience.place.isEmpty ? (experience.homePlace.map { "Near home · \($0)" } ?? "Near home") : experience.place
        let when = experience.start?.formatted(.dateTime.month(.abbreviated).year()) ?? ""
        return [place, when, "\(experience.photoIDs.count) photos"].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct HighlightCard: View {
    let experience: LifeExperience
    let title: String

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let cover = experience.coverAssetID {
                AssetImage(assetID: cover, pixelSide: 1200)
            } else {
                AvidaColor.card
            }
            LinearGradient(colors: [.clear, .black.opacity(0.05), .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 5) {
                Text(experience.category.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.1)
                    .foregroundStyle(.white.opacity(0.85))
                Text(title)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text([experience.place, experience.year].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            }
            .padding(16)
        }
        .frame(width: 250, height: 360)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 8)
    }
}

struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AvidaColor.card.opacity(0.7) : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
