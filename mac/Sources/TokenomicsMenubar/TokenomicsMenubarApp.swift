import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let activationPolicyHandler: (NSApplication.ActivationPolicy) -> Void

    override init() {
        activationPolicyHandler = { policy in
            _ = NSApp.setActivationPolicy(policy)
        }
        super.init()
    }

    init(activationPolicyHandler: @escaping (NSApplication.ActivationPolicy) -> Void) {
        self.activationPolicyHandler = activationPolicyHandler
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        activationPolicyHandler(.accessory)
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
        let coordinator = ConnectionCoordinator(preferences: prefs)
        _coordinator = StateObject(wrappedValue: coordinator)
        _clock = StateObject(wrappedValue: MinuteClock())
        settingsWindowController = SettingsWindowController(preferences: prefs)

        // A MenuBarExtra label is not guaranteed to enter the SwiftUI view
        // hierarchy before the user opens it. Start from the application
        // lifecycle so the backend is available without that first click.
        coordinator.start()
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
