import SwiftUI

struct TripRoute: Hashable {
    let key: String
}

struct TripDetailView: View {
    let trip: LifeTrip

    private var narrator: ExperienceNarrator { ExperienceNarrator.shared }

    private struct Day: Identifiable {
        let id: Int
        let date: Date
        let experiences: [LifeExperience]
    }

    private var days: [Day] {
        let calendar = Calendar.current
        var map: [Date: [LifeExperience]] = [:]
        for experience in trip.experiences {
            guard let start = experience.start else { continue }
            map[calendar.startOfDay(for: start), default: []].append(experience)
        }
        let first = calendar.startOfDay(for: trip.start)
        return map.keys.sorted().map { date in
            let index = (calendar.dateComponents([.day], from: first, to: date).day ?? 0) + 1
            return Day(id: index, date: date, experiences: (map[date] ?? []).sorted { ($0.start ?? .distantPast) < ($1.start ?? .distantPast) })
        }
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero
                    VStack(alignment: .leading, spacing: 0) {
                        Text("TRIP")
                            .font(.system(size: 12, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(AvidaColor.accent)
                            .padding(.top, 22)
                        Text(trip.title)
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(AvidaColor.ink)
                            .padding(.top, 6)
                            .fixedSize(horizontal: false, vertical: true)
                        VStack(alignment: .leading, spacing: 8) {
                            Label(trip.dateRange, systemImage: "calendar")
                            Label(trip.subtitle, systemImage: "photo.on.rectangle")
                            if !trip.places.isEmpty {
                                Label(trip.places.prefix(4).joined(separator: " · "), systemImage: "mappin.and.ellipse")
                            }
                        }
                        .font(.system(size: 15))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.top, 14)

                        reasonsCard
                            .padding(.top, 20)

                        Text("Day by day")
                            .font(.system(size: 22, weight: .bold))
                            .foregroundStyle(AvidaColor.ink)
                            .padding(.top, 28)
                    }
                    .padding(.horizontal, 20)

                    ForEach(days) { day in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text("Day \(day.id)")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(AvidaColor.ink)
                            Text(day.date.formatted(.dateTime.weekday(.wide).month(.abbreviated).day()))
                                .font(.system(size: 14))
                                .foregroundStyle(AvidaColor.tertiary)
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 20)
                        .padding(.bottom, 2)
                        ForEach(day.experiences) { experience in
                            NavigationLink(value: experience.id) {
                                ExperienceRow(experience: experience, title: narrator.title(for: experience))
                            }
                            .buttonStyle(RowPressStyle())
                        }
                    }
                }
                .padding(.bottom, 32)
            }
            .scrollIndicators(.hidden)
            .ignoresSafeArea(edges: .top)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { BackButton() }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .task { narrator.ensure(trip.experiences) }
    }

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            if let cover = trip.coverAssetID {
                AssetImage(assetID: cover, pixelSide: 1200)
            } else {
                AvidaColor.card
            }
            LinearGradient(colors: [.black.opacity(0.25), .clear, .clear], startPoint: .top, endPoint: .bottom)
            HStack(spacing: -10) {
                ForEach(Array(trip.experiences.compactMap(\.coverAssetID).dropFirst().prefix(4)), id: \.self) { assetID in
                    AssetThumbnail(assetID: assetID, side: 44, cornerRadius: 10)
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(.white, lineWidth: 2))
                }
            }
            .padding(16)
        }
        .frame(height: 340)
        .clipped()
    }

    private var reasonsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("WHY IT MATTERED")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(AvidaColor.tertiary)
            ForEach(trip.reasons.prefix(4)) { reason in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: reason.symbol)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AvidaColor.accent)
                        .frame(width: 20)
                    Text(reason.text)
                        .font(.system(size: 16))
                        .foregroundStyle(AvidaColor.ink)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AvidaColor.hairline))
    }
}

struct TripCard: View {
    let trip: LifeTrip

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let cover = trip.coverAssetID {
                AssetImage(assetID: cover, pixelSide: 1200)
            } else {
                AvidaColor.card
            }
            LinearGradient(colors: [.clear, .black.opacity(0.1), .black.opacity(0.8)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 6) {
                Text("TRIP · \(trip.dayCount) DAYS")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.1)
                    .foregroundStyle(.white.opacity(0.85))
                Text(trip.title)
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text("\(trip.dateRange) · \(trip.photoCount) photos")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            }
            .padding(18)
        }
        .frame(width: 300, height: 360)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .shadow(color: .black.opacity(0.14), radius: 16, y: 10)
    }
}

struct TripRow: View {
    let trip: LifeTrip

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if let cover = trip.coverAssetID {
                AssetThumbnail(assetID: cover, side: 72, cornerRadius: 16)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(trip.title)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text("\(trip.dateRange) · \(trip.subtitle)")
                    .font(.system(size: 14))
                    .foregroundStyle(AvidaColor.secondary)
                    .lineLimit(2)
                if let reason = trip.reasons.first {
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
            Rectangle().fill(AvidaColor.hairline).frame(height: 1).padding(.leading, 106)
        }
    }
}
