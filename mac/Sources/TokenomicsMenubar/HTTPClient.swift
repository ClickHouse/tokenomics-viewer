import Foundation

public struct SyncProbe: Equatable, Sendable {
    public var state: SyncState
    public var available: Bool
    public var error: String?

    public init(state: SyncState, available: Bool = true, error: String? = nil) {
        self.state = state
        self.available = available
        self.error = error
    }
}

public protocol TokenomicsHTTPClient: Sendable {
    func probeSync(at endpoint: Endpoint) async throws -> SyncProbe
    func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse
    func triggerSync(at endpoint: Endpoint) async throws
}

public final class URLSessionTokenomicsClient: TokenomicsHTTPClient, @unchecked Sendable {
    private let session: URLSession
    private let timeout: TimeInterval

    public init(session: URLSession = .shared, timeout: TimeInterval = 2.5) {
        self.session = session
        self.timeout = timeout
    }

    public func probeSync(at endpoint: Endpoint) async throws -> SyncProbe {
        let (data, response) = try await request(path: "/api/sync", endpoint: endpoint, method: "GET")
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 { throw EndpointError.notTokenomics }
            throw EndpointError.httpStatus(response.statusCode)
        }
        do {
            let envelope = try JSONDecoder().decode(SyncEnvelope.self, from: data)
            guard let state = envelope.sync.state else { throw EndpointError.notTokenomics }
            guard let decoded = SyncState.parse(state) else { throw EndpointError.notTokenomics }
            return SyncProbe(state: decoded, available: envelope.sync.available ?? true, error: envelope.sync.error)
        } catch let error as EndpointError {
            throw error
        } catch {
            throw EndpointError.decoding(error.localizedDescription)
        }
    }

    public func fetchSummary(at endpoint: Endpoint) async throws -> SummaryResponse {
        let (data, response) = try await request(path: "/api/summary", endpoint: endpoint, method: "GET")
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 404 { throw EndpointError.notTokenomics }
            throw EndpointError.httpStatus(response.statusCode)
        }
        do {
            return try JSONDecoder().decode(SummaryResponse.self, from: data)
        } catch let error as EndpointError {
            throw error
        } catch {
            throw EndpointError.decoding(error.localizedDescription)
        }
    }

    public func triggerSync(at endpoint: Endpoint) async throws {
        let (_, response) = try await request(
            path: "/api/sync",
            endpoint: endpoint,
            method: "POST",
            headers: ["x-tokenomics-action": "sync"]
        )
        guard (200..<300).contains(response.statusCode) else {
            throw EndpointError.httpStatus(response.statusCode)
        }
    }

    private func request(
        path: String,
        endpoint: Endpoint,
        method: String,
        headers: [String: String] = [:]
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: endpoint.url.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))))
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("no-store", forHTTPHeaderField: "cache-control")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        do {
            let (data, response) = try await session.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else { throw EndpointError.network("The service returned a non-HTTP response") }
            return (data, httpResponse)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as EndpointError {
            throw error
        } catch let error as URLError where error.code == .timedOut {
            throw EndpointError.timeout
        } catch {
            throw EndpointError.network(error.localizedDescription)
        }
    }
}

private struct SyncEnvelope: Decodable {
    let sync: SyncBody
}

private struct SyncBody: Decodable {
    let state: String?
    var available: Bool?
    var error: String?
}
