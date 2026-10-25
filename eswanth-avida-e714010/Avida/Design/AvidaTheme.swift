import SwiftUI

enum AvidaColor {
    static let background = Color(red: 0.988, green: 0.980, blue: 0.957)
    static let ink = Color(red: 0.08, green: 0.08, blue: 0.08)
    static let secondary = Color(red: 0.45, green: 0.43, blue: 0.40)
    static let tertiary = Color(red: 0.62, green: 0.59, blue: 0.55)
    static let accent = Color(red: 0.780, green: 0.396, blue: 0.314)
    static let accentBar = Color(red: 0.882, green: 0.478, blue: 0.306)
    static let track = Color(red: 0.902, green: 0.886, blue: 0.855)
    static let button = Color(red: 0.106, green: 0.106, blue: 0.106)
    static let hairline = Color.black.opacity(0.08)
    static let card = Color(red: 0.945, green: 0.929, blue: 0.902)
}

struct AvidaWordmark: View {
    var size: CGFloat = 18

    var body: some View {
        Text("AVIDA")
            .font(.system(size: size, weight: .regular, design: .serif))
            .tracking(size * 0.28)
            .foregroundStyle(AvidaColor.ink)
    }
}

struct AvidaPrimaryButton: View {
    let title: String
    var systemImage: String? = nil
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .semibold))
                }
            }
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 56)
            .background(AvidaColor.button, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct AvidaScreen<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(AvidaColor.background.ignoresSafeArea())
    }
}
