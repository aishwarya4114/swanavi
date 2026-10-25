import PhotosUI
import SwiftUI

/// Lets the owner teach Avida what they look like, so photos can be split into "me" and "others".
struct ThisIsMeView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var referenceCount = 0
    @State private var working = false
    @State private var message: String?
    @State private var selection: [PhotosPickerItem] = []

    private var scan: LibraryScanModel { LibraryScanModel.shared }

    var body: some View {
        NavigationStack {
            AvidaScreen {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("This is me")
                            .font(.system(size: 34, weight: .bold))
                            .foregroundStyle(AvidaColor.ink)
                            .padding(.top, 8)
                        Text("Avida learns your face from your selfies and any photos you pick here, then tells you apart from other people in every experience. Nothing leaves this iPhone.")
                            .font(.system(size: 16))
                            .foregroundStyle(AvidaColor.secondary)
                            .padding(.top, 10)
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 14) {
                            Image(systemName: referenceCount > 0 ? "person.crop.circle.badge.checkmark" : "person.crop.circle.badge.questionmark")
                                .font(.system(size: 26))
                                .foregroundStyle(referenceCount > 0 ? AvidaColor.accent : AvidaColor.tertiary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(referenceCount > 0 ? "\(referenceCount) reference faces" : "No reference yet")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(AvidaColor.ink)
                                Text(referenceCount > 0 ? "More references make matching more reliable." : "Add a few photos where your face is clearly visible.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(AvidaColor.secondary)
                            }
                            Spacer()
                        }
                        .padding(16)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(AvidaColor.hairline))
                        .padding(.top, 24)

                        PhotosPicker(selection: $selection, maxSelectionCount: 8, matching: .images, photoLibrary: .shared()) {
                            row(title: "Pick photos of me", subtitle: "Choose up to 8 clear photos of your face", symbol: "photo.badge.plus")
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 14)

                        Button {
                            Task { await seedSelfies() }
                        } label: {
                            row(title: "Use my Selfies album", subtitle: "Front-camera photos are almost always you", symbol: "camera.viewfinder")
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 10)

                        Button(role: .destructive) {
                            Task {
                                await PersonIdentifier.shared.reset()
                                referenceCount = 0
                                message = "References cleared."
                            }
                        } label: {
                            row(title: "Start over", subtitle: "Forget what Avida learned about your face", symbol: "arrow.counterclockwise")
                        }
                        .buttonStyle(.plain)
                        .padding(.top, 10)

                        if let message {
                            Text(message)
                                .font(.system(size: 14))
                                .foregroundStyle(AvidaColor.secondary)
                                .padding(.top, 16)
                        }
                        if working {
                            ProgressView().tint(AvidaColor.accent).padding(.top, 16)
                        }

                        AvidaPrimaryButton(title: "Apply to my experiences", systemImage: "sparkles") {
                            scan.start()
                            dismiss()
                        }
                        .disabled(referenceCount == 0 || working)
                        .opacity(referenceCount == 0 ? 0.5 : 1)
                        .padding(.top, 28)
                        Text("Only photos with faces are re-checked — this is quick.")
                            .font(.system(size: 13))
                            .foregroundStyle(AvidaColor.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 8)
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AvidaColor.ink)
                }
            }
            .toolbarBackground(AvidaColor.background, for: .navigationBar)
            .task { referenceCount = await PersonIdentifier.shared.referenceCount() }
            .onChange(of: selection) { _, items in
                guard !items.isEmpty else { return }
                Task { await addPicked(items) }
            }
        }
    }

    private func row(title: String, subtitle: String, symbol: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(AvidaColor.ink)
                .frame(width: 40, height: 40)
                .background(AvidaColor.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(AvidaColor.ink)
                Text(subtitle)
                    .font(.system(size: 13))
                    .foregroundStyle(AvidaColor.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AvidaColor.tertiary)
        }
        .padding(14)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(AvidaColor.hairline))
        .contentShape(Rectangle())
    }

    private func seedSelfies() async {
        working = true
        defer { working = false }
        let added = await PersonIdentifier.shared.seedFromSelfies(limit: 60)
        referenceCount = await PersonIdentifier.shared.referenceCount()
        message = added > 0 ? "Added \(added) faces from your selfies." : "No usable selfies found — try picking photos instead."
    }

    private func addPicked(_ items: [PhotosPickerItem]) async {
        working = true
        defer { working = false; selection = [] }
        var added = 0
        for item in items {
            guard let assetID = item.itemIdentifier else { continue }
            if await PersonIdentifier.shared.addSelf(assetID: assetID) { added += 1 }
        }
        referenceCount = await PersonIdentifier.shared.referenceCount()
        message = added > 0 ? "Added \(added) reference\(added == 1 ? "" : "s")." : "Couldn't find a clear face in those photos."
    }
}
