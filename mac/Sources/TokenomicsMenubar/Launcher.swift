import Darwin
import Foundation

public enum LauncherConfigurationSchema {
    public static let current = 1
}

public enum LauncherError: Error, Equatable, Sendable, LocalizedError {
    case pathMustBeAbsolute
    case executableNotFound
    case launchFailed(String)
    case exitedBeforeService(Int32, String)
    case startupTimeout(String)

    public var errorDescription: String? {
        switch self {
        case .pathMustBeAbsolute: return "The launcher path must be absolute."
        case .executableNotFound: return "The configured tokenomics launcher was not found or is not executable."
        case .launchFailed(let message): return "Could not start tokenomics: \(message)"
        case .exitedBeforeService(let status, let output): return "Tokenomics exited before its service was found (status \(status)).\(output.isEmpty ? "" : " Output: \(output)")"
        case .startupTimeout(let output): return "Tokenomics did not expose its service before the startup timeout.\(output.isEmpty ? "" : " Output: \(output)")"
        }
    }
}

@MainActor
public protocol TokenomicsProcessHandle: AnyObject {
    var output: String { get }
    var isRunning: Bool { get }
    func stop()
}

@MainActor
public protocol TokenomicsLauncher {
    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle
}

/// A launcher that came from the CLI's persisted command record can retain
/// the command's base arguments (for example `node /path/launcher.js`).
@MainActor
public protocol ConfigurableTokenomicsLauncher: TokenomicsLauncher {
    func start(executablePath: String, port: Int, timeout: Duration, baseArguments: [String]) async throws -> any TokenomicsProcessHandle
}

@MainActor
public extension ConfigurableTokenomicsLauncher {
    func start(executablePath: String, port: Int, timeout: Duration) async throws -> any TokenomicsProcessHandle {
        try await start(executablePath: executablePath, port: port, timeout: timeout, baseArguments: [])
    }
}

@MainActor
public final class DirectTokenomicsLauncher: ConfigurableTokenomicsLauncher {
    public init() {}

    public func start(
        executablePath: String,
        port: Int,
        timeout: Duration = .seconds(30 * 60)
    ) async throws -> any TokenomicsProcessHandle {
        try await start(executablePath: executablePath, port: port, timeout: timeout, baseArguments: [])
    }

    public func start(
        executablePath: String,
        port: Int,
        timeout: Duration = .seconds(30 * 60),
        baseArguments: [String]
    ) async throws -> any TokenomicsProcessHandle {
        guard executablePath.hasPrefix("/") else { throw LauncherError.pathMustBeAbsolute }
        guard FileManager.default.isExecutableFile(atPath: executablePath) else { throw LauncherError.executableNotFound }

        let outputPipe = Pipe()
        let outputBuffer = OutputBuffer()
        let arguments = baseArguments + ["--no-open", "--port", String(port)]
        let processIdentifier = try spawn(
            executablePath: executablePath,
            arguments: arguments,
            outputPipe: outputPipe
        )
        outputPipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if !data.isEmpty { outputBuffer.append(data) }
        }

        // The coordinator owns the startup wait and probes the configured
        // localhost port after launch.
        _ = timeout
        do {
            try Task.checkCancellation()
        } catch {
            terminateAndReapProcessGroup(processIdentifier)
            closeOutput(outputPipe)
            throw CancellationError()
        }
        return RunningTokenomicsProcess(
            processIdentifier: processIdentifier,
            output: outputBuffer,
            pipe: outputPipe
        )
    }

    private func spawn(executablePath: String, arguments: [String], outputPipe: Pipe) throws -> pid_t {
        var fileActions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        let readDescriptor = outputPipe.fileHandleForReading.fileDescriptor
        let writeDescriptor = outputPipe.fileHandleForWriting.fileDescriptor

        guard posix_spawn_file_actions_init(&fileActions) == 0,
              posix_spawn_file_actions_adddup2(&fileActions, writeDescriptor, STDOUT_FILENO) == 0,
              posix_spawn_file_actions_adddup2(&fileActions, writeDescriptor, STDERR_FILENO) == 0,
              posix_spawn_file_actions_addclose(&fileActions, readDescriptor) == 0,
              posix_spawn_file_actions_addclose(&fileActions, writeDescriptor) == 0,
              posix_spawnattr_init(&attributes) == 0,
              posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0
        else {
            closeOutput(outputPipe)
            throw LauncherError.launchFailed("Could not prepare the launcher process.")
        }
        defer {
            posix_spawn_file_actions_destroy(&fileActions)
            posix_spawnattr_destroy(&attributes)
        }

        let strings = ([executablePath] + arguments).map { strdup($0) }
        defer { strings.forEach { free($0) } }
        var argv = strings + [nil]
        var processIdentifier: pid_t = 0
        let result = executablePath.withCString { path in
            argv.withUnsafeMutableBufferPointer { buffer in
                posix_spawn(
                    &processIdentifier,
                    path,
                    &fileActions,
                    &attributes,
                    buffer.baseAddress!,
                    environ
                )
            }
        }
        outputPipe.fileHandleForWriting.closeFile()
        guard result == 0 else {
            closeOutput(outputPipe)
            throw LauncherError.launchFailed(String(cString: strerror(result)))
        }
        return processIdentifier
    }

    private func closeOutput(_ pipe: Pipe) {
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close()
        try? pipe.fileHandleForWriting.close()
    }
}

@MainActor
private final class RunningTokenomicsProcess: TokenomicsProcessHandle {
    private let processIdentifier: pid_t
    private let outputBuffer: OutputBuffer
    private let pipe: Pipe
    private var stopped = false

    init(processIdentifier: pid_t, output: OutputBuffer, pipe: Pipe) {
        self.processIdentifier = processIdentifier
        self.outputBuffer = output
        self.pipe = pipe
    }

    var output: String { outputBuffer.value }
    var isRunning: Bool {
        guard !stopped else { return false }
        var status: Int32 = 0
        let result = waitpid(processIdentifier, &status, WNOHANG)
        if result == 0 { return true }
        if processIdentifier > 1 { _ = kill(-processIdentifier, SIGTERM) }
        stopped = true
        closeOutput()
        return false
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        terminateAndReapProcessGroup(processIdentifier)
        closeOutput()
    }

    deinit {
        if !stopped { terminateAndReapProcessGroup(processIdentifier) }
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close()
    }

    private func closeOutput() {
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close()
    }
}

private func terminateAndReapProcessGroup(_ processIdentifier: pid_t) {
    guard processIdentifier > 1 else { return }
    _ = kill(-processIdentifier, SIGTERM)
    DispatchQueue.global(qos: .utility).async {
        var status: Int32 = 0
        while waitpid(processIdentifier, &status, 0) == -1, errno == EINTR {}
    }
}

private final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private let maximumBytes = 32 * 1024

    var value: String {
        lock.lock(); defer { lock.unlock() }
        return String(decoding: data, as: UTF8.self)
    }

    func append(_ next: Data) {
        guard !next.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        data.append(next)
        if data.count > maximumBytes {
            data.removeFirst(data.count - maximumBytes)
        }
    }
}

public struct PersistedLauncherConfiguration: Codable, Equatable, Sendable {
    public var schema: Int
    public var command: String
    public var args: [String]

    public init(schema: Int = LauncherConfigurationSchema.current, command: String, args: [String] = []) {
        self.schema = schema
        self.command = command
        self.args = args
    }
}

public enum LauncherConfigurationStore {
    public static var defaultURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent("Library/Application Support/Tokenomics Viewer", isDirectory: true)
            .appendingPathComponent("tokenomics-launch.json")
    }

    public static func readConfiguration(from url: URL = defaultURL) -> PersistedLauncherConfiguration? {
        guard let data = try? Data(contentsOf: url),
              let configuration = try? JSONDecoder().decode(PersistedLauncherConfiguration.self, from: data),
              configuration.schema == LauncherConfigurationSchema.current,
              configuration.command.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: configuration.command)
        else { return nil }
        return configuration
    }

    public static func read(from url: URL = defaultURL) -> String? {
        readConfiguration(from: url)?.command
    }

    /// Resolve the backend launcher without requiring a separate menu-bar
    /// preference. Installed applications use the stable wrapper under
    /// ~/.local/bin; `swift run` uses the launcher from the source checkout.
    public static func resolveConfiguration(
        fallbackPath: String,
        persistedURL: URL = defaultURL,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        executableURL: URL? = Bundle.main.executableURL
    ) -> PersistedLauncherConfiguration? {
        if let persisted = readConfiguration(from: persistedURL) { return persisted }
        if let fallback = executableConfiguration(atPath: fallbackPath) { return fallback }
        if let development = developmentConfiguration(executableURL: executableURL) { return development }
        return executableConfiguration(
            atPath: homeDirectory
                .appendingPathComponent(".local/bin/tokenomics-launch")
                .path
        )
    }

    private static func developmentConfiguration(executableURL: URL?) -> PersistedLauncherConfiguration? {
        guard let executableURL else { return nil }
        var directory = executableURL.deletingLastPathComponent().standardizedFileURL
        let fileManager = FileManager.default

        // A SwiftPM executable lives below mac/.build. Walk only its ancestor
        // chain and require the repository shape before trusting launcher.js.
        for _ in 0..<12 {
            let launcher = directory.appendingPathComponent("launcher.js")
            let app = directory.appendingPathComponent("app.js")
            let package = directory.appendingPathComponent("mac/Package.swift")
            if fileManager.fileExists(atPath: app.path),
               fileManager.fileExists(atPath: package.path),
               let configuration = executableConfiguration(atPath: launcher.path)
            {
                return configuration
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        return nil
    }

    private static func executableConfiguration(atPath path: String) -> PersistedLauncherConfiguration? {
        guard RuntimePreferences.validAbsolutePath(path),
              !path.isEmpty,
              FileManager.default.isExecutableFile(atPath: path)
        else { return nil }
        return PersistedLauncherConfiguration(command: path)
    }
}
