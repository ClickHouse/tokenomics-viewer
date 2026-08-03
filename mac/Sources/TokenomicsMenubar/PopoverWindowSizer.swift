import AppKit
import SwiftUI

struct PopoverWindowSizer: NSViewRepresentable {
    let contentSize: CGSize

    func makeNSView(context: Context) -> PopoverWindowResizeView {
        PopoverWindowResizeView()
    }

    func updateNSView(_ nsView: PopoverWindowResizeView, context: Context) {
        nsView.resizeWindow(to: contentSize)
    }

    static func dismantleNSView(_ nsView: PopoverWindowResizeView, coordinator: ()) {
        nsView.cancelPendingResize()
    }
}

@MainActor
final class PopoverWindowResizeView: NSView {
    private var requestedContentSize = CGSize.zero
    private var resizeGeneration = 0
    private weak var resizedWindow: NSWindow?
    private var lastRequestedHeight: CGFloat?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        resizedWindow = nil
        lastRequestedHeight = nil
        scheduleResize()
    }

    func resizeWindow(to contentSize: CGSize) {
        requestedContentSize = contentSize
        scheduleResize()
    }

    func cancelPendingResize() {
        resizeGeneration += 1
        resizedWindow = nil
        lastRequestedHeight = nil
    }

    private func scheduleResize() {
        guard requestedContentSize.width.isFinite,
              requestedContentSize.height.isFinite,
              requestedContentSize.width > 0,
              requestedContentSize.height > 0
        else { return }

        resizeGeneration += 1
        let generation = resizeGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self, generation == self.resizeGeneration else { return }
            self.applyResize()
        }
    }

    private func applyResize() {
        guard let window else { return }
        if resizedWindow !== window {
            resizedWindow = window
            lastRequestedHeight = nil
        }

        let currentFrame = window.frame
        let currentContentRect = window.contentRect(forFrameRect: currentFrame)
        let targetHeight = requestedContentSize.height
        guard abs(currentContentRect.height - targetHeight) > 0.5 else {
            lastRequestedHeight = targetHeight
            return
        }
        guard lastRequestedHeight.map({ abs($0 - targetHeight) > 0.5 }) ?? true else { return }

        let targetContentRect = NSRect(
            origin: .zero,
            size: NSSize(width: currentContentRect.width, height: targetHeight)
        )
        var targetFrame = window.frameRect(forContentRect: targetContentRect)
        targetFrame.origin.x = currentFrame.origin.x
        targetFrame.origin.y = currentFrame.maxY - targetFrame.height
        lastRequestedHeight = targetHeight
        window.setFrame(targetFrame, display: true, animate: window.isVisible)
    }
}
