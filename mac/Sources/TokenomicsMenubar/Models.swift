import Foundation

public enum SyncState: String, Codable, Sendable {
    case idle
    case running
    case succeeded
    case failed

    public var isInFlight: Bool { self == .running }

    public static func parse(_ raw: String) -> SyncState? {
        switch raw.lowercased().replacingOccurrences(of: "_", with: "-") {
        case "idle", "not-run", "not-started": return .idle
        case "running", "in-progress", "in-flight": return .running
        case "succeeded", "success", "complete", "completed": return .succeeded
        case "failed", "failure", "error": return .failed
        default: return nil
        }
    }
}

public struct UsagePeriod: Decodable, Equatable, Sendable {
    public var date: String?
    public var name: String?
    public var through: String?
    public var amountUSD: Double?
    public var limitUSD: Double?

    public var costUsd: Double? { amountUSD }

    public init(date: String? = nil, name: String? = nil, through: String? = nil, amountUSD: Double? = nil, limitUSD: Double? = nil) {
        self.date = date
        self.name = name
        self.through = through
        self.amountUSD = amountUSD
        self.limitUSD = limitUSD
    }

    private enum CodingKeys: String, CodingKey {
        case date, name, through, costUsd, limitUsd
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        date = try values.decodeIfPresent(String.self, forKey: .date)
        name = try values.decodeIfPresent(String.self, forKey: .name)
        through = try values.decodeIfPresent(String.self, forKey: .through)
        amountUSD = try values.decodeIfPresent(Double.self, forKey: .costUsd)
        limitUSD = try values.decodeIfPresent(Double.self, forKey: .limitUsd)
    }
}

public struct BudgetInfo: Decodable, Equatable, Sendable {
    public var todayScheduled: Bool?
    public var totalScheduledDays: Int?
    public var remainingScheduledDays: Int?
    public var limitUSD: Double?
    public var spentUSD: Double?
    public var remainingUSD: Double?
    public var overageUSD: Double?
    public var usedRatio: Double?
    public var baselineDailyTargetUSD: Double?
    public var todayAllowanceUSD: Double?
    public var todayRemainingUSD: Double?
    public var allowanceBasis: String?
    public var status: String?

    public init(
        todayScheduled: Bool? = nil,
        totalScheduledDays: Int? = nil,
        remainingScheduledDays: Int? = nil,
        limitUSD: Double? = nil,
        spentUSD: Double? = nil,
        remainingUSD: Double? = nil,
        overageUSD: Double? = nil,
        usedRatio: Double? = nil,
        baselineDailyTargetUSD: Double? = nil,
        todayAllowanceUSD: Double? = nil,
        todayRemainingUSD: Double? = nil,
        allowanceBasis: String? = nil,
        status: String? = nil
    ) {
        self.todayScheduled = todayScheduled
        self.totalScheduledDays = totalScheduledDays
        self.remainingScheduledDays = remainingScheduledDays
        self.limitUSD = limitUSD
        self.spentUSD = spentUSD
        self.remainingUSD = remainingUSD
        self.overageUSD = overageUSD
        self.usedRatio = usedRatio
        self.baselineDailyTargetUSD = baselineDailyTargetUSD
        self.todayAllowanceUSD = todayAllowanceUSD
        self.todayRemainingUSD = todayRemainingUSD
        self.allowanceBasis = allowanceBasis
        self.status = status
    }

    private enum CodingKeys: String, CodingKey {
        case todayScheduled, totalScheduledDays, remainingScheduledDays
        case limitUSD = "limitUsd"
        case spentUSD = "spentUsd"
        case remainingUSD = "remainingUsd"
        case overageUSD = "overageUsd"
        case usedRatio
        case baselineDailyTargetUSD = "baselineDailyTargetUsd"
        case todayAllowanceUSD = "todayAllowanceUsd"
        case todayRemainingUSD = "todayRemainingUsd"
        case allowanceBasis, status
    }
}

public struct DailySpendPoint: Decodable, Equatable, Sendable, Identifiable {
    public var date: String
    public var name: String?
    public var amountUSD: Double?
    public var costUsd: Double? { amountUSD }

    public var id: String { date }

    public init(date: String, name: String? = nil, amountUSD: Double? = nil) {
        self.date = date
        self.name = name
        self.amountUSD = amountUSD
    }

    private enum CodingKeys: String, CodingKey {
        case date, name, costUsd
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decodeIfPresent(String.self, forKey: .name)
        date = try values.decodeIfPresent(String.self, forKey: .date) ?? name ?? ""
        amountUSD = try values.decodeIfPresent(Double.self, forKey: .costUsd)
    }
}

public struct ProviderModelEffortDailyGroup: Decodable, Equatable, Sendable {
    public var provider: String
    public var model: String
    public var effort: String
    public var daily: [DailySpendPoint]

    public init(
        provider: String,
        model: String,
        effort: String,
        daily: [DailySpendPoint] = []
    ) {
        self.provider = provider
        self.model = model
        self.effort = effort
        self.daily = daily
    }

    private enum CodingKeys: String, CodingKey { case provider, model, effort, daily }
}

public struct ProviderSpend: Equatable, Sendable, Identifiable {
    public var provider: String
    public var amountUSD: Double

    public var id: String { provider }
    public var costUsd: Double { amountUSD }

    public init(provider: String, amountUSD: Double) {
        self.provider = provider
        self.amountUSD = amountUSD
    }
}

public struct SyncInfo: Decodable, Equatable, Sendable {
    public var state: SyncState
    public var available: Bool?
    public var startedAt: Date?
    public var finishedAt: Date?
    public var error: String?

    public init(
        state: SyncState,
        available: Bool? = nil,
        startedAt: Date? = nil,
        finishedAt: Date? = nil,
        error: String? = nil
    ) {
        self.state = state
        self.available = available
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case state, available, startedAt, finishedAt, error
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let rawState = try values.decodeIfPresent(String.self, forKey: .state)?.lowercased() ?? ""
        guard let decodedState = SyncState.parse(rawState) else {
            throw DecodingError.dataCorruptedError(forKey: .state, in: values, debugDescription: "Unknown sync state \(rawState)")
        }
        state = decodedState
        available = try values.decodeIfPresent(Bool.self, forKey: .available)
        startedAt = try values.decodeIfPresent(String.self, forKey: .startedAt).flatMap(Self.parseDate)
        finishedAt = try values.decodeIfPresent(String.self, forKey: .finishedAt).flatMap(Self.parseDate)
        error = try values.decodeIfPresent(String.self, forKey: .error)
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

public struct UsageProfile: Decodable, Equatable, Sendable {
    public var id: String?
    public var name: String?
    public var mode: String?

    public init(id: String? = nil, name: String? = nil, mode: String? = nil) {
        self.id = id
        self.name = name
        self.mode = mode
    }

    private enum CodingKeys: String, CodingKey { case id, name, mode }
}

public struct SummaryResponse: Decodable, Equatable, Sendable {
    public var contractVersion: Int
    public var calendarTimeZone: String?
    public var usageProfile: UsageProfile?
    public var costSemantics: String?
    public var generatedAt: Date?
    public var apiEquivalentCostUSD: Double?
    public var billedCostUSD: Double?
    public var total: UsagePeriod?
    public var currentMonth: UsagePeriod?
    public var daily: [DailySpendPoint]
    public var providerModelEffortDaily: [ProviderModelEffortDailyGroup]
    public var configurationRevision: String?
    public var pricingBasis: String?
    public var pricingStale: Bool?
    public var sync: SyncInfo
    private var serverBudget: BudgetInfo?

    /// Policy values come from the Node service so native and web clients use
    /// the same calendar, usage profile, and budget semantics.
    public var monthToDate: UsagePeriod? { currentMonth }
    public var today: UsagePeriod? { currentDay(on: Date()) }
    public var budget: BudgetInfo {
        serverBudget ?? BudgetInfo(
            limitUSD: usageProfile?.mode?.lowercased() == "api" ? currentMonth?.limitUSD : nil,
            spentUSD: currentMonth?.amountUSD,
            status: "server-policy-unavailable"
        )
    }
    public var dashboardURL: URL? { nil }

    /// Returns a contiguous calendar-month series for the compact chart. The
    /// service only sends days that have usage, so settled gaps through the
    /// report's `through` date are explicit zeroes while future days stay blank.
    public func dailyPointsForChart() -> [DailySpendPoint] {
        let timeZone = TimeZone(identifier: calendarTimeZone ?? "UTC")
            ?? TimeZone(secondsFromGMT: 0)!
        guard let currentMonth, let monthName = currentMonth.name,
              let start = Self.monthStart(monthName, timeZone: timeZone),
              currentMonth.amountUSD != nil || !daily.isEmpty
        else {
            return daily.sorted { $0.date < $1.date }
        }

        var rows: [String: DailySpendPoint] = [:]
        for row in daily where row.date.hasPrefix("\(monthName)-") {
            rows[row.date] = row
        }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let monthRange = calendar.range(of: .day, in: .month, for: start) else {
            return daily.sorted { $0.date < $1.date }
        }
        let lastDay = monthRange.count
        let throughDay = currentMonth.through
            .flatMap { Self.dateKeyDate($0, timeZone: timeZone) }
            .flatMap { throughDate in
                let sameMonth = calendar.component(.year, from: throughDate) == calendar.component(.year, from: start)
                    && calendar.component(.month, from: throughDate) == calendar.component(.month, from: start)
                let day = calendar.component(.day, from: throughDate)
                return sameMonth && day >= 1 && day <= lastDay ? day : nil
            }
            ?? lastDay
        let settled = sync.state == .idle || sync.state == .succeeded

        return (1...lastDay).compactMap { day in
            guard let date = calendar.date(byAdding: .day, value: day - 1, to: start) else { return nil }
            let key = Self.dateKey(date, calendar: calendar)
            if let row = rows[key] { return row }
            return DailySpendPoint(date: key, amountUSD: settled && day <= throughDay ? 0 : nil)
        }
    }

    public init(
        contractVersion: Int = 1,
        calendarTimeZone: String? = nil,
        usageProfile: UsageProfile? = nil,
        costSemantics: String? = nil,
        generatedAt: Date? = nil,
        apiEquivalentCostUSD: Double? = nil,
        billedCostUSD: Double? = nil,
        total: UsagePeriod? = nil,
        currentMonth: UsagePeriod? = nil,
        daily: [DailySpendPoint] = [],
        providerModelEffortDaily: [ProviderModelEffortDailyGroup] = [],
        configurationRevision: String? = nil,
        pricingBasis: String? = nil,
        pricingStale: Bool? = nil,
        budget: BudgetInfo? = nil,
        sync: SyncInfo = SyncInfo(state: .idle)
    ) {
        self.contractVersion = contractVersion
        self.calendarTimeZone = calendarTimeZone
        self.usageProfile = usageProfile
        self.costSemantics = costSemantics
        self.generatedAt = generatedAt
        self.apiEquivalentCostUSD = apiEquivalentCostUSD
        self.billedCostUSD = billedCostUSD
        self.total = total
        self.currentMonth = currentMonth
        self.daily = daily
        self.providerModelEffortDaily = providerModelEffortDaily
        self.configurationRevision = configurationRevision
        self.pricingBasis = pricingBasis
        self.pricingStale = pricingStale
        serverBudget = budget
        self.sync = sync
    }

    private enum CodingKeys: String, CodingKey {
        case contractVersion
        case generatedAt, calendarTimeZone, usageProfile, costSemantics
        case apiEquivalentCostUsd, billedCostUsd, total, currentMonth, daily
        case budget
        case providerModelEffortDaily
        case configurationRevision, pricingBasis, pricingStale
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        contractVersion = try values.decodeIfPresent(Int.self, forKey: .contractVersion) ?? 1
        guard contractVersion == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .contractVersion,
                in: values,
                debugDescription: "Unsupported summary contract version \(contractVersion)"
            )
        }
        generatedAt = try values.decodeIfPresent(String.self, forKey: .generatedAt).flatMap(Self.parseDate)
        calendarTimeZone = try values.decodeIfPresent(String.self, forKey: .calendarTimeZone)
        usageProfile = try values.decodeIfPresent(UsageProfile.self, forKey: .usageProfile)
        costSemantics = try values.decodeIfPresent(String.self, forKey: .costSemantics)
        apiEquivalentCostUSD = try values.decodeIfPresent(Double.self, forKey: .apiEquivalentCostUsd)
        billedCostUSD = try values.decodeIfPresent(Double.self, forKey: .billedCostUsd)
        total = try values.decodeIfPresent(UsagePeriod.self, forKey: .total)
        currentMonth = try values.decodeIfPresent(UsagePeriod.self, forKey: .currentMonth)
        daily = try values.decodeIfPresent([DailySpendPoint].self, forKey: .daily) ?? []
        providerModelEffortDaily = try values.decodeIfPresent([ProviderModelEffortDailyGroup].self, forKey: .providerModelEffortDaily) ?? []
        configurationRevision = try values.decodeIfPresent(String.self, forKey: .configurationRevision)
        pricingBasis = try values.decodeIfPresent(String.self, forKey: .pricingBasis)
        pricingStale = try values.decodeIfPresent(Bool.self, forKey: .pricingStale)
        serverBudget = try values.decodeIfPresent(BudgetInfo.self, forKey: .budget)
        sync = SyncInfo(state: .idle)
    }

    public func providerSpendToday(on date: Date) -> [ProviderSpend] {
        let day = Self.dateKey(date)
        return providerSpend { row in row == day }
    }

    public func providerSpendMonthToDate(on date: Date) -> [ProviderSpend] {
        guard let month = currentMonth?.name, month.range(of: #"^\d{4}-\d{2}$"#, options: .regularExpression) != nil else {
            return []
        }
        let start = "\(month)-01"
        let through = currentMonth?.through.flatMap(Self.validDateKey) ?? Self.dateKey(date)
        guard through >= start, through.hasPrefix("\(month)-") else { return [] }
        return providerSpend { row in
            row >= start && row <= through && row.hasPrefix("\(month)-")
        }
    }

    private func providerSpend(where matches: (String) -> Bool) -> [ProviderSpend] {
        var totals: [String: Double] = [:]
        for group in providerModelEffortDaily {
            for row in group.daily {
                let day = row.date
                guard matches(day) else { continue }
                totals[group.provider, default: 0] += row.amountUSD ?? 0
            }
        }
        return totals.map { ProviderSpend(provider: $0.key, amountUSD: $0.value) }
            .sorted { lhs, rhs in
                lhs.amountUSD > rhs.amountUSD
                    || (lhs.amountUSD == rhs.amountUSD && lhs.provider < rhs.provider)
            }
    }

    public func currentDay(on date: Date) -> UsagePeriod? {
        let key = Self.dateKey(date)
        if let row = daily.first(where: { $0.date == key || $0.name == key }) {
            return UsagePeriod(date: row.date, name: row.name, amountUSD: row.amountUSD)
        }
        // The summary always includes a settled currentMonth object. A day
        // with no daily row therefore means a real zero, not missing data.
        guard sync.state == .idle || sync.state == .succeeded else { return nil }
        guard currentMonth?.amountUSD != nil else { return nil }
        return UsagePeriod(date: key, name: key, amountUSD: 0)
    }

    public func budget(on _: Date) -> BudgetInfo {
        budget
    }

    public var hasAnyUsageValue: Bool {
        currentMonth?.amountUSD != nil || daily.contains { $0.amountUSD != nil }
    }

    private static func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    private static func dateKeyDate(_ value: String, timeZone: TimeZone = TimeZone(secondsFromGMT: 0)!) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private static func monthStart(_ value: String, timeZone: TimeZone) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM"
        return formatter.date(from: value)
    }

    private static func dateKey(_ date: Date) -> String {
        dateKey(date, timeZone: TimeZone(secondsFromGMT: 0)!)
    }

    private static func dateKey(_ date: Date, calendar: Calendar) -> String {
        dateKey(date, timeZone: calendar.timeZone)
    }

    private static func dateKey(_ date: Date, timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func validDateKey(_ value: String) -> String? {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

}

public enum ConnectionState: Equatable, Sendable {
    case finding
    case starting(port: Int)
    case syncing(lastGood: Bool)
    case connected
    case staleRetainingCache
    case occupied(endpoint: Endpoint)
    case notTokenomics(endpoint: Endpoint)
    case startFailure(message: String, output: String)
    case unavailable(message: String)

    public var isUsable: Bool {
        switch self {
        case .connected, .staleRetainingCache, .syncing(lastGood: true): return true
        default: return false
        }
    }
}

public enum EndpointError: Error, Equatable, Sendable {
    case invalidURL
    case timeout
    case occupied
    case notTokenomics
    case httpStatus(Int)
    case decoding(String)
    case network(String)
}

public struct Endpoint: Codable, Equatable, Hashable, Sendable, CustomStringConvertible {
    public var port: Int
    public var host: String

    public init(port: Int, host: String = "127.0.0.1") {
        self.port = port
        self.host = host
    }

    public var url: URL {
        URL(string: "http://\(host == "::1" ? "[::1]" : host):\(port)")!
    }
    public var description: String { url.absoluteString }
}

public enum Presentation {
    public static func currency(_ value: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.maximumFractionDigits = abs(value) >= 100 ? 0 : 2
        formatter.minimumFractionDigits = abs(value) >= 100 ? 0 : 2
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "$%.2f", value)
    }

    public static func compactCurrency(_ value: Double) -> String {
        let sign = value < 0 ? "-" : ""
        let magnitude = abs(value)
        if magnitude >= 1_000_000 { return String(format: "%@$%.1fM", sign, magnitude / 1_000_000) }
        if magnitude >= 1_000 { return String(format: "%@$%.1fk", sign, magnitude / 1_000) }
        if magnitude >= 100 { return String(format: "%@$%.0f", sign, magnitude) }
        return String(format: "%@$%.2f", sign, magnitude)
    }

    public static func denominator(_ value: Double?) -> String? {
        guard let value else { return nil }
        return currency(value)
    }
}
