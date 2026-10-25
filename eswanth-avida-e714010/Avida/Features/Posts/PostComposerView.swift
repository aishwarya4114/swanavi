import SwiftData
import SwiftUI

/// Turns an experience into a post. Posts are stored locally today; `PostPublisher` is the seam where a
/// remote backend plugs in.
struct PostComposerView: View {
    let experience: LifeExperience

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @State private var title: String
    @State private var caption: String
    @State private var scope: PeopleScope
    @State private var visibility: PostVisibility = .friends
    @State private var excluded: Set<String> = []
    @State private var cover: String?
    @State private var posted = false

    private let columns = [GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3)]

    init(experience: LifeExperience) {
        self.experience = experience
        let narrator = ExperienceNarrator.shared
        _title = State(initialValue: narrator.title(for: experience))
        _caption = State(initialValue: narrator.summary(for: experience))
        _scope = State(initialValue: PeopleScopeStore.shared.scope(for: experience.key))
        _cover = State(initialValue: experience.coverAssetID)
    }

    private var candidates: [String] { experience.photoIDs(for: scope) }
    private var selected: [String] { candidates.filter { !excluded.contains($0) } }
    private var effectiveCover: String? {
        if let cover, selected.contains(cover) { return cover }
        return selected.first
    }

    var body: some View {
        NavigationStack {
            AvidaScreen {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if let hero = effectiveCover {
                            AssetImage(assetID: hero, pixelSide: 1200)
                                .frame(height: 240)
                                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                                .padding(.horizontal, 20)
                                .padding(.top, 8)
                        }

                        field("TITLE") {
                            TextField("Title", text: $title)
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(AvidaColor.ink)
                        }
                        field("CAPTION") {
                            TextField("Say something about it", text: $caption, axis: .vertical)
                                .lineLimit(2...6)
                                .font(.system(size: 16))
                                .foregroundStyle(AvidaColor.ink)
                        }

                        if experience.includesOthers {
                            section("WHO'S IN IT") {
                                Picker("People", selection: $scope) {
                                    ForEach(PeopleScope.allCases) { option in
                                        Text(option.title).tag(option)
                                    }
                                }
                                .pickerStyle(.segmented)
                                Text(scope == .justMe
                                     ? "Hides the \(experience.othersPhotoIDs.count) photo\(experience.othersPhotoIDs.count == 1 ? "" : "s") other people appear in."
                                     : "Includes the \(experience.othersPhotoIDs.count) photo\(experience.othersPhotoIDs.count == 1 ? "" : "s") other people appear in.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(AvidaColor.secondary)
                            }
                        }

                        section("PHOTOS · \(selected.count) OF \(candidates.count)") {
                            LazyVGrid(columns: columns, spacing: 3) {
                                ForEach(candidates, id: \.self) { assetID in
                                    let isExcluded = excluded.contains(assetID)
                                    Button {
                                        if isExcluded { excluded.remove(assetID) } else { excluded.insert(assetID) }
                                    } label: {
                                        GeometryReader { proxy in
                                            AssetThumbnail(assetID: assetID, side: proxy.size.width, cornerRadius: 6)
                                                .opacity(isExcluded ? 0.35 : 1)
                                                .overlay(alignment: .topTrailing) {
                                                    Image(systemName: isExcluded ? "circle" : "checkmark.circle.fill")
                                                        .font(.system(size: 16, weight: .semibold))
                                                        .foregroundStyle(isExcluded ? .white : AvidaColor.accent)
                                                        .background(Circle().fill(.white).padding(2))
                                                        .padding(5)
                                                }
                                                .overlay(alignment: .bottomLeading) {
                                                    if effectiveCover == assetID {
                                                        Text("COVER")
                                                            .font(.system(size: 9, weight: .bold))
                                                            .foregroundStyle(.white)
                                                            .padding(.horizontal, 5)
                                                            .padding(.vertical, 2)
                                                            .background(.black.opacity(0.55), in: Capsule())
                                                            .padding(4)
                                                    }
                                                }
                                        }
                                        .aspectRatio(1, contentMode: .fit)
                                    }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        Button("Use as cover", systemImage: "photo") { cover = assetID; excluded.remove(assetID) }
                                    }
                                }
                            }
                            Text("Tap to include or exclude. Hold a photo to make it the cover.")
                                .font(.system(size: 13))
                                .foregroundStyle(AvidaColor.tertiary)
                        }

                        section("WHO CAN SEE IT") {
                            HStack(spacing: 8) {
                                ForEach(PostVisibility.allCases) { option in
                                    let on = visibility == option
                                    Button {
                                        visibility = option
                                    } label: {
                                        Label(option.title, systemImage: option.symbol)
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(on ? .white : AvidaColor.ink)
                                            .padding(.horizontal, 12)
                                            .frame(height: 36)
                                            .background(on ? AvidaColor.ink : Color.white, in: Capsule())
                                            .overlay(Capsule().stroke(on ? Color.clear : AvidaColor.hairline))
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }

                        AvidaPrimaryButton(title: posted ? "Posted" : "Post", systemImage: posted ? "checkmark" : "paperplane.fill") {
                            publish()
                        }
                        .disabled(selected.isEmpty || posted)
                        .opacity(selected.isEmpty ? 0.5 : 1)
                        .padding(.horizontal, 20)
                        .padding(.top, 28)
                        .sensoryFeedback(.success, trigger: posted)
                    }
                    .padding(.bottom, 32)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("New post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(AvidaColor.ink)
                }
            }
            .toolbarBackground(AvidaColor.background, for: .navigationBar)
            .onChange(of: scope) { _, newValue in
                PeopleScopeStore.shared.set(newValue, for: experience.key)
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        section(label) {
            content()
                .padding(14)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(AvidaColor.hairline))
        }
    }

    private func section<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(AvidaColor.tertiary)
            content()
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
    }

    private func publish() {
        let post = Post()
        post.experienceKey = experience.key
        post.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        post.caption = caption.trimmingCharacters(in: .whitespacesAndNewlines)
        post.placeName = experience.place
        post.photoIDs = selected
        post.coverAssetID = effectiveCover
        post.peopleScope = scope.rawValue
        post.visibility = visibility.rawValue
        Task {
            await PostPublisher.shared.publish(post, in: modelContext)
            posted = true
            try? await Task.sleep(for: .milliseconds(650))
            dismiss()
        }
    }
}

/// Where posts go. Today: the local store. Phase 6 adds a remote implementation (Cognito + API Gateway + S3)
/// behind this same call, so the UI does not change.
@MainActor
final class PostPublisher {
    static let shared = PostPublisher()

    func publish(_ post: Post, in context: ModelContext) async {
        post.status = "local"
        context.insert(post)
        try? context.save()
    }

    func delete(_ post: Post, in context: ModelContext) {
        context.delete(post)
        try? context.save()
    }
}
