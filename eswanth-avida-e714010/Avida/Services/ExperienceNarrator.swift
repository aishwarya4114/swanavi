import Foundation
import SwiftData

#if canImport(FoundationModels)
import FoundationModels
#endif

struct NarrativeDraft: Hashable {
    var title: String
    var summary: String
    var whyItMattered: String
}

@MainActor
@Observable
final class ExperienceNarrator {
    static let shared = ExperienceNarrator()

    private(set) var drafts: [String: NarrativeDraft] = [:]
    private var hashes: [String: String] = [:]
    private var failed: [String: String] = [:]
    private var pending: [String: LifeExperience] = [:]
    private var running = false
    private var loaded = false
    private var context: ModelContext?

    var isModelAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    func title(for experience: LifeExperience) -> String {
        drafts[experience.key]?.title ?? experience.title
    }

    func summary(for experience: LifeExperience) -> String {
        drafts[experience.key]?.summary ?? experience.summary
    }

    func why(for experience: LifeExperience) -> String {
        drafts[experience.key]?.whyItMattered ?? experience.whyItMattered
    }

    func hasGenerated(_ experience: LifeExperience) -> Bool {
        drafts[experience.key] != nil
    }

    func load(context: ModelContext) {
        self.context = context
        guard !loaded else { return }
        loaded = true
        let stored = (try? context.fetch(FetchDescriptor<ExperienceDraft>())) ?? []
        for draft in stored where !draft.momentKey.isEmpty && !draft.title.isEmpty {
            drafts[draft.momentKey] = NarrativeDraft(title: draft.title, summary: draft.summary, whyItMattered: draft.whyItMattered)
            hashes[draft.momentKey] = draft.factsHash
        }
    }

    func ensure(_ experiences: [LifeExperience]) {
        guard isModelAvailable else { return }
        for experience in experiences {
            let hash = ExperienceBoard.facts(experience).hash
            if drafts[experience.key] != nil, hashes[experience.key] == hash { continue }
            if failed[experience.key] == hash { continue }
            if experience.place.isEmpty, experience.labels.isEmpty { continue }
            pending[experience.key] = experience
        }
        guard !running, !pending.isEmpty else { return }
        running = true
        Task { await drain() }
    }

    private func drain() async {
        defer { running = false }
        while let (key, experience) = pending.sorted(by: { $0.value.score > $1.value.score }).first {
            pending[key] = nil
            guard let draft = await generate(experience) else {
                failed[key] = ExperienceBoard.facts(experience).hash
                continue
            }
            drafts[key] = draft
            let hash = ExperienceBoard.facts(experience).hash
            hashes[key] = hash
            persist(key: key, draft: draft, hash: hash, experience: experience)
        }
    }

    private func generate(_ experience: LifeExperience) async -> NarrativeDraft? {
        #if canImport(FoundationModels)
        guard #available(iOS 26, *) else { return nil }
        let instructions = """
        You write entries for a private life journal built from the owner's own photos. \
        Use only the facts provided. Never invent names of people, businesses, dishes, or events. \
        Prefer the landmark or city over generic words. Warm, concrete, understated. No hashtags, no emoji. \
        Always answer with exactly three lines in this format and nothing else:
        TITLE: a specific title of 3 to 6 words naming the place or activity, no quotes, no trailing period
        SUMMARY: one sentence under 120 characters, second person, past tense, describing what the person did
        WHY: one short sentence under 90 characters on why this experience is memorable or rare
        """
        let session = LanguageModelSession(instructions: instructions)
        let facts = ExperienceBoard.facts(experience)
        var lines: [String] = []
        if let landmark = facts.landmark { lines.append("Landmark: \(landmark)") }
        if !facts.place.isEmpty { lines.append("City: \(facts.place)") }
        if let country = facts.country { lines.append("Country: \(country)") }
        if let home = facts.homePlace { lines.append("Home at the time: \(home)") }
        lines.append("Category: \(facts.category)")
        if !facts.labels.isEmpty { lines.append("Scene labels: \(facts.labels.prefix(6).map(ExperienceCopy.humanize).joined(separator: ", "))") }
        lines.append("Photos: \(facts.photoCount) across \(facts.momentCount) moment\(facts.momentCount == 1 ? "" : "s")")
        if facts.dayCount > 1 { lines.append("Days: \(facts.dayCount)") } else if facts.durationHours > 0.5 { lines.append("Duration: about \(Int(facts.durationHours.rounded())) hours") }
        if !facts.weekday.isEmpty { lines.append("Weekday: \(facts.weekday)") }
        if !facts.timeOfDay.isEmpty { lines.append("Time of day: \(facts.timeOfDay)") }
        if !facts.monthYear.isEmpty { lines.append("When: \(facts.monthYear)") }
        lines.append("Photos with people: \(facts.peopleCount)")
        if facts.favoriteCount > 0 { lines.append("Favorited photos: \(facts.favoriteCount)") }
        if let distance = facts.distanceFromHomeKM { lines.append("Distance from home: \(Int(distance)) km") }
        if let trip = facts.tripTitle { lines.append("Part of: \(trip), day \(facts.tripDayIndex)") }
        let reasons = ExperienceCopy.reasons(facts).prefix(3).map(\.text)
        if !reasons.isEmpty { lines.append("Why it stands out (use these, do not invent others): " + reasons.joined(separator: "; ")) }
        let prompt = "Write the journal entry for this experience.\n" + lines.joined(separator: "\n")
        do {
            let response = try await session.respond(to: prompt)
            return parse(response.content, fallback: experience)
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }

    private func parse(_ text: String, fallback experience: LifeExperience) -> NarrativeDraft? {
        var title = ""
        var summary = ""
        var why = ""
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard let colon = line.firstIndex(of: ":") else { continue }
            let field = line[..<colon].trimmingCharacters(in: CharacterSet.alphanumerics.inverted).uppercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespacesAndNewlines)
            switch field {
            case "TITLE": title = value
            case "SUMMARY": summary = value
            case "WHY", "WHY IT MATTERED": why = value
            default: continue
            }
        }
        title = title.trimmingCharacters(in: CharacterSet(charactersIn: ".\"“”' "))
        guard !title.isEmpty, title.split(separator: " ").count <= 9 else { return nil }
        return NarrativeDraft(
            title: title,
            summary: summary.isEmpty ? experience.summary : summary,
            whyItMattered: why.isEmpty ? experience.whyItMattered : why
        )
    }

    private func persist(key: String, draft: NarrativeDraft, hash: String, experience: LifeExperience) {
        guard let context else { return }
        let existing = ((try? context.fetch(FetchDescriptor<ExperienceDraft>())) ?? []).first { $0.momentKey == key }
        let row = existing ?? {
            let created = ExperienceDraft()
            created.momentKey = key
            context.insert(created)
            return created
        }()
        row.momentIDs = [experience.id.uuidString]
        row.title = draft.title
        row.summary = draft.summary
        row.whyItMattered = draft.whyItMattered
        row.category = experience.category
        row.coverAssetID = experience.photoIDs.first
        row.score = experience.score
        row.generator = "foundation"
        row.factsHash = hash
        try? context.save()
    }
}
