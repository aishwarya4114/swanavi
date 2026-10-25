import SwiftData
import SwiftUI

struct ReviewExperiencesView: View {
    var onFinish: () -> Void

    @Environment(\.modelContext) private var modelContext
    @Query(sort: \ExperienceMoment.startDate, order: .reverse) private var moments: [ExperienceMoment]
    @State private var places: [String: PlaceInfo] = [:]
    @State private var board: [LifeExperience] = []

    private var narrator: ExperienceNarrator { ExperienceNarrator.shared }

    private var boardKey: String {
        let latest = moments.map(\.updatedAt).max() ?? .distantPast
        return "\(moments.count)|\(latest.timeIntervalSince1970)|\(places.count)"
    }

    private var highlights: [LifeExperience] {
        Array(board.sorted { $0.score > $1.score }.prefix(5))
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Rectangle()
                        .fill(AvidaColor.accent)
                        .frame(height: 3)
                        .frame(maxWidth: 120, alignment: .leading)
                        .padding(.bottom, 18)

                    Text("We found \(board.count) experiences.")
                        .font(.system(size: 36, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.numericText())

                    Text("Here are the ones that stand out most. Everything stays on this iPhone.")
                        .font(.system(size: 17))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.top, 10)
                        .fixedSize(horizontal: false, vertical: true)

                    if highlights.isEmpty {
                        Text("Your photos are indexed, and none of them grouped into an experience yet. Open your profile to scan again or browse the library.")
                            .font(.system(size: 16))
                            .foregroundStyle(AvidaColor.secondary)
                            .padding(.top, 24)
                    } else {
                        ForEach(highlights) { experience in
                            reviewCard(experience)
                                .padding(.top, 20)
                        }
                    }

                    AvidaPrimaryButton(
                        title: board.isEmpty ? "Open your profile" : "Open your profile",
                        systemImage: "chevron.right",
                        action: onFinish
                    )
                    .padding(.top, 28)
                    .padding(.bottom, 12)
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .navigationDestination(for: UUID.self) { id in
            if let experience = board.first(where: { $0.id == id }) {
                LifeExperienceDetailView(experience: experience)
            }
        }
        .task {
            narrator.load(context: modelContext)
            await loadPlaces()
        }
        .task(id: boardKey) {
            let built = ExperienceBoard.make(moments: moments, places: places)
            withAnimation(.snappy(duration: 0.25)) { board = built }
            narrator.ensure(Array(built.sorted { $0.score > $1.score }.prefix(5)))
        }
    }

    private func reviewCard(_ experience: LifeExperience) -> some View {
        NavigationLink(value: experience.id) {
            VStack(alignment: .leading, spacing: 0) {
                ZStack(alignment: .bottomLeading) {
                    if let cover = experience.coverAssetID {
                        AssetImage(assetID: cover, pixelSide: 1200)
                    } else {
                        AvidaColor.card
                    }
                    LinearGradient(colors: [.clear, .black.opacity(0.7)], startPoint: .center, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(experience.category.uppercased())
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(1.1)
                            .foregroundStyle(.white.opacity(0.85))
                        Text(narrator.title(for: experience))
                            .font(.system(size: 22, weight: .bold))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.leading)
                    }
                    .padding(16)
                }
                .frame(height: 210)
                .clipped()

                VStack(alignment: .leading, spacing: 10) {
                    Text(meta(experience))
                        .font(.system(size: 14))
                        .foregroundStyle(AvidaColor.secondary)
                    if let reason = experience.reasons.first {
                        HStack(spacing: 6) {
                            Image(systemName: reason.symbol)
                                .font(.system(size: 12, weight: .semibold))
                            Text(reason.text)
                                .font(.system(size: 14, weight: .medium))
                        }
                        .foregroundStyle(AvidaColor.accent)
                    }
                    HStack(spacing: 6) {
                        ForEach(Array(experience.photoIDs.dropFirst().prefix(5)), id: \.self) { assetID in
                            AssetThumbnail(assetID: assetID, side: 52, cornerRadius: 10)
                        }
                        Spacer()
                        HStack(spacing: 4) {
                            Image(systemName: "lock")
                            Text("Only me")
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(AvidaColor.tertiary)
                    }
                }
                .padding(16)
            }
            .background(Color.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(AvidaColor.hairline))
            .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
        }
        .buttonStyle(.plain)
    }

    private func meta(_ experience: LifeExperience) -> String {
        let place = experience.place.isEmpty ? (experience.homePlace.map { "Near home · \($0)" } ?? "Near home") : experience.place
        return [place, experience.monthYear, "\(experience.photoIDs.count) photos"]
            .filter { !$0.isEmpty }
            .joined(separator: "  ·  ")
    }

    private func loadPlaces() async {
        places = await PlaceNameCache.shared.stored()
        var seen = Set<String>()
        for moment in moments.sorted(by: { $0.confidence > $1.confidence }) {
            guard let key = moment.region, places[key] == nil, seen.insert(key).inserted,
                  let latitude = moment.latitude, let longitude = moment.longitude else { continue }
            if let info = await PlaceNameCache.shared.resolve(latitude: latitude, longitude: longitude) {
                places[key] = info
            }
        }
    }
}
