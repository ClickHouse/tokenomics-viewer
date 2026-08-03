import AppKit
import SwiftUI

@MainActor
public final class SettingsWindowController: NSWindowController {
    public init(preferences: PreferencesStore) {
        let contentSize = NSSize(width: 460, height: 440)
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: contentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        let hostingController = NSHostingController(
            rootView: SettingsView(preferences: preferences) { [weak window] in
                window?.close()
            }
        )
        window.title = "Settings"
        window.contentViewController = hostingController
        window.setContentSize(contentSize)
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    public func present(dismissing transientWindow: NSWindow?) {
        transientWindow?.orderOut(nil)
        DispatchQueue.main.async { [weak self] in
            guard let window = self?.window else { return }
            NSApp.activate(ignoringOtherApps: true)
            window.deminiaturize(nil)
            window.makeKeyAndOrderFront(nil)
        }
    }
}
