import SwiftUI

struct EarnHomeView: View {
    @AppStorage("avida.savedOffers") private var savedOffers = ""

    private var saved: Set<String> {
        Set(savedOffers.split(separator: ",").map(String.init))
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Color.clear.frame(width: 28)
                        Spacer()
                        AvidaWordmark(size: 18)
                        Spacer()
                        NavigationLink(value: EarnRoute.rewards) {
                            HStack(spacing: 6) {
                                Image(systemName: "gift")
                                Text("My rewards")
                            }
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(AvidaColor.ink)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                    Text("Earn")
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                    Text("Free experiences. Real rewards.")
                        .font(.system(size: 18))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)

                    HStack {
                        Text("Our partners")
                            .font(.system(size: 15))
                            .foregroundStyle(AvidaColor.secondary)
                        Spacer()
                        NavigationLink(value: EarnRoute.partners) {
                            HStack(spacing: 4) {
                                Text("Show all partners")
                                Image(systemName: "chevron.right")
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(AvidaColor.ink)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 22)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(["JAL", "Marriott Bonvoy", "JR East", "Tokyo"], id: \.self) { name in
                                Text(name)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(AvidaColor.ink)
                                    .padding(.horizontal, 12)
                                    .frame(height: 54)
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                    .padding(.top, 12)

                    ForEach(EarnCatalog.offers) { offer in
                        NavigationLink(value: offer.id) {
                            offerCard(offer)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 20)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .navigationDestination(for: String.self) { id in
            if let offer = EarnCatalog.offers.first(where: { $0.id == id }) {
                OfferDetailView(offer: offer)
            }
        }
        .navigationDestination(for: EarnRoute.self) { route in
            switch route {
            case .partners: PartnersView()
            case .rewards: RewardsView(savedIDs: saved)
            }
        }
    }

    private func offerCard(_ offer: PartnerOffer) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("FREE")
                    .font(.system(size: 12, weight: .bold))
                    .tracking(0.8)
                    .foregroundStyle(AvidaColor.accent)
                Spacer()
                Image(systemName: saved.contains(offer.id) ? "bookmark.fill" : "bookmark")
                    .foregroundStyle(AvidaColor.ink)
            }
            Text(offer.title)
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(AvidaColor.ink)
                .multilineTextAlignment(.leading)
            HStack(spacing: 8) {
                Label(offer.place, systemImage: "mappin")
                Text("·")
                Label(offer.duration, systemImage: "clock")
                Text("·")
                Label(offer.category, systemImage: "leaf")
            }
            .font(.system(size: 13))
            .foregroundStyle(AvidaColor.secondary)
            OfferArtwork(offer: offer, height: 120)
                .padding(.top, 4)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(offer.partner)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(AvidaColor.accent)
                    Text(offer.reward)
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                }
                Spacer()
                HStack(spacing: 4) {
                    Text("View experience")
                    Image(systemName: "chevron.right")
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AvidaColor.accent)
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 20)
        .padding(.top, 26)
    }
}

enum EarnRoute: Hashable {
    case partners
    case rewards
}

struct OfferDetailView: View {
    var offer: PartnerOffer
    @AppStorage("avida.savedOffers") private var savedOffers = ""

    private var saved: Bool {
        Set(savedOffers.split(separator: ",").map(String.init)).contains(offer.id)
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    OfferArtwork(offer: offer, height: 210)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                    Text(offer.eyebrow.uppercased())
                        .font(.system(size: 13, weight: .semibold))
                        .tracking(1.1)
                        .foregroundStyle(AvidaColor.accent)
                        .padding(.horizontal, 24)
                        .padding(.top, 16)
                    Text(offer.title)
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .padding(.horizontal, 24)
                        .padding(.top, 4)
                    HStack(spacing: 16) {
                        Label(offer.place, systemImage: "mappin")
                        Label(offer.duration, systemImage: "clock")
                    }
                    .font(.system(size: 15))
                    .foregroundStyle(AvidaColor.secondary)
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    Text(offer.summary)
                        .font(.system(size: 22, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .padding(.horizontal, 24)
                        .padding(.top, 20)
                    ForEach(Array(offer.stops.enumerated()), id: \.element.id) { index, stop in
                        HStack(spacing: 12) {
                            Text("\(index + 1)")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 28, height: 28)
                                .background(AvidaColor.accent, in: Circle())
                            VStack(alignment: .leading, spacing: 2) {
                                Text(stop.title)
                                    .font(.system(size: 17, weight: .semibold))
                                Text(stop.detail)
                                    .font(.system(size: 14))
                                    .foregroundStyle(AvidaColor.secondary)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 10)
                    }
                    HStack(alignment: .center) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(offer.partner)
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(AvidaColor.accent)
                            Text(offer.reward)
                                .font(.system(size: 22, weight: .bold))
                            Text("Complete and verify this experience.")
                                .font(.system(size: 14))
                                .foregroundStyle(AvidaColor.secondary)
                        }
                        Spacer()
                    }
                    .padding(24)
                    AvidaPrimaryButton(title: saved ? "Saved" : "Save to do", systemImage: "bookmark") {
                        toggle()
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 20)
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { BackButton() }
            ToolbarItem(placement: .principal) { AvidaWordmark(size: 16) }
        }
        .toolbarBackground(AvidaColor.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }

    private func toggle() {
        var ids = Set(savedOffers.split(separator: ",").map(String.init))
        if ids.contains(offer.id) { ids.remove(offer.id) } else { ids.insert(offer.id) }
        savedOffers = ids.sorted().joined(separator: ",")
    }
}

struct PartnersView: View {
    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Partners")
                        .font(.system(size: 36, weight: .bold))
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                    Text("Explore partners across experiences and rewards.")
                        .font(.system(size: 16))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.horizontal, 24)
                        .padding(.top, 6)
                    ForEach(EarnCatalog.partners, id: \.0) { section in
                        Text(section.0)
                            .font(.system(size: 20, weight: .bold))
                            .padding(.horizontal, 24)
                            .padding(.top, 22)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                            ForEach(section.1, id: \.self) { name in
                                Text(name)
                                    .font(.system(size: 12, weight: .bold))
                                    .multilineTextAlignment(.center)
                                    .foregroundStyle(AvidaColor.ink)
                                    .frame(maxWidth: .infinity, minHeight: 72)
                                    .padding(8)
                                    .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            }
                        }
                        .padding(.horizontal, 20)
                        .padding(.top, 10)
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { BackButton() }
            ToolbarItem(placement: .principal) { AvidaWordmark(size: 16) }
        }
        .toolbarBackground(AvidaColor.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

struct RewardsView: View {
    var savedIDs: Set<String>

    private var savedOffers: [PartnerOffer] {
        EarnCatalog.offers.filter { savedIDs.contains($0.id) }
    }

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text("My rewards")
                        .font(.system(size: 36, weight: .bold))
                        .padding(.horizontal, 24)
                        .padding(.top, 8)
                    ForEach(EarnCatalog.balances, id: \.0) { balance in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(balance.0)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundStyle(AvidaColor.accent)
                                Text(balance.2)
                                    .font(.system(size: 14))
                                    .foregroundStyle(AvidaColor.secondary)
                            }
                            Spacer()
                            Text(balance.1)
                                .font(.system(size: 22, weight: .bold))
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(AvidaColor.tertiary)
                        }
                        .padding(.horizontal, 24)
                        .padding(.vertical, 14)
                        Rectangle().fill(AvidaColor.hairline).frame(height: 1).padding(.leading, 24)
                    }
                    Text("Saved experiences")
                        .font(.system(size: 22, weight: .bold))
                        .padding(.horizontal, 24)
                        .padding(.top, 24)
                    if savedOffers.isEmpty {
                        Text("Save an experience from Earn and it will show up here.")
                            .font(.system(size: 15))
                            .foregroundStyle(AvidaColor.secondary)
                            .padding(.horizontal, 24)
                            .padding(.top, 8)
                    } else {
                        ForEach(savedOffers) { offer in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(offer.title)
                                    .font(.system(size: 17, weight: .semibold))
                                Text(offer.reward)
                                    .font(.system(size: 14))
                                    .foregroundStyle(AvidaColor.accent)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 24)
                            .padding(.vertical, 12)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { BackButton() }
            ToolbarItem(placement: .principal) { AvidaWordmark(size: 16) }
        }
        .toolbarBackground(AvidaColor.background, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}
