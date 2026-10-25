import Foundation
import Observation

/// Remembers, per experience, whether the owner wants to see/share everyone or just themselves.
@MainActor
@Observable
final class PeopleScopeStore {
    static let shared = PeopleScopeStore()

    private let key = "avida.peopleScopes"
    private var scopes: [String: String]

    init() {
        scopes = UserDefaults.standard.dictionary(forKey: "avida.peopleScopes") as? [String: String] ?? [:]
    }

    func scope(for experienceKey: String) -> PeopleScope {
        scopes[experienceKey].flatMap(PeopleScope.init(rawValue:)) ?? .everyone
    }

    func set(_ scope: PeopleScope, for experienceKey: String) {
        scopes[experienceKey] = scope.rawValue
        UserDefaults.standard.set(scopes, forKey: key)
    }
}
