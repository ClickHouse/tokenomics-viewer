import AppKit
import Charts
import Combine
import SwiftUI

enum BudgetUsageLevel: Equatable {
    case normal
    case warning
    case exceeded

    init(amount: Double, limit: Double) {
        switch amount / limit {
        case ..<0.80: self = .normal
        case ..<1.00: self = .warning
        default: self = .exceeded
        }
    }

    var color: Color {
        switch self {
        case .normal: return .secondary
        case .warning: return .orange
        case .exceeded: return .red
        }
    }
}

enum QuotaPresentation {
    static func orderedWindows(_ windows: [SubscriptionWindow]) -> [SubscriptionWindow] {
        windows
            .filter { $0.windowMinutes > 0 }
            .sorted { lhs, rhs in
                lhs.windowMinutes < rhs.windowMinutes
                    || (lhs.windowMinutes == rhs.windowMinutes && lhs.key < rhs.key)
            }
    }

    static func shortestWindow(
        _ windows: [SubscriptionWindow],
        requiringReset: Bool = false
    ) -> SubscriptionWindow? {
        orderedWindows(windows).first { window in
            if requiringReset { return window.resetAt != nil }
            return normalizedPercent(window.usedPercent) != nil
        }
    }

    static func windowLabel(minutes: Int) -> String {
        switch minutes {
        case 300: return "5-hour"
        case 10_080: return "Weekly"
        case let value where value % 1_440 == 0: return "\(value / 1_440)-day"
        case let value where value % 60 == 0: return "\(value / 60)-hour"
        default: return "\(minutes)-minute"
        }
    }

    static func compactWindowLabel(minutes: Int) -> String {
        switch minutes {
        case 10_080: return "1w"
        case let value where value % 1_440 == 0: return "\(value / 1_440)d"
        case let value where value % 60 == 0: return "\(value / 60)h"
        default: return "\(minutes)m"
        }
    }

    static func windowTitle(_ window: SubscriptionWindow) -> String {
        let provider: String?
        switch window.provider?.lowercased() {
        case "openai": provider = "OpenAI"
        case "anthropic": provider = "Anthropic"
        case let value?: provider = value.localizedCapitalized
        case nil: provider = nil
        }
        return [provider, windowLabel(minutes: window.windowMinutes)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    static func normalizedPercent(_ value: Double?) -> Double? {
        guard let value, value.isFinite else { return nil }
        return min(100, max(0, value))
    }

    static func percentText(_ value: Double?) -> String? {
        normalizedPercent(value).map { String(format: "%.0f%%", $0) }
    }

    static func resetCountdown(resetAt: Date?, now: Date) -> String? {
        guard let resetAt else { return nil }
        let seconds = resetAt.timeIntervalSince(now)
        guard seconds > 0 else { return "Reset pending" }
        let minutes = max(1, Int(ceil(seconds / 60)))
        if minutes < 60 { return "Resets in \(minutes)m" }
        let hours = minutes / 60
        let remainingMinutes = minutes % 60
        if hours < 24 {
            return remainingMinutes == 0 ? "Resets in \(hours)h" : "Resets in \(hours)h \(remainingMinutes)m"
        }
        let days = hours / 24
        let remainingHours = hours % 24
        return remainingHours == 0 ? "Resets in \(days)d" : "Resets in \(days)d \(remainingHours)h"
    }
}

enum MenuBarPresentation {
    static func labelText(
        payload: SummaryResponse,
        mode: MenuBarLabelMode,
        now: Date
    ) -> String? {
        switch mode {
        case .today:
            guard payload.hasAnyUsageValue, let today = payload.currentDay(on: now)?.amountUSD else { return nil }
            let prefix = payload.costSemantics == "api-equivalent" ? "Today eq." : "Today"
            let denominator = todayDenominator(payload)
            if let denominator {
                return "\(prefix) \(Presentation.compactCurrency(today))/\(Presentation.compactCurrency(denominator))"
            }
            return "\(prefix) \(Presentation.compactCurrency(today))"
        case .quotaUsed:
            guard let window = QuotaPresentation.shortestWindow(payload.subscriptionWindows),
                  let used = QuotaPresentation.percentText(window.usedPercent)
            else { return nil }
            return "\(QuotaPresentation.compactWindowLabel(minutes: window.windowMinutes)) \(used)"
        case .quotaReset:
            guard let window = QuotaPresentation.shortestWindow(payload.subscriptionWindows, requiringReset: true),
                  let reset = QuotaPresentation.resetCountdown(resetAt: window.resetAt, now: now)
            else { return nil }
            return "\(QuotaPresentation.compactWindowLabel(minutes: window.windowMinutes)) \(reset.replacingOccurrences(of: "Resets in ", with: ""))"
        }
    }

    private static func todayDenominator(_ payload: SummaryResponse) -> Double? {
        guard payload.budget.todayScheduled ?? true else { return nil }
        let profileMode = payload.usageProfile?.mode?.lowercased() ?? ""
        let budgetStatus = payload.budget.status?.lowercased() ?? ""
        let noLimit = profileMode.contains("subscription")
            || profileMode.contains("no-limit")
            || profileMode.contains("unlimited")
            || budgetStatus.contains("subscription")
            || budgetStatus.contains("no-limit")
            || budgetStatus.contains("unlimited")
        return noLimit ? nil : payload.budget.todayAllowanceUSD
    }
}

public struct MenuBarLabelView: View {
    @ObservedObject var coordinator: ConnectionCoordinator
    @ObservedObject private var clock: MinuteClock
    @ObservedObject private var preferences: PreferencesStore

    public init(coordinator: ConnectionCoordinator, clock: MinuteClock) {
        self.coordinator = coordinator
        self.clock = clock
        _preferences = ObservedObject(wrappedValue: coordinator.preferences)
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let text = labelText(now: clock.now) {
                if coordinator.state.isUsable == false { Image(systemName: iconName).accessibilityHidden(true) }
                Text(text)
            } else {
                Image(systemName: iconName).accessibilityHidden(true)
                Text(stateLabel)
            }
        }
        .accessibilityLabel(accessibilityText(now: clock.now))
        .help(accessibilityText(now: clock.now))
        .font(.system(size: 12, weight: .medium, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(labelColor)
        .task { coordinator.start() }
    }

    private func labelText(now: Date) -> String? {
        guard let payload = coordinator.payload ?? coordinator.lastGoodPayload else { return nil }
        return MenuBarPresentation.labelText(payload: payload, mode: preferences.menuBarLabelMode, now: now)
    }

    private var iconName: String {
        switch coordinator.state {
        case .starting: return "play.circle"
        case .syncing: return "arrow.triangle.2.circlepath"
        case .staleRetainingCache: return "clock.badge.exclamationmark"
        case .startFailure, .occupied, .notTokenomics, .unavailable: return "exclamationmark.triangle"
        default: return "circle.dashed"
        }
    }

    private var stateLabel: String {
        switch coordinator.state {
        case .finding: return "Tokenomics…"
        case .starting: return "Starting…"
        case .syncing(let lastGood): return lastGood ? "Syncing…" : "Syncing"
        case .connected: return "No usage yet"
        case .staleRetainingCache: return "Stale"
        case .occupied: return "Port occupied"
        case .notTokenomics: return "Wrong service"
        case .startFailure: return "Start failed"
        case .unavailable: return "Offline"
        }
    }

    private var labelColor: Color {
        switch coordinator.state {
        case .connected: return .primary
        case .staleRetainingCache, .startFailure, .occupied, .notTokenomics, .unavailable: return .orange
        default: return .secondary
        }
    }

    private func accessibilityText(now: Date) -> String {
        if let payload = coordinator.payload ?? coordinator.lastGoodPayload {
            let today = payload.currentDay(on: now)?.amountUSD.map(Presentation.currency) ?? "No data"
            let month = payload.monthToDate?.amountUSD.map(Presentation.currency) ?? "No data"
            return "Tokenomics. Today \(today). Month to date \(month). State \(stateLabel)."
        }
        return "Tokenomics: \(stateLabel)"
    }
}

public struct PopoverView: View {
    @ObservedObject var coordinator: ConnectionCoordinator
    @ObservedObject private var clock: MinuteClock
    private let settingsWindowController: SettingsWindowController
    @State private var showDetails = false

    public init(
        coordinator: ConnectionCoordinator,
        clock: MinuteClock,
        settingsWindowController: SettingsWindowController
    ) {
        self.coordinator = coordinator
        self.clock = clock
        self.settingsWindowController = settingsWindowController
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            stateBanner
            quotaSection
            todaySection
            Divider()
            monthSection
            dailySection
            Divider()
            footer
        }
        .padding(16)
        .frame(width: 360)
        .fixedSize(horizontal: false, vertical: true)
        .background {
            GeometryReader { geometry in
                PopoverWindowSizer(contentSize: geometry.size)
                    .allowsHitTesting(false)
            }
        }
        .task { coordinator.start() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Tokenomics").font(.headline)
            Spacer()
            Text(verbatim: "Port " + String(coordinator.preferences.preferredPort))
                .font(.caption2.weight(.medium))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var stateBanner: some View {
        let message = stateMessage
        if let message {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 6) {
                    if showsProgress {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: stateIcon).accessibilityHidden(true)
                    }
                    Text(message).fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption)
                .foregroundStyle(stateColor)
                if coordinator.canStartTokenomics && showsStartButton {
                    Button {
                        coordinator.startTokenomics()
                    } label: {
                        if coordinator.isRefreshing {
                            ProgressView()
                                .controlSize(.small)
                            Text("Starting Tokenomics…")
                        } else {
                            Label("Start Tokenomics", systemImage: "play.fill")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(coordinator.isRefreshing)
                }
                if case .startFailure = coordinator.state {
                    HStack {
                        Button("Retry") { coordinator.retry() }
                        Button(showDetails ? "Hide log" : "View log") { showDetails.toggle() }
                    }
                    .font(.caption)
                } else if case .starting = coordinator.state {
                    Button(showDetails ? "Hide log" : "View log") { showDetails.toggle() }
                        .font(.caption)
                }
                if showDetails, showsLauncherLog {
                    LauncherLogView(text: launcherLogText)
                }
            }
        }
    }

    @ViewBuilder
    private var quotaSection: some View {
        let windows = QuotaPresentation.orderedWindows(payload?.subscriptionWindows ?? [])
        if !windows.isEmpty {
            if windows.count > 4 {
                ScrollView {
                    QuotaCockpitView(windows: windows, now: clock.now)
                }
                .frame(maxHeight: 180)
            } else {
                QuotaCockpitView(windows: windows, now: clock.now)
            }
            Divider()
        }
    }

    private var todaySection: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(todayTitle).foregroundStyle(.secondary)
                Spacer()
                Text(todayAmount).font(.title3.weight(.semibold))
            }
            ProviderBreakdownView(rows: todayProviderSpend)
            if let denominator = todayDenominator {
                ProgressView(value: todayValue / max(denominator, 0.000_001))
                    .tint(BudgetUsageLevel(amount: todayValue, limit: denominator).color)
                    .accessibilityLabel("Today budget progress")
                    .accessibilityValue("\(Presentation.currency(todayValue)) of \(Presentation.currency(denominator))")
                Text("Budget \(Presentation.currency(denominator))").font(.caption).foregroundStyle(.secondary)
            } else if isNoLimit {
                Text(subscriptionLabel).font(.caption).foregroundStyle(.secondary)
            } else if !scheduledToday {
                Text("No budget scheduled today").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var monthSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(monthTitle).foregroundStyle(.secondary)
                Spacer()
                Text(monthAmount).font(.title3.weight(.semibold))
            }
            ProviderBreakdownView(rows: monthProviderSpend)
            if let denominator = monthDenominator {
                ProgressView(value: monthValue / max(denominator, 0.000_001))
                    .tint(BudgetUsageLevel(amount: monthValue, limit: denominator).color)
                    .accessibilityLabel("Month to date budget progress")
                    .accessibilityValue("\(Presentation.currency(monthValue)) of \(Presentation.currency(denominator))")
                Text("Budget \(Presentation.currency(denominator))").font(.caption).foregroundStyle(.secondary)
            } else if isNoLimit {
                Text(subscriptionLabel).font(.caption).foregroundStyle(.secondary)
            } else {
                Text("No monthly budget set").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var dailySection: some View {
        let points = (coordinator.payload ?? coordinator.lastGoodPayload)?.dailyPointsForChart() ?? []
        let target = payload?.budget.baselineDailyTargetUSD
        if points.isEmpty {
            Text("No daily history yet").font(.caption).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Daily usage").font(.subheadline.weight(.medium))
                if let target {
                    Text("Weekday target \(Presentation.currency(target))/day")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                DailyUsageChart(points: points, target: target)
                    .frame(height: 82)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(syncLabel).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button {
                    coordinator.refresh(triggerSync: true)
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .disabled(coordinator.isRefreshing)
            }
            if let url = coordinator.dashboardURL {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Label("Open Dashboard", systemImage: "safari")
                        .frame(maxWidth: .infinity, alignment: .center)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .help(url.absoluteString)
            }
            HStack {
                Button("Settings") {
                    settingsWindowController.present(dismissing: NSApp.keyWindow)
                }
                .buttonStyle(.borderless)
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }.buttonStyle(.borderless)
            }
            .font(.caption)
        }
    }

    private var payload: SummaryResponse? { coordinator.payload ?? coordinator.lastGoodPayload }
    private var todayValue: Double { payload?.today?.amountUSD ?? 0 }
    private var monthValue: Double { payload?.monthToDate?.amountUSD ?? 0 }
    private var todayAmount: String { payload?.today?.amountUSD.map(Presentation.currency) ?? "No data yet" }
    private var monthAmount: String { payload?.monthToDate?.amountUSD.map(Presentation.currency) ?? "No data yet" }
    private var todayTitle: String { isApiEquivalent ? "Today · API equivalent" : "Today" }
    private var monthTitle: String { isApiEquivalent ? "Month · API equivalent" : "Month to date" }
    private var isApiEquivalent: Bool { payload?.costSemantics == "api-equivalent" }
    private var todayProviderSpend: [ProviderSpend] { payload?.providerSpendToday(on: Date()) ?? [] }
    private var monthProviderSpend: [ProviderSpend] { payload?.providerSpendMonthToDate(on: Date()) ?? [] }
    private var scheduledToday: Bool { payload?.budget.todayScheduled ?? true }
    private var todayDenominator: Double? {
        guard scheduledToday, !isNoLimit else { return nil }
        return payload?.budget.todayAllowanceUSD
    }
    private var monthDenominator: Double? {
        guard !isNoLimit else { return nil }
        return payload?.budget.limitUSD
    }
    private var isNoLimit: Bool {
        let profileMode = payload?.usageProfile?.mode?.lowercased() ?? ""
        let budgetStatus = payload?.budget.status?.lowercased() ?? ""
        return profileMode.contains("subscription") || profileMode.contains("no-limit") || profileMode.contains("unlimited") || budgetStatus.contains("subscription") || budgetStatus.contains("no-limit") || budgetStatus.contains("unlimited")
    }
    private var subscriptionLabel: String {
        let mode = payload?.usageProfile?.mode?.lowercased() ?? ""
        let name = payload?.usageProfile?.name
        if mode.contains("subscription") {
            return name.map { "\($0) · API equivalent · no monetary budget" } ?? "API equivalent · no monetary budget"
        }
        return "No monthly budget set"
    }

    private var syncLabel: String {
        let state: String
        switch coordinator.state {
        case .finding: state = "Finding Tokenomics…"
        case .starting: state = "Starting Tokenomics…"
        case .syncing: state = "Syncing…"
        case .connected: state = "Connected"
        case .staleRetainingCache: state = "Stale · showing last good data"
        case .occupied: state = "Port occupied"
        case .notTokenomics: state = "Not a Tokenomics service"
        case .startFailure: state = "Start failed"
        case .unavailable: state = "Unavailable"
        }
        return state
    }

    private var stateMessage: String? {
        switch coordinator.state {
        case .finding: return nil
        case .starting: return "Tokenomics is starting and syncing local sessions. The first sync can take a while."
        case .syncing: return nil
        case .connected: return coordinator.lastErrorMessage
        case .staleRetainingCache: return coordinator.lastErrorMessage ?? "Showing the last good response while the service reconnects."
        case .occupied: return "The configured port is occupied by another service."
        case .notTokenomics: return "A different service answered on the configured port."
        case .startFailure(let message, _): return message
        case .unavailable(let message): return message
        }
    }

    private var stateIcon: String {
        switch coordinator.state {
        case .staleRetainingCache, .occupied, .notTokenomics, .startFailure, .unavailable: return "exclamationmark.triangle.fill"
        default: return "info.circle"
        }
    }

    private var stateColor: Color {
        switch coordinator.state {
        case .staleRetainingCache, .occupied, .notTokenomics, .startFailure, .unavailable: return .orange
        default: return .secondary
        }
    }

    private var showsStartButton: Bool {
        if case .unavailable = coordinator.state { return true }
        return false
    }

    private var showsProgress: Bool {
        switch coordinator.state {
        case .starting, .syncing: return true
        default: return false
        }
    }

    private var showsLauncherLog: Bool {
        switch coordinator.state {
        case .starting, .startFailure: return true
        default: return false
        }
    }

    private var launcherLogText: String {
        if !coordinator.launcherOutput.isEmpty { return coordinator.launcherOutput }
        if case .starting = coordinator.state { return "Waiting for launcher output…" }
        return "No launcher output was captured."
    }

}

private struct QuotaCockpitView: View {
    let windows: [SubscriptionWindow]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Quota").font(.subheadline.weight(.medium))
            ForEach(windows) { window in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(QuotaPresentation.windowTitle(window))
                            .help(window.key)
                        Spacer()
                        Text(QuotaPresentation.percentText(window.usedPercent).map { "\($0) used" } ?? "Usage unavailable")
                            .monospacedDigit()
                    }
                    .font(.caption)
                    if let used = QuotaPresentation.normalizedPercent(window.usedPercent) {
                        ProgressView(value: used, total: 100)
                            .tint(BudgetUsageLevel(amount: used, limit: 100).color)
                            .accessibilityLabel("\(QuotaPresentation.windowTitle(window)) quota")
                            .accessibilityValue("\(QuotaPresentation.percentText(used) ?? "Unknown") used")
                    }
                    HStack {
                        if let remaining = QuotaPresentation.percentText(window.remainingPercent) {
                            Text("\(remaining) remaining")
                        }
                        Spacer()
                        if let reset = QuotaPresentation.resetCountdown(resetAt: window.resetAt, now: now) {
                            Text(reset)
                                .help(window.resetAt?.formatted(date: .abbreviated, time: .shortened) ?? reset)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct ProviderBreakdownView: View {
    let rows: [ProviderSpend]

    var body: some View {
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(rows) { row in
                    HStack(spacing: 8) {
                        Text(providerLabel(row.provider))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(Presentation.currency(row.amountUSD))
                            .monospacedDigit()
                    }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func providerLabel(_ provider: String) -> String {
        switch provider.lowercased() {
        case "openai": return "OpenAI"
        case "anthropic": return "Anthropic"
        case "omp": return "OMP"
        default: return provider.localizedCapitalized
        }
    }
}

struct LauncherLogView: View {
    let text: String
    private let bottomID = "launcher-log-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(text)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(height: 1).id(bottomID)
                }
            }
            .frame(height: 120)
            .padding(6)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 5))
            .onAppear { scrollToBottom(proxy) }
            .onChange(of: text) { _, _ in scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            proxy.scrollTo(bottomID, anchor: .bottom)
        }
    }
}

private struct DailyUsageChart: View {
    let points: [DailySpendPoint]
    let target: Double?
    @State private var hoveredPoint: DailySpendPoint?

    private struct PlotPoint: Identifiable {
        let source: DailySpendPoint
        let day: Date

        var id: String { source.id }
    }

    var body: some View {
        let plotted = plotPoints
        Chart {
            if let target, target > 0 {
                RuleMark(y: .value("Daily target", target))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 2]))
                    .foregroundStyle(.secondary)
            }
            ForEach(plotted) { plottedPoint in
                BarMark(
                    x: .value("Day", plottedPoint.day, unit: .day),
                    y: .value("Usage", plottedPoint.source.amountUSD ?? 0)
                )
                .foregroundStyle(barColor(for: plottedPoint.source).opacity(
                    plottedPoint.source.id == hoveredPoint?.id ? 1 : 0.65
                ))
            }
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            guard let plotFrame = proxy.plotFrame else {
                                hoveredPoint = nil
                                return
                            }
                            let relativeX = location.x - geometry[plotFrame].origin.x
                            guard let date: Date = proxy.value(atX: relativeX) else {
                                hoveredPoint = nil
                                return
                            }
                            hoveredPoint = plotted.min { lhs, rhs in
                                abs(lhs.day.timeIntervalSince(date)) < abs(rhs.day.timeIntervalSince(date))
                            }?.source
                        case .ended:
                            hoveredPoint = nil
                        }
                    }
            }
        }
        .overlay(alignment: .topLeading) {
            if let hoveredPoint {
                Text("\(dayLabel(hoveredPoint.date)) · \(hoveredPoint.amountUSD.map(Presentation.currency) ?? "No data")")
                    .font(.caption2)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 3))
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Daily usage chart")
        .accessibilityValue(points.map { point in
            "\(point.date): \(point.amountUSD.map(Presentation.currency) ?? "No data")"
        }.joined(separator: ", "))
    }

    private var plotPoints: [PlotPoint] {
        points.compactMap { point in
            guard let day = date(for: point.date) else { return nil }
            return PlotPoint(source: point, day: day)
        }
    }

    private func date(for value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }

    private func dayLabel(_ value: String) -> String {
        guard let date = date(for: value) else { return value }
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    private func barColor(for point: DailySpendPoint) -> Color {
        guard let amount = point.amountUSD else { return .secondary.opacity(0.2) }
        guard let target, target > 0 else { return .primary }
        return BudgetUsageLevel(amount: amount, limit: target).color
    }
}

public struct SettingsView: View {
    @ObservedObject var preferences: PreferencesStore
    @ObservedObject private var loginItemController: LoginItemController
    private let onApply: () -> Void
    @State private var portText: String
    @State private var launcherPathText: String
    @State private var intervalText: String

    public init(
        preferences: PreferencesStore,
        loginItemController: LoginItemController,
        onApply: @escaping () -> Void = {}
    ) {
        self.preferences = preferences
        _loginItemController = ObservedObject(wrappedValue: loginItemController)
        self.onApply = onApply
        _portText = State(initialValue: String(preferences.preferredPort))
        _launcherPathText = State(initialValue: preferences.launcherPath)
        _intervalText = State(initialValue: String(Int(preferences.automaticSyncInterval)))
    }

    public var body: some View {
        Form {
            Section("Connection") {
                TextField("Preferred port", text: $portText)
                    .onSubmit { preferences.applyPortText(portText) }
                HStack {
                    TextField("Launcher fallback", text: $launcherPathText)
                        .onSubmit { preferences.applyLauncherPath(launcherPathText) }
                    Button("Choose…") { chooseLauncher() }
                }
                Text("The installer configures startup automatically. Choose an executable wrapper here only as a fallback.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section("Sync") {
                Toggle("Automatic sync", isOn: $preferences.automaticSyncEnabled)
                TextField("Interval (seconds)", text: $intervalText)
                    .onSubmit {
                        if let value = Double(intervalText), RuntimePreferences.validInterval(value) {
                            preferences.automaticSyncInterval = value
                        } else {
                            intervalText = String(Int(preferences.normalizedInterval()))
                        }
                    }
            }
            Section("Menu bar") {
                Picker("Label", selection: $preferences.menuBarLabelMode) {
                    ForEach(MenuBarLabelMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
            }
            Section("Startup") {
                Toggle(
                    "Launch Tokenomics at login",
                    isOn: Binding(
                        get: { loginItemController.isEnabled },
                        set: { loginItemController.setEnabled($0) }
                    )
                )
                .disabled(!loginItemController.canChangeRegistration)

                switch loginItemController.status {
                case .requiresApproval:
                    Text("macOS requires approval before Tokenomics can launch at login.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Open Login Items…") {
                        loginItemController.openSystemSettings()
                    }
                case .unavailable:
                    Text("Build and open Tokenomics.app to configure launch at login.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .notRegistered, .enabled:
                    EmptyView()
                }

                if let error = loginItemController.lastErrorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
            HStack {
                Spacer()
                Button("Apply") {
                    preferences.applyPortText(portText)
                    preferences.applyLauncherPath(launcherPathText)
                    if let value = Double(intervalText), RuntimePreferences.validInterval(value) {
                        preferences.automaticSyncInterval = value
                    }
                    onApply()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .formStyle(.grouped)
        .padding(12)
        .frame(width: 460)
        .onAppear { loginItemController.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            loginItemController.refresh()
        }
    }

    private func chooseLauncher() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose Launcher"
        if panel.runModal() == .OK, let path = panel.url?.path {
            launcherPathText = path
        }
    }
}
