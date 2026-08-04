import Combine
import Foundation

/// A single refresh source shared by the status item and its popover.
/// `TimelineView` inside a `MenuBarExtra` label causes continuous status-item rendering on macOS.
@MainActor
public final class MinuteClock: ObservableObject {
    @Published public private(set) var now: Date

    private var cancellable: AnyCancellable?

    public convenience init(now: Date = .now) {
        let updates = Timer.publish(every: 60, tolerance: 1, on: .main, in: .common)
            .autoconnect()
            .eraseToAnyPublisher()
        self.init(now: now, updates: updates)
    }

    init(now: Date, updates: AnyPublisher<Date, Never>) {
        self.now = now
        cancellable = updates.sink { [weak self] date in
            self?.now = date
        }
    }
}
