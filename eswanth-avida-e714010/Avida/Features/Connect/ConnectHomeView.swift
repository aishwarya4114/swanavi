import SwiftData
import SwiftUI

struct ConnectPerson: Identifiable, Hashable {
    var id: String
    var name: String
    var detail: String
    var note: String
}

struct ConnectHomeView: View {
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \Post.createdAt, order: .reverse) private var posts: [Post]
    @State private var following: Set<String> = ["Lina", "Ken"]

    private let stories = ["Lina", "Ken", "Marion", "Alex", "Sophie"]
    private let suggested = [
        ConnectPerson(id: "emma", name: "Emma", detail: "Tokyo, Japan", note: "42 experiences · 7 countries"),
        ConnectPerson(id: "daniel", name: "Daniel", detail: "New York, USA", note: "58 experiences · 12 countries"),
        ConnectPerson(id: "yuki", name: "Yuki", detail: "Sapporo, Japan", note: "36 experiences · 9 countries"),
        ConnectPerson(id: "chris", name: "Chris", detail: "London, UK", note: "29 experiences · 11 countries")
    ]
    private let inspire = [
        ConnectPerson(id: "lina", name: "Lina", detail: "24 experiences · 6 countries", note: "Amalfi Coast  ·  Dining with Chef Mirso  ·  Snow Monkeys"),
        ConnectPerson(id: "ken", name: "Ken", detail: "31 experiences · 9 countries", note: "Northern Lights · Kyoto Temples · Swiss Alps")
    ]

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Color.clear.frame(width: 28)
                        Spacer()
                        AvidaWordmark(size: 18)
                        Spacer()
                        Image(systemName: "person.badge.plus")
                            .font(.system(size: 18))
                            .foregroundStyle(AvidaColor.ink)
                            .frame(width: 28)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)

                    Text("Connect")
                        .font(.system(size: 40, weight: .bold))
                        .padding(.horizontal, 20)
                        .padding(.top, 12)
                    Text("Follow inspiring people and discover new experiences.")
                        .font(.system(size: 17))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 14) {
                            story(name: "Find People", symbol: "plus")
                            ForEach(stories, id: \.self) { name in
                                story(name: name, symbol: nil)
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                    .padding(.top, 18)

                    Text("Your posts")
                        .font(.system(size: 22, weight: .bold))
                        .padding(.horizontal, 20)
                        .padding(.top, 26)

                    if posts.isEmpty {
                        emptyPosts
                            .padding(.horizontal, 20)
                            .padding(.top, 10)
                    } else {
                        ForEach(posts) { post in
                            PostCard(post: post) {
                                withAnimation(.snappy) { PostPublisher.shared.delete(post, in: modelContext) }
                            }
                            .padding(.horizontal, 20)
                            .padding(.top, 12)
                        }
                    }

                    Text("Suggested for you")
                        .font(.system(size: 22, weight: .bold))
                        .padding(.horizontal, 20)
                        .padding(.top, 22)

                    ForEach(suggested) { person in
                        personRow(person, compact: true)
                    }

                    Text("People to inspire you")
                        .font(.system(size: 22, weight: .bold))
                        .padding(.horizontal, 20)
                        .padding(.top, 18)

                    ForEach(inspire) { person in
                        VStack(alignment: .leading, spacing: 8) {
                            personRow(person, compact: false)
                            Text(person.note)
                                .font(.system(size: 13))
                                .foregroundStyle(AvidaColor.secondary)
                                .padding(.horizontal, 76)
                        }
                    }
                }
                .padding(.bottom, 20)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private var emptyPosts: some View {
        HStack(spacing: 14) {
            Image(systemName: "paperplane")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(AvidaColor.accent)
                .frame(width: 44, height: 44)
                .background(AvidaColor.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text("Nothing shared yet")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                Text("Open an experience and tap the paper plane to post it.")
                    .font(.system(size: 13))
                    .foregroundStyle(AvidaColor.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(14)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(AvidaColor.hairline))
    }

    private func story(name: String, symbol: String?) -> some View {
        VStack(spacing: 6) {
            ZStack {
                Circle().fill(symbol == nil ? AvidaColor.card : Color.white)
                Circle().stroke(AvidaColor.hairline, lineWidth: 1)
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                } else {
                    Text(String(name.prefix(1)))
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                }
            }
            .frame(width: 62, height: 62)
            Text(name)
                .font(.system(size: 12))
                .foregroundStyle(AvidaColor.secondary)
                .lineLimit(1)
        }
        .frame(width: 72)
    }

    private func personRow(_ person: ConnectPerson, compact: Bool) -> some View {
        HStack(spacing: 12) {
            Text(String(person.name.prefix(1)))
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 48, height: 48)
                .background(AvidaColor.card, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(AvidaColor.ink)
                Text(compact ? person.detail : person.detail)
                    .font(.system(size: 13))
                    .foregroundStyle(AvidaColor.secondary)
                if compact {
                    Text(person.note)
                        .font(.system(size: 12))
                        .foregroundStyle(AvidaColor.tertiary)
                }
            }
            Spacer()
            followButton(person.name)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 8)
    }

    private func followButton(_ name: String) -> some View {
        let isFollowing = following.contains(name)
        return Button {
            if isFollowing { following.remove(name) } else { following.insert(name) }
        } label: {
            Text(isFollowing ? "Following" : "Follow")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(isFollowing ? AvidaColor.secondary : AvidaColor.ink)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(Color.white, in: Capsule())
                .overlay(Capsule().stroke(AvidaColor.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}
