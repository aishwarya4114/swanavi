import CoreLocation
import Foundation

nonisolated struct PlaceInfo: Codable, Hashable, Sendable {
    var landmark: String?
    var locality: String?
    var region: String?
    var country: String?

    var display: String {
        locality ?? region ?? country ?? landmark ?? ""
    }

    var headline: String {
        landmark ?? display
    }

    var long: String {
        [landmark, locality, country].compactMap { $0 }.joined(separator: ", ")
    }
}

actor PlaceNameCache {
    static let shared = PlaceNameCache()

    private let defaultsKey = "avida.placeInfo"
    private var memory: [String: PlaceInfo]
    private let geocoder = CLGeocoder()
    private var lastRequest = Date.distantPast

    init() {
        if let data = UserDefaults.standard.data(forKey: "avida.placeInfo"),
           let decoded = try? JSONDecoder().decode([String: PlaceInfo].self, from: data) {
            memory = decoded
        } else {
            memory = [:]
        }
    }

    func stored() -> [String: PlaceInfo] {
        memory
    }

    func resolve(latitude: Double, longitude: Double) async -> PlaceInfo? {
        let key = ExperienceBoard.placeKey(latitude: latitude, longitude: longitude)
        if let cached = memory[key] { return cached }
        let wait = 0.6 - Date.now.timeIntervalSince(lastRequest)
        if wait > 0 {
            try? await Task.sleep(for: .seconds(wait))
        }
        lastRequest = .now
        let location = CLLocation(latitude: latitude, longitude: longitude)
        guard let placemark = try? await geocoder.reverseGeocodeLocation(location).first else { return nil }
        let landmark = placemark.areasOfInterest?.first ?? cleanName(placemark)
        let info = PlaceInfo(
            landmark: landmark,
            locality: placemark.locality ?? placemark.subAdministrativeArea,
            region: placemark.administrativeArea,
            country: placemark.country
        )
        guard !info.display.isEmpty || info.landmark != nil else { return nil }
        memory[key] = info
        if let data = try? JSONEncoder().encode(memory) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
        return info
    }

    private func cleanName(_ placemark: CLPlacemark) -> String? {
        guard let name = placemark.name, !name.isEmpty else { return nil }
        if name == placemark.thoroughfare || name == placemark.locality { return nil }
        if name.rangeOfCharacter(from: .decimalDigits) != nil { return nil }
        if let street = placemark.thoroughfare, name.contains(street) { return nil }
        return name
    }
}
