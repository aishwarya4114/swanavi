import SwiftUI

/// A square photo thumbnail that loads asynchronously and fades in.
struct AssetThumbnail: View {
    let assetID: String
    var side: CGFloat = 120
    var cornerRadius: CGFloat = 12

    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            AvidaColor.card
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity.animation(.easeOut(duration: 0.18)))
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .task(id: assetID) {
            image = await ThumbnailLoader.shared.image(assetID: assetID, pixelSide: side * displayScale)
        }
    }
}

/// A photo that fills whatever frame it is given (hero images, cards).
struct AssetImage: View {
    let assetID: String
    var pixelSide: CGFloat = 1200

    @State private var image: UIImage?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                AvidaColor.card
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                        .transition(.opacity.animation(.easeOut(duration: 0.2)))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
        }
        .task(id: assetID) {
            image = await ThumbnailLoader.shared.image(assetID: assetID, pixelSide: pixelSide)
        }
    }
}

struct FlowHeader: View {
    var body: some View {
        AvidaWordmark()
            .frame(maxWidth: .infinity)
            .padding(.top, 8)
    }
}
