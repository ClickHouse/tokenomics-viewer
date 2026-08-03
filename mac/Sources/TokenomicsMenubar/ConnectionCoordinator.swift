import AppKit
import Combine
import Foundation

@MainActor
public final class ConnectionCoordinator: ObservableObject {
    @Published public private(set) var state: ConnectionState = .finding
    @Published public private(set) var payload: SummaryResponse?
    @Published public private(set) var lastGoodPayload: SummaryResponse?
    @Published public private(set) var endpoint: Endpoint?
    @Published public private(set) var lastErrorMessage: String?
    @Published public private(set) var launcherOutput: String = ""
    @Published public private(set) var lastRefreshAt: Date?
    @Published public private(set) var isRefreshing = false

    public let preferences: PreferencesStore

    private let client: any TokenomicsHTTPClient
    private let launcher: any TokenomicsLauncher
    private var launcherProcess: (any TokenomicsProcessHandle)?
    private var operationTask: Task<Void, Never>?
    private var automaticTask: Task<Void, Never>?
    private var operationGeneration = 0
    private var automaticStarted = false
    private var syncInFlight = false
    private var observedWake: NSObjectProtocol?
    private var observedTermination: NSObjectProtocol?
    private var preferredPortObservation: AnyCancellable?
    private var observedPreferredPort: Int

    public init(
        preferences: PreferencesStore = PreferencesStore(),
        client: any TokenomicsHTTPClient = URLSessionTokenomicsClient(),
        launcher: any TokenomicsLauncher = DirectTokenomicsLauncher()
    ) {
        self.preferences = preferences
        self.client = client
        self.launcher = launcher
        self.observedPreferredPort = preferences.preferredPort
        observedWake = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in self?.wake() }
        }
        observedTermination = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
        preferredPortObservation = preferences.$preferredPort
            .dropFirst()
            .sink { [weak self] _ in
                // @Published emits from willSet, so wait until the setter has
                // finished before starting a probe that reads PreferencesStore.
                Task { @MainActor [weak self] in
                    self?.preferredPortDidChange()
                }
            }
    }

    public func start() {
        guard !automaticStarted else { return }
        automaticStarted = true
        automaticTask = Task { @MainActor [weak self] in
            await self?.automaticLoop()
        }
        refresh(triggerSync: preferences.automaticSyncEnabled)
    }

    public func stop() {
        operationTask?.cancel()
        automaticTask?.cancel()
        automaticTask = nil
        automaticStarted = false
        launcherProcess?.stop()
        launcherProcess = nil
        if let observedWake {
            NSWorkspace.shared.notificationCenter.removeObserver(observedWake)
            self.observedWake = nil
        }
        if let observedTermination {
            NotificationCenter.default.removeObserver(observedTermination)
            self.observedTermination = nil
        }
    }

    private func preferredPortDidChange() {
        let port = preferences.preferredPort
        guard port != observedPreferredPort else { return }
        observedPreferredPort = port
        guard automaticStarted else { return }

        operationTask?.cancel()
        operationGeneration += 1
        launcherProcess?.stop()
        launcherProcess = nil
        clearConnectionCache()
        lastErrorMessage = nil
        state = .finding
        refresh(triggerSync: preferences.automaticSyncEnabled)
    }

    /// A user-initiated refresh always asks the backend to coalesce a sync,
    /// even when automatic sync is disabled.
    public func refresh(triggerSync: Bool = true) {
        refresh(triggerSync: triggerSync, allowLaunch: false)
    }

    public func startTokenomics() {
        guard canStartTokenomics, !isRefreshing else { return }
        launcherProcess?.stop()
        launcherProcess = nil
        refresh(triggerSync: true, allowLaunch: true)
    }

    public var canStartTokenomics: Bool {
        launcherConfiguration() != nil
    }

    private func refresh(triggerSync: Bool, allowLaunch: Bool) {
        operationTask?.cancel()
        operationGeneration += 1
        let generation = operationGeneration
        operationTask = Task { @MainActor [weak self] in
            await self?.runRefresh(
                generation: generation,
                triggerSync: triggerSync,
                allowLaunch: allowLaunch
            )
        }
    }

    public func retry() {
        if canStartTokenomics {
            startTokenomics()
        } else {
            refresh(triggerSync: true)
        }
    }

    public func wake() {
        guard automaticStarted else { return }
        if preferences.automaticSyncEnabled {
            refresh(triggerSync: true)
        } else {
            refresh(triggerSync: false)
        }
    }

    public var dashboardURL: URL? {
        payload?.dashboardURL ?? endpoint?.url
    }

    private func automaticLoop() async {
        var seenUTCDate = Self.utcDateString(Date())
        while !Task.isCancelled {
            let interval = preferences.normalizedInterval()
            do { try await Task.sleep(for: .seconds(interval)) } catch { return }
            guard !Task.isCancelled else { return }
            let today = Self.utcDateString(Date())
            let rolledOver = today != seenUTCDate
            seenUTCDate = today
            guard preferences.automaticSyncEnabled || rolledOver else { continue }
            if isRefreshing { continue }
            refresh(triggerSync: preferences.automaticSyncEnabled)
        }
    }

    private func runRefresh(generation: Int, triggerSync: Bool, allowLaunch: Bool) async {
        isRefreshing = true
        defer {
            if generation == operationGeneration { isRefreshing = false }
        }
        state = .finding
        do {
            let discovery = try await findOrStartEndpoint(
                generation: generation,
                allowLaunch: allowLaunch
            )
            guard isCurrent(generation) else { return }
            let selected = discovery.endpoint
            endpoint = selected
            preferences.setActiveEndpoint(selected)

            var syncSnapshot: SyncProbe?
            var syncFailureMessage: String?
            if triggerSync && !discovery.launched {
                state = .syncing(lastGood: lastGoodPayload != nil)
                do {
                    syncSnapshot = try await syncAndWait(at: selected, generation: generation)
                } catch {
                    guard isCurrent(generation) else { return }
                    syncFailureMessage = "Sync did not complete: \(Self.message(for: error))"
                    lastErrorMessage = syncFailureMessage
                }
            }

            guard isCurrent(generation) else { return }
            var next = try await client.fetchSummary(at: selected)
            if let syncSnapshot {
                next.sync = SyncInfo(state: syncSnapshot.state, available: syncSnapshot.available, error: syncSnapshot.error)
            } else {
                if let sync = try? await client.probeSync(at: selected) {
                    next.sync = SyncInfo(state: sync.state, available: sync.available, error: sync.error)
                } else if let syncFailureMessage {
                    next.sync = SyncInfo(state: .failed, error: syncFailureMessage)
                }
            }
            if let syncFailureMessage, next.sync.state != .running {
                next.sync = SyncInfo(state: .failed, error: syncFailureMessage)
            }
            guard isCurrent(generation) else { return }
            apply(next)
        } catch is CancellationError {
            return
        } catch let error as LauncherError {
            guard isCurrent(generation) else { return }
            clearConnectionCache()
            launcherOutput = Self.launcherOutput(for: error)
            state = .startFailure(message: error.localizedDescription, output: launcherOutput)
            lastErrorMessage = error.localizedDescription
        } catch let error as EndpointError {
            guard isCurrent(generation) else { return }
            handle(error)
        } catch {
            guard isCurrent(generation) else { return }
            handle(.network(Self.message(for: error)))
        }
    }

    private func findOrStartEndpoint(
        generation: Int,
        allowLaunch: Bool
    ) async throws -> (endpoint: Endpoint, launched: Bool) {
        let ordered = PortDiscovery.orderedEndpoints(preferred: preferences.preferredPort, active: preferences.activeEndpoint)
        guard let candidate = ordered.first else {
            throw EndpointError.network("The configured Tokenomics port is invalid.")
        }

        guard isCurrent(generation) else { throw CancellationError() }
        do {
            _ = try await client.probeSync(at: candidate)
            return (candidate, false)
        } catch EndpointError.notTokenomics {
            throw EndpointError.notTokenomics
        } catch EndpointError.httpStatus {
            throw EndpointError.occupied
        } catch EndpointError.decoding {
            throw EndpointError.notTokenomics
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            guard allowLaunch else {
                throw EndpointError.network("Tokenomics is unavailable on port \(candidate.port).")
            }
        }

        guard let launchConfiguration = launcherConfiguration() else {
            throw EndpointError.network("Tokenomics is unavailable on port \(candidate.port).")
        }

        let port = preferences.preferredPort
        state = .starting(port: port)
        launcherOutput = ""
        do {
            let process: any TokenomicsProcessHandle
            if let configurable = launcher as? any ConfigurableTokenomicsLauncher {
                process = try await configurable.start(
                    executablePath: launchConfiguration.command,
                    port: port,
                    timeout: .seconds(30 * 60),
                    baseArguments: launchConfiguration.args
                )
            } else {
                process = try await launcher.start(
                    executablePath: launchConfiguration.command,
                    port: port,
                    timeout: .seconds(30 * 60)
                )
            }
            guard isCurrent(generation) else {
                process.stop()
                throw CancellationError()
            }
            launcherProcess?.stop()
            launcherProcess = process
            let startupDeadline = Date().addingTimeInterval(30 * 60)
            while Date() < startupDeadline {
                guard isCurrent(generation) else { throw CancellationError() }
                launcherOutput = process.output
                if !process.isRunning {
                    throw LauncherError.exitedBeforeService(1, process.output)
                }
                do {
                    _ = try await client.probeSync(at: candidate)
                    launcherOutput = process.output
                    return (candidate, true)
                } catch EndpointError.notTokenomics, EndpointError.decoding, EndpointError.httpStatus {
                    // Keep waiting while the configured process binds its port.
                } catch is CancellationError {
                    throw CancellationError()
                } catch {
                    // The process may still be binding or syncing.
                }
                try await Task.sleep(for: .milliseconds(500))
            }
            throw LauncherError.startupTimeout(process.output)
        } catch is CancellationError {
            launcherProcess?.stop()
            launcherProcess = nil
            throw CancellationError()
        } catch let error as LauncherError {
            launcherProcess?.stop()
            launcherProcess = nil
            throw error
        } catch {
            launcherProcess?.stop()
            launcherProcess = nil
            throw LauncherError.launchFailed(Self.message(for: error))
        }
    }

    private func launcherConfiguration() -> PersistedLauncherConfiguration? {
        // The CLI's persisted command includes the interpreter/script argument
        // when needed. Prefer it so a launch never loses that argv contract.
        if let persisted = LauncherConfigurationStore.readConfiguration() { return persisted }
        guard RuntimePreferences.validAbsolutePath(preferences.launcherPath),
              !preferences.launcherPath.isEmpty,
              FileManager.default.isExecutableFile(atPath: preferences.launcherPath)
        else { return nil }
        return PersistedLauncherConfiguration(command: preferences.launcherPath)
    }

    private func syncAndWait(at endpoint: Endpoint, generation: Int) async throws -> SyncProbe {
        while syncInFlight {
            guard isCurrent(generation) else { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(100))
        }
        syncInFlight = true
        defer { syncInFlight = false }
        try await client.triggerSync(at: endpoint)
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            guard isCurrent(generation) else { throw CancellationError() }
            let status = try await client.probeSync(at: endpoint)
            switch status.state {
            case .succeeded:
                return status
            case .idle:
                // POST may be accepted just before the backend publishes its
                // running state. Keep polling instead of treating idle as a
                // completed sync and rendering an old report as fresh.
                try await Task.sleep(for: .milliseconds(500))
            case .failed:
                throw EndpointError.network(status.error ?? "The backend sync failed")
            case .running:
                try await Task.sleep(for: .milliseconds(500))
            }
        }
        throw EndpointError.timeout
    }

    private func apply(_ next: SummaryResponse) {
        if next.sync.state == .running, let lastGoodPayload {
            payload = lastGoodPayload
        } else if next.sync.state == .failed, let lastGoodPayload {
            payload = lastGoodPayload
        } else if next.sync.state == .running {
            payload = nil
        } else {
            payload = next
        }
        lastRefreshAt = Date()
        // A settled response is good cache even when its valid totals are all
        // zero. During an in-flight or failed sync, keep the prior cache
        // instead of replacing it with an unconfirmed response.
        if next.sync.state == .idle || next.sync.state == .succeeded { lastGoodPayload = next }
        if next.sync.state == .failed {
            state = .staleRetainingCache
        } else if next.sync.state == .running {
            state = .syncing(lastGood: lastGoodPayload != nil)
        } else {
            state = .connected
            lastErrorMessage = next.sync.error
        }
    }

    private func handle(_ error: EndpointError) {
        clearConnectionCache()
        switch error {
        case .occupied: state = .occupied(endpoint: Endpoint(port: preferences.preferredPort)); lastErrorMessage = "A service is already using the configured port."
        case .notTokenomics: state = .notTokenomics(endpoint: Endpoint(port: preferences.preferredPort)); lastErrorMessage = "A different service is using the configured port."
        default:
            let message = Self.message(for: error)
            state = .unavailable(message: message)
            lastErrorMessage = message
        }
    }

    private func clearConnectionCache() {
        payload = nil
        lastGoodPayload = nil
        endpoint = nil
        preferences.setActiveEndpoint(nil)
        launcherOutput = ""
        lastRefreshAt = nil
    }

    private func isCurrent(_ generation: Int) -> Bool {
        generation == operationGeneration && !Task.isCancelled
    }

    private static func utcDateString(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private static func message(for error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription { return description }
        if let endpoint = error as? EndpointError {
            switch endpoint {
            case .invalidURL: return "The endpoint URL is invalid."
            case .timeout: return "The local service timed out."
            case .occupied: return "The configured port is occupied."
            case .notTokenomics: return "The service on that port is not Tokenomics."
            case .httpStatus(let status): return "The local service returned HTTP \(status)."
            case .decoding(let message): return "The local service returned invalid data: \(message)"
            case .network(let message): return message
            }
        }
        return error.localizedDescription
    }

    private static func launcherOutput(for error: LauncherError) -> String {
        switch error {
        case .exitedBeforeService(_, let output), .startupTimeout(let output): return output
        default: return ""
        }
    }
}
