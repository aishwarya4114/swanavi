import SwiftUI

enum AppTab: Hashable {
    case profile
    case earn
    case connect
}

struct MainTabView: View {
    @State private var tab: AppTab = .profile

    var body: some View {
        TabView(selection: $tab) {
            Tab("Profile", systemImage: "person.fill", value: .profile) {
                NavigationStack { ProfileHomeView() }.tint(AvidaColor.ink)
            }
            Tab("Earn", systemImage: "gift", value: .earn) {
                NavigationStack { EarnHomeView() }.tint(AvidaColor.ink)
            }
            Tab("Connect", systemImage: "person.2.fill", value: .connect) {
                NavigationStack { ConnectHomeView() }.tint(AvidaColor.ink)
            }
        }
        .tint(AvidaColor.accent)
        .sensoryFeedback(.selection, trigger: tab)
    }
}
