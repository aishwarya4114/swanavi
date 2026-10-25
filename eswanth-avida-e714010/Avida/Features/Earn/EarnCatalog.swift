import SwiftUI

struct OfferStop: Identifiable, Hashable {
    var id: String { title }
    var title: String
    var detail: String
}

struct PartnerOffer: Identifiable {
    var id: String
    var eyebrow: String
    var title: String
    var place: String
    var duration: String
    var category: String
    var summary: String
    var partner: String
    var reward: String
    var stops: [OfferStop]
    var colors: [Color]
}

enum EarnCatalog {
    static let offers: [PartnerOffer] = [
        PartnerOffer(
            id: "kyoto",
            eyebrow: "Culture",
            title: "Discover Old Kyoto After Dark",
            place: "Kyoto",
            duration: "2 hrs",
            category: "Culture",
            summary: "A night walk through historic Kyoto.",
            partner: "JR East",
            reward: "+500 JR Points",
            stops: [
                OfferStop(title: "Yasaka Shrine", detail: "~30 min"),
                OfferStop(title: "Sannenzaka", detail: "~40 min"),
                OfferStop(title: "Kiyomizu-dera", detail: "~50 min")
            ],
            colors: [Color(red: 0.18, green: 0.16, blue: 0.28), Color(red: 0.86, green: 0.48, blue: 0.22)]
        ),
        PartnerOffer(
            id: "nagano",
            eyebrow: "Nature",
            title: "Sleep Above the Clouds",
            place: "Nagano",
            duration: "Overnight",
            category: "Nature",
            summary: "A quiet retreat in the Japanese Alps.",
            partner: "Marriott Bonvoy",
            reward: "+2,000 Hotel Points",
            stops: [
                OfferStop(title: "Check-in at the Ridge Ryokan", detail: "~30 min"),
                OfferStop(title: "Sunset Onsen", detail: "~60 min"),
                OfferStop(title: "Sunrise Viewpoint", detail: "~45 min")
            ],
            colors: [Color(red: 0.20, green: 0.35, blue: 0.55), Color(red: 0.95, green: 0.62, blue: 0.38)]
        ),
        PartnerOffer(
            id: "miyazaki",
            eyebrow: "Coast",
            title: "Find Miyazaki’s Hidden Coast",
            place: "Miyazaki",
            duration: "Half day",
            category: "Coast",
            summary: "A coastal route through Miyazaki.",
            partner: "Miyazaki City",
            reward: "+1,000 Avida Tokens",
            stops: [
                OfferStop(title: "Aoshima Shrine", detail: "~35 min"),
                OfferStop(title: "Horikiri Pass", detail: "~25 min"),
                OfferStop(title: "Udo Shrine", detail: "~50 min")
            ],
            colors: [Color(red: 0.12, green: 0.45, blue: 0.62), Color(red: 0.95, green: 0.78, blue: 0.45)]
        ),
        PartnerOffer(
            id: "monkeys",
            eyebrow: "Wildlife",
            title: "Snow Monkeys in Nagano",
            place: "Nagano",
            duration: "Half day",
            category: "Wildlife",
            summary: "A winter route through Nagano.",
            partner: "Japan Airlines",
            reward: "+750 Airline Miles",
            stops: [
                OfferStop(title: "Jigokudani Trailhead", detail: "~20 min"),
                OfferStop(title: "Snow Monkey Park", detail: "~75 min"),
                OfferStop(title: "Shibu Onsen", detail: "~45 min")
            ],
            colors: [Color(red: 0.75, green: 0.78, blue: 0.82), Color(red: 0.35, green: 0.42, blue: 0.48)]
        )
    ]

    static let partners: [(String, [String])] = [
        ("Cities", ["Tokyo Metropolitan Government", "Miyazaki City", "Kyoto City"]),
        ("Airlines", ["Japan Airlines", "ANA", "Singapore Airlines"]),
        ("Hotels", ["Marriott Bonvoy", "Hilton", "Hyatt"]),
        ("Railways", ["JR East", "JR Central", "Tokyo Metro"]),
        ("Malls", ["AEON Mall", "Mitsui Shopping Park", "PARCO"])
    ]

    static let balances: [(String, String, String)] = [
        ("JAL", "24,800", "JAL Miles"),
        ("Marriott Bonvoy", "18,500", "Bonvoy Points"),
        ("JR East", "4,200", "JR Points"),
        ("Miyazaki City", "1,850", "Miyazaki City Tokens")
    ]
}

struct OfferArtwork: View {
    var offer: PartnerOffer
    var height: CGFloat = 92

    var body: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(LinearGradient(colors: offer.colors, startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(height: height)
            .overlay(alignment: .bottomLeading) {
                Text(offer.place.uppercased())
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1)
                    .foregroundStyle(.white.opacity(0.9))
                    .padding(10)
            }
    }
}
