import SwiftData
import SwiftUI

struct PostCard: View {
    let post: Post
    var onDelete: (() -> Void)? = nil

    private var visibility: PostVisibility { PostVisibility(rawValue: post.visibility) ?? .onlyMe }
    private var scope: PeopleScope { PeopleScope(rawValue: post.peopleScope) ?? .everyone }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text("E")
                    .font(.system(size: 15, weight: .semibold, design: .serif))
                    .frame(width: 36, height: 36)
                    .background(AvidaColor.card, in: Circle())
                VStack(alignment: .leading, spacing: 1) {
                    Text("Eswanth")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                    Text([post.placeName, post.createdAt.formatted(.relative(presentation: .named))].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.system(size: 12))
                        .foregroundStyle(AvidaColor.secondary)
                }
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: visibility.symbol)
                    Text(visibility.title)
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AvidaColor.tertiary)
                if let onDelete {
                    Menu {
                        Button("Delete post", systemImage: "trash", role: .destructive, action: onDelete)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(AvidaColor.ink)
                            .frame(width: 28, height: 28)
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            if let cover = post.coverAssetID {
                AssetImage(assetID: cover, pixelSide: 1200)
                    .frame(height: 300)
                    .clipped()
            }

            if post.photoIDs.count > 1 {
                ScrollView(.horizontal) {
                    HStack(spacing: 4) {
                        ForEach(Array(post.photoIDs.filter { $0 != post.coverAssetID }.prefix(10)), id: \.self) { assetID in
                            AssetThumbnail(assetID: assetID, side: 64, cornerRadius: 8)
                        }
                    }
                    .padding(.horizontal, 14)
                }
                .scrollIndicators(.hidden)
                .padding(.top, 8)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(post.title)
                    .font(.system(size: 18, weight: .bold))
                    .foregroundStyle(AvidaColor.ink)
                if !post.caption.isEmpty {
                    Text(post.caption)
                        .font(.system(size: 15))
                        .foregroundStyle(AvidaColor.ink.opacity(0.85))
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 12) {
                    Label("\(post.photoIDs.count) photos", systemImage: "photo.on.rectangle")
                    Label(scope == .justMe ? "Just me" : "Everyone", systemImage: scope == .justMe ? "person.crop.circle" : "person.2")
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(AvidaColor.tertiary)
                .padding(.top, 4)
            }
            .padding(14)
        }
        .background(Color.white, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(AvidaColor.hairline))
    }
}
