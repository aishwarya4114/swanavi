import SwiftUI

struct WelcomeView: View {
    var previewAssetIDs: [String]
    var onStart: () -> Void

    var body: some View {
        AvidaScreen {
            VStack(spacing: 0) {
                FlowHeader()
                    .padding(.top, 12)

                Spacer(minLength: 28)

                VStack(alignment: .leading, spacing: 18) {
                    Text("LIVE A LIFE WORTH REMEMBERING.")
                        .font(.system(size: 12, weight: .medium))
                        .tracking(1.4)
                        .foregroundStyle(AvidaColor.tertiary)

                    Text("Your life is already\nin your photos.")
                        .font(.system(size: 42, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .lineSpacing(1)
                        .fixedSize(horizontal: false, vertical: true)

                    Text("Avida finds, organizes and turns your photos into the experiences that define you.")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(AvidaColor.secondary)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if !previewAssetIDs.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(Array(previewAssetIDs.prefix(3)), id: \.self) { assetID in
                            AssetThumbnail(assetID: assetID, side: 112, cornerRadius: 14)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.top, 28)
                }

                Spacer(minLength: 28)

                AvidaPrimaryButton(title: "Get started", systemImage: "chevron.right", action: onStart)
                    .padding(.bottom, 14)

                Text("Private. Secure. Just for you.")
                    .font(.system(size: 14))
                    .foregroundStyle(AvidaColor.tertiary)
                    .padding(.bottom, 12)
            }
            .padding(.horizontal, 24)
        }
        .navigationBarHidden(true)
    }
}
