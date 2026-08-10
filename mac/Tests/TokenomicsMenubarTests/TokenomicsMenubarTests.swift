import AppKit
import Combine
import Darwin
import Foundation
import SwiftUI
import XCTest
@testable import TokenomicsMenubar

@MainActor
final class MinuteClockTests: XCTestCase {
    func testClockPublishesInjectedMinuteTicks() {
        let start = Date(timeIntervalSince1970: 1_000)
        let tick = Date(timeIntervalSince1970: 1_060)
        let updates = PassthroughSubject<Date, Never>()
        let clock = MinuteClock(now: start, updates: updates.eraseToAnyPublisher())

        var observed: [Date] = []
        let observation = clock.$now.sink { observed.append($0) }
        defer { observation.cancel() }

        updates.send(tick)

        XCTAssertEqual(clock.now, tick)
        XCTAssertEqual(observed, [start, tick])
    }
}

final class BudgetUsageLevelTests: XCTestCase {
    func testUsageLevelThresholds() {
        XCTAssertEqual(BudgetUsageLevel(amount: 79.99, limit: 100), .normal)
        XCTAssertEqual(BudgetUsageLevel(amount: 80, limit: 100), .warning)
        XCTAssertEqual(BudgetUsageLevel(amount: 99.99, limit: 100), .warning)
        XCTAssertEqual(BudgetUsageLevel(amount: 100, limit: 100), .exceeded)
        XCTAssertEqual(BudgetUsageLevel(amount: 101, limit: 100), .exceeded)
    }
}

@MainActor
final class LoginItemControllerTests: XCTestCase {
    func testRegistersAndUnregistersTheMainApp() {
        let service = RecordingLoginItemService(status: .notRegistered)
        let controller = LoginItemController(service: service)

        controller.setEnabled(true)

        XCTAssertEqual(service.registerCount, 1)
        XCTAssertEqual(controller.status, .enabled)
        XCTAssertTrue(controller.isEnabled)

        controller.setEnabled(false)

        XCTAssertEqual(service.unregisterCount, 1)
        XCTAssertEqual(controller.status, .notRegistered)
        XCTAssertFalse(controller.isEnabled)
    }

    func testRequiresApprovalOpensSystemSettingsWithoutReregistering() {
        let service = RecordingLoginItemService(status: .requiresApproval)
        var openSettingsCount = 0
        let controller = LoginItemController(
            service: service,
            openSettings: { openSettingsCount += 1 }
        )

        controller.setEnabled(true)

        XCTAssertEqual(openSettingsCount, 1)
        XCTAssertEqual(service.registerCount, 0)
        XCTAssertFalse(controller.canChangeRegistration)
    }

    func testUnavailableServiceExplainsThatAnAppBundleIsRequired() {
        let service = RecordingLoginItemService(status: .unavailable)
        let controller = LoginItemController(service: service)

        controller.setEnabled(true)

        XCTAssertEqual(service.registerCount, 0)
        XCTAssertEqual(
            controller.lastErrorMessage,
            "Launch at login is available from the packaged Tokenomics.app."
        )
    }

    func testRegistrationFailureIsSurfacedAndKeepsTheObservedStatus() {
        let service = RecordingLoginItemService(
            status: .notRegistered,
            registrationError: LoginItemTestError.registrationFailed
        )
        let controller = LoginItemController(service: service)

        controller.setEnabled(true)

        XCTAssertEqual(controller.status, .notRegistered)
        XCTAssertEqual(controller.lastErrorMessage, "Registration failed")
    }
}

final class QuotaPresentationTests: XCTestCase {
    func testQuotaLabelsAndCountdownUseInjectedClock() {
        let now = ISO8601DateFormatter().date(from: "2026-08-03T12:00:00Z")!
        let reset = ISO8601DateFormatter().date(from: "2026-08-03T13:24:00Z")!
        let window = SubscriptionWindow(
            key: "codex/primary",
            provider: "openai",
            windowMinutes: 300,
            usedPercent: 68,
            remainingPercent: 32,
            resetAt: reset
        )

        XCTAssertEqual(QuotaPresentation.windowLabel(minutes: 300), "5-hour")
        XCTAssertEqual(QuotaPresentation.windowLabel(minutes: 10_080), "Weekly")
        XCTAssertEqual(QuotaPresentation.windowTitle(window), "OpenAI · 5-hour")
        XCTAssertEqual(QuotaPresentation.resetCountdown(resetAt: reset, now: now), "Resets in 1h 24m")
        XCTAssertEqual(QuotaPresentation.resetCountdown(resetAt: reset, now: reset), "Reset pending")

        let payload = SummaryResponse(
            usageProfile: UsageProfile(name: "ChatGPT Pro", mode: "subscription"),
            costSemantics: "api-equivalent",
            subscriptionWindows: [window],
            currentMonth: UsagePeriod(name: "2026-08", through: "2026-08-03", amountUSD: 18.42),
            daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 18.42)]
        )
        XCTAssertEqual(MenuBarPresentation.labelText(payload: payload, mode: .today, now: now), "Today eq. $18.42")
        XCTAssertEqual(MenuBarPresentation.labelText(payload: payload, mode: .quotaUsed, now: now), "5h 68%")
        XCTAssertEqual(MenuBarPresentation.labelText(payload: payload, mode: .quotaReset, now: now), "5h 1h 24m")
    }

    func testInvalidPercentIsNotPresentedAsQuota() {
        let window = SubscriptionWindow(key: "invalid", windowMinutes: 300, usedPercent: .infinity)
        XCTAssertNil(QuotaPresentation.shortestWindow([window]))
        XCTAssertEqual(QuotaPresentation.normalizedPercent(-10), 0)
        XCTAssertEqual(QuotaPresentation.normalizedPercent(120), 100)
    }
}

@MainActor
final class SettingsWindowControllerTests: XCTestCase {
    func testAppRequestsAnActivatableAccessoryPolicy() {
        var requestedPolicies: [NSApplication.ActivationPolicy] = []
        AppDelegate(activationPolicyHandler: { requestedPolicies.append($0) })
            .applicationWillFinishLaunching(
                Notification(name: NSApplication.willFinishLaunchingNotification)
            )

        XCTAssertEqual(requestedPolicies, [.accessory])
    }

    func testPresentDismissesTransientWindowAndShowsFullSettingsWindow() async {
        _ = NSApplication.shared
        let canValidateWindowGeometry = NSApp.isRunning
        let suiteName = "TokenomicsMenubarTests.settings-window"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let controller = SettingsWindowController(
            preferences: PreferencesStore(defaults: suite)
        )
        let transientWindow = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 100, height: 100),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        transientWindow.orderFront(nil)

        controller.present(dismissing: transientWindow)
        await Task.yield()

        XCTAssertFalse(transientWindow.isVisible)
        XCTAssertTrue(controller.window?.isVisible == true)
        XCTAssertEqual(controller.window?.title, "Settings")
        XCTAssertEqual(SettingsWindowController.defaultContentSize, NSSize(width: 460, height: 440))
        if canValidateWindowGeometry {
            XCTAssertEqual(controller.window?.contentLayoutRect.size, SettingsWindowController.defaultContentSize)
        }

        controller.close()
        transientWindow.close()
    }

    func testLauncherLogHasAReadableExpandedHeight() {
        let view = NSHostingView(
            rootView: LauncherLogView(text: "starting initial sync\nprocessing local sessions")
                .frame(width: 300)
        )

        XCTAssertGreaterThanOrEqual(view.fittingSize.height, 120)
    }

    func testPopoverIntrinsicHeightTracksGrowingAndShrinkingContent() async throws {
        let suiteName = "TokenomicsMenubarTests.popover-sizing"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.automaticSyncEnabled = false
        let client = DisappearingClient()
        let coordinator = ConnectionCoordinator(
            preferences: preferences,
            client: client,
            launcher: FailingLauncher()
        )
        let settings = SettingsWindowController(preferences: preferences)
        let view = NSHostingView(
            rootView: PopoverView(
                coordinator: coordinator,
                clock: MinuteClock(
                    now: Date(timeIntervalSince1970: 1_000),
                    updates: Empty<Date, Never>().eraseToAnyPublisher()
                ),
                settingsWindowController: settings
            )
        )
        defer {
            coordinator.stop()
            settings.close()
        }

        let initialHeight = view.fittingSize.height
        coordinator.start()
        await coordinator.waitForCurrentOperation()
        await Task.yield()
        view.layoutSubtreeIfNeeded()
        let connectedHeight = view.fittingSize.height

        client.isAvailable = false
        coordinator.refresh(triggerSync: false)
        await coordinator.waitForCurrentOperation()
        await Task.yield()
        view.layoutSubtreeIfNeeded()
        let unavailableHeight = view.fittingSize.height

        XCTAssertGreaterThan(connectedHeight, initialHeight)
        XCTAssertLessThan(unavailableHeight, connectedHeight)
    }

    func testPopoverWindowResizeFollowsContentAndKeepsItsTopEdgeAnchored() async {
        let window = NSPanel(
            contentRect: NSRect(x: 100, y: 100, width: 360, height: 500),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        let resizeView = PopoverWindowResizeView()
        window.contentView?.addSubview(resizeView)
        defer { window.close() }

        let originalTop = window.frame.maxY
        resizeView.resizeWindow(to: NSSize(width: 360, height: 620))
        await Task.yield()

        XCTAssertEqual(window.contentRect(forFrameRect: window.frame).height, 620, accuracy: 0.5)
        XCTAssertEqual(window.frame.maxY, originalTop, accuracy: 0.5)

        resizeView.resizeWindow(to: NSSize(width: 360, height: 320))
        await Task.yield()

        XCTAssertEqual(window.contentRect(forFrameRect: window.frame).height, 320, accuracy: 0.5)
        XCTAssertEqual(window.frame.maxY, originalTop, accuracy: 0.5)
    }
}

@MainActor
final class DirectLauncherTests: XCTestCase {
    func testCapturesSubprocessOutputWhileItIsRunning() async throws {
        let process = try await DirectTokenomicsLauncher().start(
            executablePath: "/bin/sh",
            port: 8787,
            timeout: .seconds(2),
            baseArguments: ["-c", "printf 'starting initial sync\\n'; sleep 1"]
        )
        defer { process.stop() }

        for _ in 0..<20 where !process.output.contains("starting initial sync") {
            try await Task.sleep(for: .milliseconds(25))
        }

        XCTAssertTrue(process.isRunning)
        XCTAssertTrue(process.output.contains("starting initial sync"))
    }

    func testAppendsNoOpenAndConfiguredPortToLauncherArguments() async throws {
        let process = try await DirectTokenomicsLauncher().start(
            executablePath: "/bin/sh",
            port: 9123,
            timeout: .seconds(2),
            baseArguments: ["-c", "printf '%s\\n' \"$@\"; sleep 1", "sh"]
        )
        defer { process.stop() }

        for _ in 0..<40 where !process.output.contains("9123") {
            try await Task.sleep(for: .milliseconds(25))
        }

        XCTAssertEqual(process.output.split(separator: "\n").map(String.init), ["--no-open", "--port", "9123"])
    }

    func testStopTerminatesTheLauncherProcessGroup() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let pidFile = directory.appendingPathComponent("processes.txt")
        let process = try await DirectTokenomicsLauncher().start(
            executablePath: "/bin/sh",
            port: 8787,
            timeout: .seconds(2),
            baseArguments: [
                "-c",
                "sleep 30 & echo \"$$ $!\" > \"$1\"; wait",
                "sh",
                pidFile.path,
            ]
        )
        defer { process.stop() }

        for _ in 0..<40 where !FileManager.default.fileExists(atPath: pidFile.path) {
            try await Task.sleep(for: .milliseconds(25))
        }
        let identifiers = try String(contentsOf: pidFile, encoding: .utf8)
            .split(separator: " ")
            .compactMap { pid_t($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        XCTAssertEqual(identifiers.count, 2)
        guard identifiers.count == 2 else { return }
        XCTAssertEqual(getpgid(identifiers[0]), identifiers[0])
        XCTAssertEqual(getpgid(identifiers[1]), identifiers[0])

        process.stop()
        for _ in 0..<40 where kill(identifiers[0], 0) == 0 || kill(identifiers[1], 0) == 0 {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertNotEqual(kill(identifiers[0], 0), 0)
        XCTAssertNotEqual(kill(identifiers[1], 0), 0)
    }

    func testExitedLauncherDoesNotLeaveItsChildRunning() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let pidFile = directory.appendingPathComponent("child.txt")
        let process = try await DirectTokenomicsLauncher().start(
            executablePath: "/bin/sh",
            port: 8787,
            timeout: .seconds(2),
            baseArguments: [
                "-c",
                "sleep 30 & echo $! > \"$1\"; exit 0",
                "sh",
                pidFile.path,
            ]
        )
        defer { process.stop() }

        for _ in 0..<40 where !FileManager.default.fileExists(atPath: pidFile.path) {
            try await Task.sleep(for: .milliseconds(25))
        }
        let child = try String(contentsOf: pidFile, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let childIdentifier = pid_t(child) else {
            XCTFail("expected a child process identifier")
            return
        }
        for _ in 0..<40 where process.isRunning {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertFalse(process.isRunning)
        for _ in 0..<40 where kill(childIdentifier, 0) == 0 {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertNotEqual(kill(childIdentifier, 0), 0)
    }
}

final class LauncherConfigurationStoreTests: XCTestCase {
    func testFindsTheStandardInstalledLauncherWithoutPersistedConfiguration() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let launcher = home.appendingPathComponent(".local/bin/tokenomics-launch")
        try FileManager.default.createDirectory(
            at: launcher.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\n".utf8).write(to: launcher)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher.path)
        defer { try? FileManager.default.removeItem(at: home) }

        let configuration = LauncherConfigurationStore.resolveConfiguration(
            fallbackPath: "",
            persistedURL: home.appendingPathComponent("missing.json"),
            homeDirectory: home,
            executableURL: nil
        )

        XCTAssertEqual(configuration, PersistedLauncherConfiguration(command: launcher.path))
    }

    func testSwiftRunFindsTheRepositoryLauncherFromTheExecutableAncestors() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let launcher = root.appendingPathComponent("launcher.js")
        let executable = root.appendingPathComponent("mac/.build/debug/TokenomicsMenubar")
        try FileManager.default.createDirectory(
            at: executable.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/usr/bin/env node\n".utf8).write(to: launcher)
        try Data().write(to: root.appendingPathComponent("app.js"))
        try Data().write(to: root.appendingPathComponent("mac/Package.swift"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launcher.path)
        defer { try? FileManager.default.removeItem(at: root) }

        let configuration = LauncherConfigurationStore.resolveConfiguration(
            fallbackPath: "",
            persistedURL: root.appendingPathComponent("missing.json"),
            homeDirectory: root.appendingPathComponent("empty-home"),
            executableURL: executable
        )

        XCTAssertEqual(configuration, PersistedLauncherConfiguration(command: launcher.path))
    }
}

final class SummaryDecodingTests: XCTestCase {
    func testDecodesNodeGeneratedSummaryContractFixture() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "summary-v1", withExtension: "json", subdirectory: "Fixtures"))
        let response = try JSONDecoder().decode(SummaryResponse.self, from: Data(contentsOf: url))

        XCTAssertEqual(response.contractVersion, 1)
        XCTAssertEqual(response.currentMonth?.amountUSD, 34.5)
        XCTAssertEqual(response.budget.todayScheduled, true)
        XCTAssertEqual(response.budget.totalScheduledDays, 21)
        XCTAssertEqual(response.budget.remainingScheduledDays, 21)
        let allowance = try XCTUnwrap(response.budget.todayAllowanceUSD)
        XCTAssertEqual(allowance, 70.0 / 21.0, accuracy: 1e-12)
        XCTAssertEqual(response.budget.todayRemainingUSD, 0)
        XCTAssertEqual(response.budget.allowanceBasis, "monthly_limit_minus_spend_through_yesterday_divided_by_remaining_weekdays_utc")
    }

    func testDecodesNodeGeneratedSubscriptionQuotaFixture() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "summary-v1-subscription", withExtension: "json", subdirectory: "Fixtures"))
        let response = try JSONDecoder().decode(SummaryResponse.self, from: Data(contentsOf: url))

        XCTAssertEqual(response.usageProfile?.mode, "subscription")
        XCTAssertEqual(response.costSemantics, "api-equivalent")
        XCTAssertNil(response.billedCostUSD)
        XCTAssertEqual(response.subscriptionWindows.map(\.windowMinutes), [300, 10_080])
        XCTAssertEqual(response.subscriptionWindows.map(\.usedPercent), [68, 41])
        XCTAssertEqual(response.subscriptionWindows.first?.resetAt, ISO8601DateFormatter().date(from: "2026-08-03T13:24:00Z"))
        XCTAssertNil(response.subscriptionWindows.first?.projectedFullWindowApiEquivalentUSD)
    }

    func testDecodesExistingSummaryAndIgnoresAdditiveFields() throws {
        let json = """
        {
          "contractVersion": 1,
          "generatedAt": "2026-08-03T09:00:00.000Z",
          "calendarTimeZone": "UTC",
          "usageProfile": {"id": "workday", "name": "Workday", "mode": "api"},
          "costSemantics": "estimated",
          "currentMonth": {"name": "2026-08", "through": "2026-08-03", "costUsd": 12.5, "limitUsd": 75},
          "daily": [{"name": "2026-08-03", "costUsd": 0}],
          "budget": {
            "todayScheduled": true,
            "totalScheduledDays": 21,
            "remainingScheduledDays": 20,
            "limitUsd": 75,
            "spentUsd": 12.5,
            "remainingUsd": 62.5,
            "overageUsd": 0,
            "usedRatio": 0.1666666667,
            "baselineDailyTargetUsd": 3.5714285714,
            "todayAllowanceUsd": 3.75,
            "todayRemainingUsd": 3.75,
            "allowanceBasis": "server-owned-test-policy",
            "status": "on-track"
          },
          "configurationRevision": "c2",
          "pricingBasis": "list",
          "pricingStale": false,
          "futureField": {"can": "be ignored"}
        }
        """
        let response = try JSONDecoder().decode(SummaryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.currentMonth?.amountUSD, 12.5)
        XCTAssertEqual(response.currentDay(on: ISODate("2026-08-03"))?.amountUSD, 0)
        XCTAssertEqual(response.daily.first?.id, "2026-08-03")
        XCTAssertEqual(response.monthToDate?.amountUSD, 12.5)
        XCTAssertEqual(response.contractVersion, 1)
        XCTAssertEqual(response.budget(on: ISODate("2026-08-03")).limitUSD, 75)
        XCTAssertEqual(response.budget.todayAllowanceUSD, 3.75)
        XCTAssertEqual(response.budget.allowanceBasis, "server-owned-test-policy")
        XCTAssertTrue(response.hasAnyUsageValue)
        XCTAssertTrue(response.providerModelEffortDaily.isEmpty)
    }

    func testProviderDailyGroupsDecodeAndAggregateByProviderForTodayAndMonthToDate() throws {
        let json = """
        {
          "currentMonth": {"name": "2026-08", "through": "2026-08-03", "costUsd": 13},
          "providerModelEffortDaily": [
            {
              "provider": "openai",
              "model": "gpt-5.6-sol",
              "effort": "low",
              "daily": [
                {"name": "2026-08-01", "costUsd": 2},
                {"name": "2026-08-03", "costUsd": 1}
              ]
            },
            {
              "provider": "openai",
              "model": "gpt-5.6-sol",
              "effort": "high",
              "daily": [{"name": "2026-08-03", "costUsd": 2}]
            },
            {
              "provider": "anthropic",
              "model": "claude-opus-4-8",
              "effort": "default",
              "daily": [
                {"name": "2026-07-31", "costUsd": 100},
                {"name": "2026-08-02", "costUsd": 5},
                {"name": "2026-08-03", "costUsd": 0}
              ]
            },
            {
              "provider": "zeta",
              "model": "zeta-model",
              "effort": "default",
              "daily": [
                {"name": "2026-08-03", "costUsd": 0},
                {"name": "2026-08-04", "costUsd": 9}
              ]
            }
          ]
        }
        """

        let response = try JSONDecoder().decode(SummaryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.providerModelEffortDaily.count, 4)

        let today = response.providerSpendToday(on: ISODate("2026-08-03"))
        XCTAssertEqual(today.map(\.provider), ["openai", "anthropic", "zeta"])
        XCTAssertEqual(today.map(\.amountUSD), [3, 0, 0])

        let monthToDate = response.providerSpendMonthToDate(on: ISODate("2026-08-03"))
        XCTAssertEqual(monthToDate.map(\.provider), ["anthropic", "openai", "zeta"])
        XCTAssertEqual(monthToDate.map(\.amountUSD), [5, 5, 0])
    }

    func testNoDataDoesNotBecomeZeroButExplicitZeroDoes() {
        let noData = SummaryResponse(currentMonth: UsagePeriod(amountUSD: nil), daily: [])
        let zero = SummaryResponse(currentMonth: UsagePeriod(amountUSD: 0), daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 0)])
        XCTAssertFalse(noData.hasAnyUsageValue)
        XCTAssertTrue(zero.hasAnyUsageValue)
        XCTAssertTrue(noData.dailyPointsForChart().isEmpty)
        XCTAssertEqual(SummaryResponse(currentMonth: UsagePeriod(amountUSD: 0)).currentDay(on: ISODate("2026-08-03"))?.amountUSD, 0)
        XCTAssertEqual(Presentation.compactCurrency(0), "$0.00")
    }

    func testScheduleAndSubscriptionBudgetSemantics() throws {
        let serverBudget = BudgetInfo(
            todayScheduled: false,
            totalScheduledDays: 21,
            remainingScheduledDays: 20,
            limitUSD: 75,
            spentUSD: 12,
            remainingUSD: 63,
            overageUSD: 0,
            usedRatio: 0.16,
            baselineDailyTargetUSD: 75 / 21,
            todayAllowanceUSD: nil,
            todayRemainingUSD: nil,
            allowanceBasis: "server-owned-test-policy",
            status: "unscheduled"
        )
        let api = SummaryResponse(
            usageProfile: UsageProfile(name: "Workday", mode: "api"),
            currentMonth: UsagePeriod(amountUSD: 12, limitUSD: 75),
            budget: serverBudget
        )
        let scheduled = api.budget(on: ISODate("2026-08-02"))
        XCTAssertEqual(scheduled, serverBudget)

        let compatibility = SummaryResponse(
            usageProfile: UsageProfile(name: "Workday", mode: "api"),
            currentMonth: UsagePeriod(amountUSD: 12, limitUSD: 75)
        )
        XCTAssertEqual(compatibility.budget.status, "server-policy-unavailable")
        XCTAssertNil(compatibility.budget.todayScheduled)
        XCTAssertNil(compatibility.budget.todayAllowanceUSD)

        let subscription = SummaryResponse(
            usageProfile: UsageProfile(name: "Pro", mode: "subscription"),
            budget: BudgetInfo(status: "subscription")
        )
        XCTAssertEqual(subscription.usageProfile?.mode, "subscription")
        XCTAssertNil(subscription.budget(on: ISODate("2026-08-03")).limitUSD)
        XCTAssertEqual(subscription.budget.status, "subscription")
    }

    func testRejectsUnsupportedSummaryContractVersions() {
        let json = #"{"contractVersion":2}"#

        XCTAssertThrowsError(try JSONDecoder().decode(SummaryResponse.self, from: Data(json.utf8)))
    }

    func testChartSeriesFillsEverySettledDayInTheConfiguredMonth() {
        for (month, through, expectedCount) in [
            ("2024-02", "2024-02-29", 29),
            ("2026-04", "2026-04-30", 30),
            ("2026-08", "2026-08-31", 31),
        ] {
            let response = SummaryResponse(
                calendarTimeZone: "UTC",
                currentMonth: UsagePeriod(name: month, through: through, amountUSD: 1),
                daily: [DailySpendPoint(date: "\(month)-02", amountUSD: 0)],
                sync: SyncInfo(state: .succeeded)
            )
            let points = response.dailyPointsForChart()
            XCTAssertEqual(points.count, expectedCount)
            XCTAssertEqual(points[1].amountUSD, 0)
            XCTAssertEqual(points[0].amountUSD, 0)
            XCTAssertEqual(points.last?.date, through)
        }
    }

    func testChartSeriesShowsSettledZeroMonthWithoutDailyRows() {
        let response = SummaryResponse(
            calendarTimeZone: "UTC",
            currentMonth: UsagePeriod(name: "2026-08", through: "2026-08-03", amountUSD: 0),
            sync: SyncInfo(state: .succeeded)
        )
        let points = response.dailyPointsForChart()
        XCTAssertEqual(points.count, 31)
        XCTAssertTrue(points.prefix(3).allSatisfy { $0.amountUSD == 0 })
        XCTAssertTrue(points.dropFirst(3).allSatisfy { $0.amountUSD == nil })
    }
}

final class PortAndPreferencesTests: XCTestCase {
    func testDiscoveryUsesOnlyTheConfiguredPort() {
        let ports = PortDiscovery.orderedPorts(preferred: 8787, active: Endpoint(port: 9000))
        XCTAssertEqual(ports, [8787])
        XCTAssertEqual(PortDiscovery.orderedPorts(preferred: 65_530, active: nil), [65_530])
    }

    func testAutomaticSyncDefaultsAndInvalidIntervalFallback() {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.defaults")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.defaults")
        var preferences = RuntimePreferences(defaults: suite)
        XCTAssertTrue(preferences.automaticSyncEnabled)
        XCTAssertEqual(preferences.automaticSyncInterval, 20)
        preferences.automaticSyncEnabled = false
        preferences.automaticSyncInterval = 1
        preferences.menuBarLabelMode = .quotaReset
        preferences.save(to: suite)
        let loaded = RuntimePreferences(defaults: suite)
        XCTAssertFalse(loaded.automaticSyncEnabled)
        XCTAssertEqual(loaded.automaticSyncInterval, 20)
        XCTAssertEqual(loaded.menuBarLabelMode, .quotaReset)
    }

    @MainActor
    func testChangingPreferredPortClearsActiveEndpoint() {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.port-change")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.port-change")
        let preferences = PreferencesStore(defaults: suite)
        preferences.setActiveEndpoint(Endpoint(port: 9000))
        XCTAssertEqual(preferences.activeEndpoint?.port, 9000)
        preferences.preferredPort = 9001
        XCTAssertNil(preferences.activeEndpoint)
        XCTAssertNil(suite.string(forKey: "tokenomics.activeEndpoint"))
    }

    func testIntervalValidation() {
        XCTAssertTrue(RuntimePreferences.validInterval(20))
        XCTAssertFalse(RuntimePreferences.validInterval(4.99))
        XCTAssertFalse(RuntimePreferences.validInterval(3_601))
    }
}

@MainActor
final class CoordinatorSyncTests: XCTestCase {
    func testManualRefreshesDoNotOverlapSyncRequests() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.coordinator")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.coordinator")
        let preferences = PreferencesStore(defaults: suite)
        preferences.preferredPort = 8787
        let client = CountingClient()
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: FailingLauncher())
        coordinator.start()
        await coordinator.waitForCurrentOperation()
        coordinator.refresh(triggerSync: true)
        coordinator.refresh(triggerSync: true)
        await coordinator.waitForCurrentOperation()
        XCTAssertLessThanOrEqual(client.maximumConcurrentSyncs, 1)
        coordinator.stop()
    }

    func testDisabledAutomaticSyncDoesNotTriggerOnStartup() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.disabled-start")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.disabled-start")
        let preferences = PreferencesStore(defaults: suite)
        preferences.automaticSyncEnabled = false
        let client = CountingClient()
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: FailingLauncher())
        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(client.syncRequestCount, 0)
        coordinator.stop()
    }

    func testSyncFailureRetainsLastGoodSummaryAndError() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.sync-failure")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.sync-failure")
        let preferences = PreferencesStore(defaults: suite)
        let client = FlakySyncClient()
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: FailingLauncher())
        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(coordinator.state, .connected)
        coordinator.refresh(triggerSync: true)
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(coordinator.payload?.currentMonth?.amountUSD, 1)
        XCTAssertTrue(coordinator.lastErrorMessage?.contains("sync broke") == true)
        XCTAssertEqual(coordinator.state, .staleRetainingCache)
        coordinator.stop()
    }

    func testInitialRunningZeroIsNotRenderedAsLastGoodData() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.running")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.running")
        let preferences = PreferencesStore(defaults: suite)
        let coordinator = ConnectionCoordinator(preferences: preferences, client: RunningZeroClient(), launcher: FailingLauncher())
        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertNil(coordinator.payload)
        if case .syncing(lastGood: false) = coordinator.state {
            // Expected: an in-flight response cannot manufacture an initial $0.
        } else {
            XCTFail("expected syncing without a last-good payload")
        }
        coordinator.stop()
    }

    func testUnavailableStartsLauncherAutomatically() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.explicit-start")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.explicit-start")
        let preferences = PreferencesStore(defaults: suite)
        let client = StartableClient()
        let launcher = RecordingLauncher(client: client)
        let coordinator = ConnectionCoordinator(
            preferences: preferences,
            client: client,
            launcher: launcher,
            launcherConfigurationResolver: { _ in PersistedLauncherConfiguration(command: "/bin/sh") }
        )
        defer { coordinator.stop() }

        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(launcher.startCount, 1)
        XCTAssertTrue(coordinator.canStartTokenomics)
        XCTAssertEqual(coordinator.state, .connected)
    }

    func testAlreadyRunningTokenomicsIsReusedWithoutTakingOwnership() async throws {
        let suiteName = "TokenomicsMenubarTests.existing-service"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.launcherPath = "/bin/sh"
        let client = StartableClient()
        client.started = true
        let launcher = RecordingLauncher(client: client)
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: launcher)

        coordinator.start()
        await coordinator.waitForCurrentOperation()

        XCTAssertEqual(coordinator.state, .connected)
        XCTAssertEqual(launcher.startCount, 0)
        coordinator.stop()
    }

    func testWrongServiceIsNotReplacedByTheLauncher() async throws {
        let suiteName = "TokenomicsMenubarTests.wrong-service"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.launcherPath = "/bin/sh"
        let launcher = UnexpectedLauncher()
        let coordinator = ConnectionCoordinator(
            preferences: preferences,
            client: WrongServiceClient(),
            launcher: launcher
        )
        defer { coordinator.stop() }

        coordinator.start()
        await coordinator.waitForCurrentOperation()

        XCTAssertEqual(launcher.startCount, 0)
        XCTAssertEqual(coordinator.state, .notTokenomics(endpoint: Endpoint(port: 8787)))
    }

    func testApplicationTerminationStopsTokenomicsStartedByTheApp() async throws {
        let suiteName = "TokenomicsMenubarTests.application-termination"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.launcherPath = "/bin/sh"
        let client = StartableClient()
        let launcher = RecordingLauncher(client: client)
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: launcher)
        defer { coordinator.stop() }

        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertTrue(launcher.lastProcess?.isRunning == true)

        NotificationCenter.default.post(name: NSApplication.willTerminateNotification, object: nil)

        XCTAssertTrue(launcher.lastProcess?.isRunning == false)
    }

    func testStartupExposesLauncherOutputWhileWaitingForTheService() async throws {
        let suiteName = "TokenomicsMenubarTests.startup-output"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.launcherPath = "/bin/sh"
        let client = UnavailableClient()
        let coordinator = ConnectionCoordinator(
            preferences: preferences,
            client: client,
            launcher: OutputLauncher(output: "[start] scanning local sessions\n")
        )

        let probe = expectation(description: "startup probes the configured endpoint")
        client.onProbe = {
            client.onProbe = nil
            probe.fulfill()
        }
        coordinator.start()
        await fulfillment(of: [probe], timeout: 1)

        guard case .starting = coordinator.state else {
            XCTFail("expected startup to remain in progress")
            coordinator.stop()
            return
        }
        XCTAssertEqual(coordinator.launcherOutput, "[start] scanning local sessions\n")
        coordinator.stop()
    }

    func testOfflineOwnedProcessIsNotStartedTwice() async throws {
        let suiteName = "TokenomicsMenubarTests.no-duplicate-launch"
        let suite = UserDefaults(suiteName: suiteName)!
        suite.removePersistentDomain(forName: suiteName)
        let preferences = PreferencesStore(defaults: suite)
        preferences.launcherPath = "/bin/sh"
        let client = StartableClient()
        let launcher = RecordingLauncher(client: client)
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: launcher)
        defer { coordinator.stop() }

        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(coordinator.state, .connected)
        XCTAssertEqual(launcher.startCount, 1)

        client.started = false
        coordinator.refresh(triggerSync: false)
        await coordinator.waitForCurrentOperation()

        XCTAssertEqual(launcher.startCount, 1)
        guard case .unavailable(let message) = coordinator.state else {
            XCTFail("expected unavailable state while the owned process is still running")
            return
        }
        XCTAssertTrue(message.contains("launcher is running"))
    }

    func testChangingPreferredPortStartsLauncherForTheNewPort() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.port-switch")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.port-switch")
        let preferences = PreferencesStore(defaults: suite)
        preferences.preferredPort = 8787
        preferences.launcherPath = "/bin/sh"
        let client = PortSwitchClient(availablePorts: [8787])
        let launcher = PortStartingLauncher(client: client)
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: launcher)

        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(coordinator.state, .connected)
        XCTAssertNotNil(coordinator.payload)
        XCTAssertEqual(launcher.startedPorts, [])

        preferences.preferredPort = 8788
        await Task.yield()
        await coordinator.waitForCurrentOperation()

        XCTAssertTrue(client.probedPorts.contains(8788))
        XCTAssertEqual(launcher.startedPorts, [8788])
        XCTAssertNotNil(coordinator.payload)
        XCTAssertNotNil(coordinator.lastGoodPayload)
        XCTAssertEqual(coordinator.endpoint, Endpoint(port: 8788))
        XCTAssertTrue(coordinator.canStartTokenomics)
        XCTAssertEqual(coordinator.state, .connected)
        coordinator.stop()
    }

    func testEndpointDisappearanceClearsCacheWhenAutomaticRelaunchFails() async throws {
        let suite = UserDefaults(suiteName: "TokenomicsMenubarTests.endpoint-loss")!
        suite.removePersistentDomain(forName: "TokenomicsMenubarTests.endpoint-loss")
        let preferences = PreferencesStore(defaults: suite)
        preferences.automaticSyncEnabled = false
        preferences.launcherPath = "/bin/sh"
        let client = DisappearingClient()
        let coordinator = ConnectionCoordinator(preferences: preferences, client: client, launcher: FailingLauncher())

        coordinator.start()
        await coordinator.waitForCurrentOperation()
        XCTAssertEqual(coordinator.state, .connected)
        XCTAssertNotNil(coordinator.payload)

        client.isAvailable = false
        coordinator.refresh(triggerSync: false)
        await coordinator.waitForCurrentOperation()

        XCTAssertNil(coordinator.payload)
        XCTAssertNil(coordinator.lastGoodPayload)
        XCTAssertNil(coordinator.endpoint)
        XCTAssertNil(preferences.activeEndpoint)
        XCTAssertNil(coordinator.lastRefreshAt)
        XCTAssertTrue(coordinator.canStartTokenomics)
        guard case .startFailure = coordinator.state else {
            XCTFail("expected start failure after automatic relaunch failed")
            coordinator.stop()
            return
        }
        coordinator.stop()
    }
}

private final class CountingClient: TokenomicsHTTPClient, @unchecked Sendable {
    private var activeSyncs = 0
    private(set) var maximumConcurrentSyncs = 0
    private(set) var syncRequestCount = 0

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        SyncProbe(state: .succeeded)
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        SummaryResponse(currentMonth: UsagePeriod(amountUSD: 0), daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 0)], sync: SyncInfo(state: .succeeded))
    }

    func triggerSync(at endpoint: Endpoint) async throws {
        syncRequestCount += 1
        activeSyncs += 1
        maximumConcurrentSyncs = max(maximumConcurrentSyncs, activeSyncs)
        defer { activeSyncs -= 1 }
        try await Task.sleep(for: .milliseconds(100))
    }
}

private final class RunningZeroClient: TokenomicsHTTPClient, @unchecked Sendable {
    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe { SyncProbe(state: .running) }
    func triggerSync(at endpoint: Endpoint) async throws { throw EndpointError.network("busy") }
    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        SummaryResponse(currentMonth: UsagePeriod(amountUSD: 0), daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 0)], sync: SyncInfo(state: .running))
    }
}

@MainActor
private final class UnexpectedLauncher: TokenomicsLauncher {
    private(set) var startCount = 0

    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        startCount += 1
        throw LauncherError.launchFailed("unexpected launch")
    }
}

private final class WrongServiceClient: TokenomicsHTTPClient, @unchecked Sendable {
    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        throw EndpointError.notTokenomics
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        throw EndpointError.notTokenomics
    }

    func triggerSync(at endpoint: Endpoint) async throws {
        throw EndpointError.notTokenomics
    }
}

@MainActor
private final class RecordingLauncher: TokenomicsLauncher {
    private let client: StartableClient
    private(set) var startCount = 0
    private(set) var lastProcess: RecordingProcess?

    init(client: StartableClient) {
        self.client = client
    }

    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        startCount += 1
        client.started = true
        let process = RecordingProcess()
        lastProcess = process
        return process
    }
}

@MainActor
private final class PortStartingLauncher: TokenomicsLauncher {
    private let client: PortSwitchClient
    private(set) var startedPorts: [Int] = []

    init(client: PortSwitchClient) {
        self.client = client
    }

    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        startedPorts.append(port)
        client.availablePorts.insert(port)
        return RecordingProcess()
    }
}

@MainActor
private final class RecordingProcess: TokenomicsProcessHandle {
    var output: String
    var isRunning = true

    init(output: String = "") {
        self.output = output
    }

    func stop() { isRunning = false }
}

@MainActor
private final class OutputLauncher: TokenomicsLauncher {
    private let output: String

    init(output: String) {
        self.output = output
    }

    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        RecordingProcess(output: output)
    }
}

private final class StartableClient: TokenomicsHTTPClient, @unchecked Sendable {
    var started = false

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        guard started else { throw EndpointError.network("offline") }
        return SyncProbe(state: .succeeded)
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        SummaryResponse(
            currentMonth: UsagePeriod(name: "2026-08", through: "2026-08-03", amountUSD: 0),
            daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 0)]
        )
    }

    func triggerSync(at endpoint: Endpoint) async throws {}
}

private final class UnavailableClient: TokenomicsHTTPClient, @unchecked Sendable {
    var onProbe: (() -> Void)?

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        onProbe?()
        throw EndpointError.network("offline")
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        throw EndpointError.network("offline")
    }

    func triggerSync(at endpoint: Endpoint) async throws {
        throw EndpointError.network("offline")
    }
}

private final class PortSwitchClient: TokenomicsHTTPClient, @unchecked Sendable {
    private(set) var probedPorts: [Int] = []
    var availablePorts: Set<Int>

    init(availablePorts: Set<Int>) {
        self.availablePorts = availablePorts
    }

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        probedPorts.append(endpoint.port)
        guard availablePorts.contains(endpoint.port) else {
            throw EndpointError.network("offline")
        }
        return SyncProbe(state: .succeeded)
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        guard availablePorts.contains(endpoint.port) else {
            throw EndpointError.network("offline")
        }
        return SummaryResponse(
            currentMonth: UsagePeriod(name: "2026-08", through: "2026-08-03", amountUSD: 1),
            daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 1)],
            sync: SyncInfo(state: .succeeded)
        )
    }

    func triggerSync(at endpoint: Endpoint) async throws {}
}

private final class DisappearingClient: TokenomicsHTTPClient, @unchecked Sendable {
    var isAvailable = true

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        guard isAvailable else { throw EndpointError.network("offline") }
        return SyncProbe(state: .succeeded)
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        guard isAvailable else { throw EndpointError.network("offline") }
        return SummaryResponse(
            currentMonth: UsagePeriod(name: "2026-08", through: "2026-08-03", amountUSD: 1),
            daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 1)],
            sync: SyncInfo(state: .succeeded)
        )
    }

    func triggerSync(at endpoint: Endpoint) async throws {}
}

private final class FlakySyncClient: TokenomicsHTTPClient, @unchecked Sendable {
    private var syncRequestCount = 0

    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        if syncRequestCount >= 2 { return SyncProbe(state: .idle) }
        return SyncProbe(state: .succeeded)
    }

    func triggerSync(at endpoint: Endpoint) async throws {
        syncRequestCount += 1
        if syncRequestCount >= 2 { throw EndpointError.network("sync broke") }
    }

    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        SummaryResponse(currentMonth: UsagePeriod(amountUSD: 1), daily: [DailySpendPoint(date: "2026-08-03", amountUSD: 1)])
    }
}

@MainActor
private final class FailingLauncher: TokenomicsLauncher {
    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        throw LauncherError.executableNotFound
    }
}

@MainActor
private final class RecordingLoginItemService: LoginItemServicing {
    var status: LoginItemRegistrationStatus
    private let registrationError: Error?
    private(set) var registerCount = 0
    private(set) var unregisterCount = 0

    init(status: LoginItemRegistrationStatus, registrationError: Error? = nil) {
        self.status = status
        self.registrationError = registrationError
    }

    func register() throws {
        registerCount += 1
        if let registrationError { throw registrationError }
        status = .enabled
    }

    func unregister() throws {
        unregisterCount += 1
        status = .notRegistered
    }
}

private enum LoginItemTestError: LocalizedError {
    case registrationFailed

    var errorDescription: String? { "Registration failed" }
}

private func ISODate(_ value: String) -> Date {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: "\(value)T00:00:00Z")!
}
