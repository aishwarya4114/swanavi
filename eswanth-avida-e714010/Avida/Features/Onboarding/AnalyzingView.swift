import SwiftUI

struct AnalyzingView: View {
    var scan: LibraryScanModel
    var onViewPhotos: () -> Void

    var body: some View {
        AvidaScreen {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(scan.status == .completed ? "All done." : "Analyzing\nyour photos.")
                        .font(.system(size: 40, weight: .bold))
                        .foregroundStyle(AvidaColor.ink)
                        .lineSpacing(1)
                        .padding(.top, 8)
                        .contentTransition(.opacity)

                    Text(subtitle)
                        .font(.system(size: 19))
                        .foregroundStyle(AvidaColor.secondary)
                        .lineSpacing(2)
                        .padding(.top, 14)
                        .fixedSize(horizontal: false, vertical: true)

                    Text("\(percent)%")
                        .font(.system(size: 64, weight: .bold))
                        .monospacedDigit()
                        .foregroundStyle(AvidaColor.accent)
                        .padding(.top, 22)
                        .contentTransition(.numericText())
                        .animation(.snappy, value: percent)

                    progressBar
                        .padding(.top, 8)

                    HStack(alignment: .firstTextBaseline) {
                        Text(scan.total > 0 ? "\(scan.processed.formatted()) of \(scan.total.formatted()) photos" : "Reading your library")
                            .font(.system(size: 15))
                            .foregroundStyle(AvidaColor.secondary)
                            .contentTransition(.numericText())
                        Spacer()
                        if let remaining = remainingText {
                            Text(remaining)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(AvidaColor.ink)
                                .contentTransition(.numericText())
                        }
                    }
                    .padding(.top, 14)

                    if !scan.thumbnailAssetIDs.isEmpty {
                        HStack(spacing: 8) {
                            ForEach(scan.thumbnailAssetIDs, id: \.self) { assetID in
                                AssetThumbnail(assetID: assetID, side: 78, cornerRadius: 12)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                        .padding(.top, 18)
                    }

                    stats
                        .padding(.top, 18)

                    if let errorMessage = scan.errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 15))
                            .foregroundStyle(AvidaColor.accent)
                            .padding(.top, 16)
                    }

                    if scan.status == .completed {
                        AvidaPrimaryButton(title: "See your experiences", systemImage: "chevron.right", action: onViewPhotos)
                            .padding(.top, 22)
                    } else if scan.status == .interrupted {
                        Text("Scan paused. It picks up where it left off the next time it runs.")
                            .font(.system(size: 15))
                            .foregroundStyle(AvidaColor.secondary)
                            .padding(.top, 16)
                        AvidaPrimaryButton(title: "Resume", systemImage: "arrow.clockwise") { scan.start() }
                            .padding(.top, 14)
                    } else if scan.status == .running {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "moon.zzz")
                                .font(.system(size: 14, weight: .medium))
                                .foregroundStyle(AvidaColor.secondary)
                                .padding(.top, 2)
                            Text("You can leave the app. Analysis keeps running in the background and your experiences appear as they're found.")
                                .font(.system(size: 14))
                                .foregroundStyle(AvidaColor.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 20)

                        if scan.experienceCount > 0 {
                            Button(action: onViewPhotos) {
                                HStack(spacing: 6) {
                                    Text("Browse what's been found so far")
                                    Image(systemName: "chevron.right")
                                }
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(AvidaColor.accent)
                            }
                            .buttonStyle(.plain)
                            .padding(.top, 18)
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
            .scrollIndicators(.hidden)
        }
        .animation(.snappy(duration: 0.3), value: scan.status)
    }

    private var subtitle: String {
        switch scan.status {
        case .completed:
            return scan.experienceCount == 0
                ? "Your library is indexed. Nothing grouped into an experience yet."
                : "Found \(scan.experienceCount.formatted()) experiences across \(scan.placeCount.formatted()) places."
        default:
            return "Finding the experiences\nyou’ve lived..."
        }
    }

    private var percent: Int {
        Int((scan.progress * 100).rounded())
    }

    private var remainingText: String? {
        guard scan.status == .running, let remaining = scan.estimatedRemaining else { return nil }
        if remaining < 45 { return "Almost done" }
        if remaining < 3600 { return "~\(Int((remaining / 60).rounded())) min left" }
        return "~\((remaining / 3600).formatted(.number.precision(.fractionLength(1)))) h left"
    }

    private var progressBar: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(AvidaColor.track)
                Capsule()
                    .fill(AvidaColor.accentBar)
                    .frame(width: max(8, proxy.size.width * scan.progress))
                    .animation(.linear(duration: 0.4), value: scan.progress)
            }
        }
        .frame(height: 6)
    }

    private var stats: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                stat(value: scan.placeCount, label: "Places", symbol: "mappin")
                stat(value: scan.peopleCount, label: "Photos with people", symbol: "person.2")
            }
            Rectangle().fill(AvidaColor.hairline).frame(height: 1)
            HStack(spacing: 0) {
                stat(value: scan.periodCount, label: "Months", symbol: "calendar")
                stat(value: scan.experienceCount, label: "Experiences", symbol: "sparkles")
            }
        }
        .padding(.top, 8)
    }

    private func stat(value: Int, label: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 16))
                .foregroundStyle(AvidaColor.secondary)
            Text(value.formatted())
                .font(.system(size: 28, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(AvidaColor.ink)
                .contentTransition(.numericText())
                .animation(.snappy, value: value)
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(AvidaColor.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 14)
    }
}
