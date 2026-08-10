import Combine
import Foundation
import ServiceManagement

public enum LoginItemRegistrationStatus: Equatable, Sendable {
    case notRegistered
    case enabled
    case requiresApproval
    case unavailable
}

@MainActor
protocol LoginItemServicing: AnyObject {
    var status: LoginItemRegistrationStatus { get }
    func register() throws
    func unregister() throws
}

@MainActor
private final class MainAppLoginItemService: LoginItemServicing {
    private let service = SMAppService.mainApp

    var status: LoginItemRegistrationStatus {
        switch service.status {
        case .notRegistered:
            return .notRegistered
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .unavailable
        @unknown default:
            return .unavailable
        }
    }

    func register() throws {
        try service.register()
    }

    func unregister() throws {
        try service.unregister()
    }
}

@MainActor
public final class LoginItemController: ObservableObject {
    @Published public private(set) var status: LoginItemRegistrationStatus
    @Published public private(set) var lastErrorMessage: String?

    public var isEnabled: Bool { status == .enabled }
    public var canChangeRegistration: Bool {
        status != .requiresApproval && status != .unavailable
    }

    private let service: LoginItemServicing
    private let openSettingsHandler: () -> Void

    public convenience init() {
        self.init(
            service: MainAppLoginItemService(),
            openSettings: { SMAppService.openSystemSettingsLoginItems() }
        )
    }

    init(
        service: LoginItemServicing,
        openSettings: @escaping () -> Void = { SMAppService.openSystemSettingsLoginItems() }
    ) {
        self.service = service
        openSettingsHandler = openSettings
        status = service.status
    }

    public func refresh() {
        status = service.status
        if status == .enabled || status == .notRegistered {
            lastErrorMessage = nil
        }
    }

    public func setEnabled(_ enabled: Bool) {
        lastErrorMessage = nil

        if enabled && status == .requiresApproval {
            openSystemSettings()
            return
        }
        if status == .unavailable {
            lastErrorMessage = "Launch at login is available from the packaged Tokenomics.app."
            return
        }
        if enabled == isEnabled { return }

        do {
            if enabled {
                try service.register()
            } else {
                try service.unregister()
            }
        } catch {
            lastErrorMessage = error.localizedDescription
        }
        status = service.status
    }

    public func openSystemSettings() {
        openSettingsHandler()
    }
}
