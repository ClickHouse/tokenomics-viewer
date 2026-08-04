import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

@main
struct TokenomicsMenubar: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var coordinator: ConnectionCoordinator
    @StateObject private var clock: MinuteClock
    private let settingsWindowController: SettingsWindowController

    init() {
        let prefs = PreferencesStore()
        _coordinator = StateObject(wrappedValue: ConnectionCoordinator(preferences: prefs))
        _clock = StateObject(wrappedValue: MinuteClock())
        settingsWindowController = SettingsWindowController(preferences: prefs)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(
                coordinator: coordinator,
                clock: clock,
                settingsWindowController: settingsWindowController
            )
        } label: {
            MenuBarLabelView(coordinator: coordinator, clock: clock)
        }
        .menuBarExtraStyle(.window)
    }
}
