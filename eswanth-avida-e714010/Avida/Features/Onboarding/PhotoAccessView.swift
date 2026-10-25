import Photos
import PhotosUI
import SwiftUI
import UIKit

struct PhotoAccessView: View {
    var previewAssetIDs: [String]
    var access: PhotoAccess
    var onAllow: () -> Void
    var onNotNow: () -> Void

    @State private var declined = false
    @State private var manageLimited = false

    var body: some View {
        AvidaScreen {
            VStack(alignment: .leading, spacing: 0) {
                if !previewAssetIDs.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(Array(previewAssetIDs.prefix(3)), id: \.self) { assetID in
                            AssetThumbnail(assetID: assetID, side: 108, cornerRadius: 14)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 22)
                } else {
                    Color.clear.frame(height: 12)
                }

                Text("Let Avida\nread your life.")
                    .font(.system(size: 40, weight: .bold))
                    .foregroundStyle(AvidaColor.ink)
                    .lineSpacing(1)
                    .padding(.bottom, 22)

                feature(
                    symbol: "photo",
                    title: "Analyze your photos",
                    detail: "Find experiences, places, people and meaningful moments."
                )
                divider
                feature(
                    symbol: "lock",
                    title: "Keep it private",
                    detail: "Your photos stay on your device. You control what to save.",
                    footnote: "Only me by default."
                )
                divider
                feature(
                    symbol: "doc.text",
                    title: "Create your life profile",
                    detail: "A beautifully organized record of your experiences."
                )

                Spacer(minLength: 20)

                if let message = statusMessage {
                    Text(message)
                        .font(.system(size: 14))
                        .foregroundStyle(AvidaColor.secondary)
                        .padding(.bottom, 12)
                }

                AvidaPrimaryButton(title: allowTitle, action: onAllow)
                    .padding(.bottom, 8)

                if access == .limited {
                    Button("Choose more photos") { manageLimited = true }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AvidaColor.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 4)
                }

                if access == .denied || access == .restricted {
                    Button("Open Settings") { openSettings() }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AvidaColor.ink)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 4)
                }

                Button("Not now") {
                    declined = true
                    onNotNow()
                }
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(AvidaColor.tertiary)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
            }
            .padding(.horizontal, 24)
        }
        .background {
            LimitedLibraryPresenter(isPresented: $manageLimited)
                .frame(width: 0, height: 0)
        }
    }

    private var allowTitle: String {
        switch access {
        case .denied, .restricted: "Try Photo Access Again"
        case .limited, .authorized: "Analyze your library"
        case .notDetermined: "Allow Photo Access"
        }
    }

    private var statusMessage: String? {
        if access == .denied {
            return "Photo access is off. Enable it in Settings to analyze your library."
        }
        if access == .restricted {
            return "Photo access is restricted on this iPhone."
        }
        if access == .limited {
            return "Limited access only analyzes selected photos. Full Access covers the whole library."
        }
        if declined {
            return "Nothing is read until you allow access."
        }
        return nil
    }

    private var divider: some View {
        Rectangle()
            .fill(AvidaColor.hairline)
            .frame(height: 1)
            .padding(.vertical, 14)
    }

    private func feature(symbol: String, title: String, detail: String, footnote: String? = nil) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 22, weight: .regular))
                .foregroundStyle(AvidaColor.secondary)
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                Text(detail)
                    .font(.system(size: 15))
                    .foregroundStyle(AvidaColor.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let footnote {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark.shield")
                            .font(.system(size: 12, weight: .semibold))
                        Text(footnote)
                            .font(.system(size: 14, weight: .medium))
                    }
                    .foregroundStyle(AvidaColor.secondary)
                    .padding(.top, 4)
                }
            }
        }
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

private struct LimitedLibraryPresenter: UIViewControllerRepresentable {
    @Binding var isPresented: Bool

    func makeUIViewController(context: Context) -> UIViewController {
        UIViewController()
    }

    func updateUIViewController(_ controller: UIViewController, context: Context) {
        guard isPresented, controller.presentedViewController == nil else { return }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { _ in
            isPresented = false
        }
    }
}
