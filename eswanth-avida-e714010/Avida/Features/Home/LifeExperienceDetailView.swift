import SwiftData
import SwiftUI

struct LifeExperienceDetailView: View {
    var experience: LifeExperience

    @AppStorage("avida.savedExperiences") private var savedRaw = ""
    @Query private var posts: [Post]
    @State private var placeInfo: PlaceInfo?
    @State private var selectedAsset: SelectedAsset?
    @State private var composing = false

    private var narrator: ExperienceNarrator { ExperienceNarrator.shared }
    private var scopeStore: PeopleScopeStore { PeopleScopeStore.shared }

    init(experience: LifeExperience) {
        self.experience = experience
        let key = experience.key
        _posts = Query(filter: #Predicate<Post> { $0.experienceKey == key })
    }

    private var scope: PeopleScope { scopeStore.scope(for: experience.key) }
    private var visiblePhotoIDs: [String] { experience.photoIDs(for: scope) }
    private var hiddenCount: Int { experience.photoIDs.count - visiblePhotoIDs.count }

    private var saved: Bool {
        savedIDs.contains(experience.id.uuidString)
    }

    private var placeLine: String {
        if let info = placeInfo, !info.long.isEmpty { return info.long }
        if !experience.place.isEmpty {
            return [experience.landmark, experience.place, experience.country].compactMap { $0 }.joined(separator: ", ")
        }
        return experience.homePlace.map { "Near home in \($0)" } ?? "Near home"
    }

    private let columns = [GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3)]

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero
                    VStack(alignment: .leading, spacing: 0) {
                        Text(experience.category.uppercased())
                            .font(.system(size: 12, weight: .semibold))
                            .tracking(1.2)
                            .foregroundStyle(AvidaColor.accent)
                            .padding(.top, 22)

                        Text(narrator.title(for: experience))
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(AvidaColor.ink)
                            .padding(.top, 6)
                            .fixedSize(horizontal: false, vertical: true)

                        VStack(alignment: .leading, spacing: 8) {
                            Label(placeLine, systemImage: "mappin.and.ellipse")
                            Label(dateLine, systemImage: "calendar")
                            if let trip = experience.tripTitle {
                                Label(trip.prefix(1).uppercased() + trip.dropFirst(), systemImage: "suitcase")
                            }
                        }
                        .font(.system(size: 15))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.top, 14)

                        Text(narrator.summary(for: experience))
                            .font(.system(size: 17))
                            .lineSpacing(3)
                            .foregroundStyle(AvidaColor.ink)
                            .padding(.top, 20)
                            .fixedSize(horizontal: false, vertical: true)

                        whyCard
                            .padding(.top, 20)

                        factsGrid
                            .padding(.top, 20)

                        if !posts.isEmpty {
                            postedBanner
                                .padding(.top, 20)
                        }

                        HStack(alignment: .firstTextBaseline) {
                            Text("Photos")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(AvidaColor.ink)
                            Spacer()
                            Text("\(visiblePhotoIDs.count)")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(AvidaColor.tertiary)
                        }
                        .padding(.top, 28)

                        if experience.includesOthers {
                            peopleControl
                                .padding(.top, 12)
                        }
                    }
                    .padding(.horizontal, 20)

                    LazyVGrid(columns: columns, spacing: 3) {
                        ForEach(visiblePhotoIDs, id: \.self) { assetID in
                            Button {
                                selectedAsset = SelectedAsset(id: assetID)
                            } label: {
                                GeometryReader { proxy in
                                    AssetThumbnail(assetID: assetID, side: proxy.size.width, cornerRadius: 0)
                                }
                                .aspectRatio(1, contentMode: .fit)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.horizontal, 20)

                    if let latitude = experience.latitude, let longitude = experience.longitude,
                       let mapURL = URL(string: "http://maps.apple.com/?ll=\(latitude),\(longitude)&q=\((placeInfo?.headline ?? experience.place).addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "Experience")") {
                        Link(destination: mapURL) {
                            HStack {
                                Image(systemName: "map")
                                Text("Open in Maps")
                                Spacer()
                                Image(systemName: "arrow.up.right")
                            }
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(AvidaColor.ink)
                            .padding(16)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AvidaColor.hairline))
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 20)
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
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 8) {
                    Button {
                        composing = true
                    } label: {
                        Image(systemName: "paperplane")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AvidaColor.ink)
                            .frame(width: 34, height: 34)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Post")
                    Button {
                        toggleSaved()
                    } label: {
                        Image(systemName: saved ? "heart.fill" : "heart")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(saved ? AvidaColor.accent : AvidaColor.ink)
                            .frame(width: 34, height: 34)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .sensoryFeedback(.impact(weight: .light), trigger: saved)
                }
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
        .sheet(item: $selectedAsset) { selected in
            PhotoDetailSheet(assetID: selected.id)
        }
        .sheet(isPresented: $composing) {
            PostComposerView(experience: experience)
        }
        .task {
            narrator.ensure([experience])
            guard placeInfo == nil, let latitude = experience.latitude, let longitude = experience.longitude else { return }
            placeInfo = await PlaceNameCache.shared.resolve(latitude: latitude, longitude: longitude)
        }
    }

    private var hero: some View {
        ZStack(alignment: .bottomLeading) {
            if let cover = experience.coverAssetID {
                AssetImage(assetID: cover, pixelSide: 1200)
            } else {
                AvidaColor.card
            }
            LinearGradient(colors: [.black.opacity(0.25), .clear, .clear, AvidaColor.background.opacity(0.0)], startPoint: .top, endPoint: .bottom)
        }
        .frame(height: 360)
        .clipped()
    }

    private var dateLine: String {
        guard let start = experience.start else { return experience.monthYear }
        if experience.dayCount > 1, let end = experience.end {
            return "\(start.formatted(.dateTime.month(.abbreviated).day())) – \(end.formatted(.dateTime.month(.abbreviated).day().year()))"
        }
        return start.formatted(.dateTime.weekday(.wide).month(.wide).day().year())
    }

    private var whyCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("WHY IT MATTERED")
                .font(.system(size: 12, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(AvidaColor.tertiary)
            ForEach(experience.reasons.prefix(4)) { reason in
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
            if narrator.hasGenerated(experience) {
                Text(narrator.why(for: experience))
                    .font(.system(size: 15))
                    .italic()
                    .foregroundStyle(AvidaColor.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AvidaColor.hairline))
    }

    private var peopleControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("People", selection: Binding(
                get: { scope },
                set: { scopeStore.set($0, for: experience.key) }
            )) {
                ForEach(PeopleScope.allCases) { option in
                    Text(option.title).tag(option)
                }
            }
            .pickerStyle(.segmented)
            Text(scope == .justMe
                 ? "Hiding \(hiddenCount) photo\(hiddenCount == 1 ? "" : "s") with other people."
                 : "\(experience.othersPhotoIDs.count) photo\(experience.othersPhotoIDs.count == 1 ? "" : "s") include other people\(experience.includesMe ? ", you're in \(experience.selfPhotoIDs.count)" : "").")
                .font(.system(size: 13))
                .foregroundStyle(AvidaColor.secondary)
        }
    }

    private var postedBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .foregroundStyle(AvidaColor.accent)
            Text(posts.count == 1 ? "Posted" : "Posted \(posts.count) times")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AvidaColor.ink)
            Spacer()
            if let latest = posts.map(\.createdAt).max() {
                Text(latest.formatted(.relative(presentation: .named)))
                    .font(.system(size: 13))
                    .foregroundStyle(AvidaColor.tertiary)
            }
        }
        .padding(14)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AvidaColor.hairline))
    }

    private var factsGrid: some View {
        HStack(spacing: 10) {
            fact(value: experience.timeOfDay.isEmpty ? "—" : experience.timeOfDay.capitalized, label: "Time")
            fact(value: experience.dayCount == 1 ? "1 day" : "\(experience.dayCount) days", label: "Span")
            fact(value: distanceText, label: "From home")
            fact(value: experience.visitTotal == 1 ? "Once" : "\(experience.visitIndex) of \(experience.visitTotal)", label: "Visits")
        }
    }

    private var distanceText: String {
        guard let distance = experience.distanceFromHomeKM else { return "—" }
        if distance < ExperienceGrouper.homeRadiusKM { return "Home" }
        if distance >= 1000 { return "\((distance / 1000).formatted(.number.precision(.fractionLength(1))))k km" }
        return "\(Int(distance.rounded())) km"
    }

    private func fact(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(AvidaColor.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(AvidaColor.tertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(AvidaColor.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var savedIDs: Set<String> {
        Set(savedRaw.split(separator: ",").map(String.init))
    }

    private func toggleSaved() {
        var ids = savedIDs
        let key = experience.id.uuidString
        if ids.contains(key) { ids.remove(key) } else { ids.insert(key) }
        savedRaw = ids.sorted().joined(separator: ",")
    }
}

struct SelectedAsset: Identifiable, Hashable {
    let id: String
}

struct PhotoDetailSheet: View {
    let assetID: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            AssetImageFit(assetID: assetID)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(.white.opacity(0.18), in: Circle())
            }
            .padding(16)
        }
        .presentationBackground(.black)
    }
}

struct AssetImageFit: View {
    let assetID: String
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .transition(.opacity)
            } else {
                ProgressView().tint(.white)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: assetID) {
            image = await ThumbnailLoader.shared.image(assetID: assetID, pixelSide: 2400)
        }
    }
}

struct BackButton: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Button {
            dismiss()
        } label: {
            Image(systemName: "chevron.left")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AvidaColor.ink)
                .frame(width: 34, height: 34)
                .background(.ultraThinMaterial, in: Circle())
        }
    }
}
