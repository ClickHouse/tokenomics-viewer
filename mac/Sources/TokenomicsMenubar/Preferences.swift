import Foundation
import Combine

public struct RuntimePreferences: Equatable, Sendable {
    public static let defaultPort = 8787
    public static let defaultAutomaticSyncInterval: TimeInterval = 20
    public static let minimumAutomaticSyncInterval: TimeInterval = 5
    public static let maximumAutomaticSyncInterval: TimeInterval = 3_600

    public var preferredPort: Int
    public var activeEndpoint: Endpoint?
    public var launcherPath: String?
    public var automaticSyncEnabled: Bool
    public var automaticSyncInterval: TimeInterval

    public init(
        preferredPort: Int = RuntimePreferences.defaultPort,
        activeEndpoint: Endpoint? = nil,
        launcherPath: String? = nil,
        automaticSyncEnabled: Bool = true,
        automaticSyncInterval: TimeInterval = RuntimePreferences.defaultAutomaticSyncInterval
    ) {
        self.preferredPort = Self.validPort(preferredPort) ? preferredPort : Self.defaultPort
        self.activeEndpoint = activeEndpoint
        self.launcherPath = Self.validAbsolutePath(launcherPath) ? launcherPath : nil
        self.automaticSyncEnabled = automaticSyncEnabled
        self.automaticSyncInterval = Self.validInterval(automaticSyncInterval) ? automaticSyncInterval : Self.defaultAutomaticSyncInterval
    }

    public init(defaults: UserDefaults) {
        let storedPort = defaults.object(forKey: Keys.preferredPort) as? Int ?? Self.defaultPort
        let active = (defaults.string(forKey: Keys.activeEndpoint)).flatMap(Self.endpoint(from:))
        let launcher = defaults.string(forKey: Keys.launcherPath)
        let enabled = defaults.object(forKey: Keys.automaticSyncEnabled) as? Bool ?? true
        let interval = defaults.object(forKey: Keys.automaticSyncInterval) as? Double ?? Self.defaultAutomaticSyncInterval
        self.init(
            preferredPort: storedPort,
            activeEndpoint: active,
            launcherPath: launcher,
            automaticSyncEnabled: enabled,
            automaticSyncInterval: interval
        )
    }

    public func save(to defaults: UserDefaults) {
        defaults.set(preferredPort, forKey: Keys.preferredPort)
        if let activeEndpoint {
            defaults.set(activeEndpoint.description, forKey: Keys.activeEndpoint)
        } else {
            defaults.removeObject(forKey: Keys.activeEndpoint)
        }
        if let launcherPath {
            defaults.set(launcherPath, forKey: Keys.launcherPath)
        } else {
            defaults.removeObject(forKey: Keys.launcherPath)
        }
        defaults.set(automaticSyncEnabled, forKey: Keys.automaticSyncEnabled)
        defaults.set(automaticSyncInterval, forKey: Keys.automaticSyncInterval)
    }

    public static func validPort(_ port: Int) -> Bool { (1...65_535).contains(port) }

    public static func validInterval(_ interval: TimeInterval) -> Bool {
        interval.isFinite && interval >= minimumAutomaticSyncInterval && interval <= maximumAutomaticSyncInterval
    }

    public static func validAbsolutePath(_ path: String?) -> Bool {
        guard let path, !path.isEmpty else { return false }
        return path.hasPrefix("/")
    }

    private static func endpoint(from raw: String) -> Endpoint? {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http", let host = url.host,
              host == "127.0.0.1" || host == "localhost" || host == "::1",
              let port = url.port, validPort(port)
        else { return nil }
        return Endpoint(port: port, host: host)
    }

    private enum Keys {
        static let preferredPort = "tokenomics.preferredPort"
        static let activeEndpoint = "tokenomics.activeEndpoint"
        static let launcherPath = "tokenomics.launcherPath"
        static let automaticSyncEnabled = "tokenomics.automaticSyncEnabled"
        static let automaticSyncInterval = "tokenomics.automaticSyncInterval"
    }
}

@MainActor
public final class PreferencesStore: ObservableObject {
    @Published public var preferredPort: Int {
        didSet {
            if !RuntimePreferences.validPort(preferredPort) {
                preferredPort = RuntimePreferences.defaultPort
                return
            }
            if oldValue != preferredPort {
                activeEndpoint = nil
            }
            persist()
        }
    }
    @Published public var launcherPath: String {
        didSet {
            if !launcherPath.isEmpty && !RuntimePreferences.validAbsolutePath(launcherPath) {
                launcherPath = ""
                return
            }
            persist()
        }
    }
    @Published public var automaticSyncEnabled: Bool { didSet { persist() } }
    @Published public var automaticSyncInterval: Double {
        didSet {
            if !RuntimePreferences.validInterval(automaticSyncInterval) {
                automaticSyncInterval = RuntimePreferences.defaultAutomaticSyncInterval
                return
            }
            persist()
        }
    }

    public private(set) var activeEndpoint: Endpoint? {
        didSet { persist() }
    }

    private let defaults: UserDefaults
    private var isLoading = true

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let values = RuntimePreferences(defaults: defaults)
        preferredPort = values.preferredPort
        launcherPath = values.launcherPath ?? ""
        automaticSyncEnabled = values.automaticSyncEnabled
        automaticSyncInterval = values.automaticSyncInterval
        activeEndpoint = values.activeEndpoint
        isLoading = false
    }

    public func setActiveEndpoint(_ endpoint: Endpoint?) {
        activeEndpoint = endpoint
    }

    public func normalizedInterval() -> TimeInterval {
        RuntimePreferences.validInterval(automaticSyncInterval)
            ? automaticSyncInterval
            : RuntimePreferences.defaultAutomaticSyncInterval
    }

    public func applyPortText(_ text: String) {
        guard let port = Int(text), RuntimePreferences.validPort(port) else { return }
        preferredPort = port
    }

    public func applyLauncherPath(_ text: String) {
        launcherPath = RuntimePreferences.validAbsolutePath(text) ? text : ""
    }

    private func persist() {
        guard !isLoading else { return }
        let values = RuntimePreferences(
            preferredPort: preferredPort,
            activeEndpoint: activeEndpoint,
            launcherPath: launcherPath.isEmpty ? nil : launcherPath,
            automaticSyncEnabled: automaticSyncEnabled,
            automaticSyncInterval: normalizedInterval()
        )
        values.save(to: defaults)
    }
}

public enum PortDiscovery {
    public static func orderedPorts(preferred: Int, active: Endpoint?) -> [Int] {
        // The port is part of the user's service configuration. Probing a
        // neighbouring port can attach the menu bar to an unrelated service,
        // so discovery is intentionally limited to that exact port.
        guard RuntimePreferences.validPort(preferred) else { return [] }
        return [preferred]
    }

    public static func orderedEndpoints(preferred: Int, active: Endpoint?) -> [Endpoint] {
        guard RuntimePreferences.validPort(preferred) else { return [] }
        if let active, active.port == preferred {
            return [active]
        }
        return [Endpoint(port: preferred)]
    }
}
