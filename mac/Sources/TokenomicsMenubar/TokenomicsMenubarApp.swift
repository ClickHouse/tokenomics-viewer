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
    private let settingsWindowController: SettingsWindowController

    init() {
        let prefs = PreferencesStore()
        _coordinator = StateObject(wrappedValue: ConnectionCoordinator(preferences: prefs))
        settingsWindowController = SettingsWindowController(preferences: prefs)
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(
                coordinator: coordinator,
                settingsWindowController: settingsWindowController
            )
        } label: {
            MenuBarLabelView(coordinator: coordinator)
        }
        .menuBarExtraStyle(.window)
    }
}
