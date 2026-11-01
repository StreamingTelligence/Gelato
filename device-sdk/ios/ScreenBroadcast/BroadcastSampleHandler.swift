import Foundation
import ReplayKit
import UIKit
import VideoToolbox
import CoreMedia
import os
import CryptoKit

private enum BroadcastSharedConfig {
    static let appGroup = (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    static let controllerUrlKey = "controllerUrl"
    static let deviceIdKey = "deviceId"
    static let agentIdKey = "agentId"
    static let agentTokenKey = "agentToken"
    static let wdaBaseUrlKey = "wdaBaseUrl"
    static let iosBundleIdKey = "iosBundleId"
    static let iosUdidKey = "iosUdid"
    static let logFileName = "mobile-agent-broadcast.log"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    static var controlAllowed: Bool { defaults?.bool(forKey: "controlAllowed") == true }

    static var logFileUrl: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(logFileName)
    }
}

private enum BroadcastTrace {
    static let logger = Logger(subsystem: "dev.galatea.agent", category: "BroadcastUpload")

    static func write(_ message: String) {
        let line = "MobileAgentScreenBroadcast \(message)"
        logger.error("\(line, privacy: .public)")
        NSLog("%@", line)
        guard let fileUrl = BroadcastSharedConfig.logFileUrl else { return }
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        guard let data = entry.data(using: .utf8) else { return }
        if FileManager.default.fileExists(atPath: fileUrl.path),
           let handle = try? FileHandle(forWritingTo: fileUrl) {
            defer { try? handle.close() }
            try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: fileUrl, options: .atomic)
        }
    }
}

@objc(BroadcastSampleHandler)
final class BroadcastSampleHandler: RPBroadcastSampleHandler {
    private let uploader = BroadcastScreenUploader()
    private var accessMonitor: DispatchSourceTimer?
    private let accessLock = NSLock()
    private var finishedForPause = false

    private func requireAccess() -> Bool {
        let stopRequested = BroadcastSharedConfig.defaults?.bool(forKey: "screenBroadcastStopRequested") == true
        guard BroadcastSharedConfig.controlAllowed && !stopRequested else {
            accessLock.lock()
            let shouldFinish = !finishedForPause
            finishedForPause = true
            accessLock.unlock()
            if shouldFinish {
                uploader.stop()
                finishBroadcastWithError(NSError(domain: "DeviceApp", code: stopRequested ? 0 : 403,
                    userInfo: [NSLocalizedDescriptionKey: stopRequested
                        ? "屏幕共享已停止。"
                        : "远程控制已暂停，屏幕共享已停止。配对仍会保留。"] ))
            }
            return false
        }
        return true
    }

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard requireAccess() else { return }
        BroadcastTrace.write("broadcastStarted")
        uploader.start(setupInfo: setupInfo)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in _ = self?.requireAccess() }
        accessMonitor = timer
        timer.resume()
    }

    override func broadcastPaused() {
        BroadcastTrace.write("broadcastPaused")
        uploader.update(active: false, width: 0, height: 0)
    }

    override func broadcastResumed() {
        guard requireAccess() else { return }
        BroadcastTrace.write("broadcastResumed")
        uploader.update(active: true, width: uploader.width, height: uploader.height)
    }

    override func broadcastFinished() {
        accessMonitor?.cancel()
        accessMonitor = nil
        BroadcastTrace.write("broadcastFinished")
        uploader.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard requireAccess() else { return }
        uploader.process(sampleBuffer: sampleBuffer, sampleBufferType: sampleBufferType)
    }
}

final class BroadcastScreenUploader {
    private let encoder = BroadcastH264AnnexBEncoder()
    private let transportQueue = DispatchQueue(label: "agent.broadcast.typed-stream")
    private var socket: URLSessionWebSocketTask?
    private var session = URLSession(configuration: .default)
    private var frameCount = 0
    private(set) var width = 0
    private(set) var height = 0
    private var controllerUrlOverride: String?
    private var deviceIdOverride: String?
    private var agentIdOverride: String?
    private var agentTokenOverride: String?
    private var wdaBaseUrlOverride: String?
    private var targetBundleIdOverride: String?
    private var targetUdidOverride: String?
    private var loggedFirstVideo = false
    private var statusHeartbeat: DispatchSourceTimer?
    private var lastFrameAt = Date.distantPast
    private var streamId = ""
    private var streamReady = false
    private var timingAccepted = false
    private var streamSequence: UInt32 = 0
    private var streamBytes = 0
    private var streamHash = SHA256()
    private var desired = false
    private var reconnectWorkItem: DispatchWorkItem?

    func start(setupInfo: [String: NSObject]?) {
        controllerUrlOverride = nonEmpty(setupInfo?["controllerUrl"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.controllerUrlKey))
        deviceIdOverride = nonEmpty(setupInfo?["deviceId"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.deviceIdKey))
        agentIdOverride = nonEmpty(setupInfo?["agentId"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.agentIdKey))
        agentTokenOverride = nonEmpty(setupInfo?["agentToken"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.agentTokenKey))
        wdaBaseUrlOverride = nonEmpty(setupInfo?["wdaBaseUrl"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.wdaBaseUrlKey))
        targetBundleIdOverride = nonEmpty(setupInfo?["iosBundleId"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.iosBundleIdKey))
        targetUdidOverride = nonEmpty(setupInfo?["iosUdid"] as? String)
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.iosUdidKey))
        lastFrameAt = Date.distantPast
        transportQueue.async { [weak self] in
            guard let self else { return }
            self.desired = true
            self.openStream()
        }
        update(active: false, width: 0, height: 0)
        startStatusHeartbeat()
    }

    func stop() {
        statusHeartbeat?.cancel()
        statusHeartbeat = nil
        update(active: false, width: 0, height: 0)
        encoder.invalidate()
        transportQueue.async { [weak self] in
            guard let self else { return }
            self.desired = false
            self.reconnectWorkItem?.cancel()
            self.reconnectWorkItem = nil
            self.socket?.cancel(with: .normalClosure, reason: nil)
            self.socket = nil
            self.streamReady = false
        }
    }

    func process(sampleBuffer: CMSampleBuffer, sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video,
              CMSampleBufferDataIsReady(sampleBuffer),
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        let nextWidth = CVPixelBufferGetWidth(imageBuffer)
        let nextHeight = CVPixelBufferGetHeight(imageBuffer)
        if !loggedFirstVideo {
            loggedFirstVideo = true
            BroadcastTrace.write("first video sample \(nextWidth)x\(nextHeight)")
        }
        if nextWidth != width || nextHeight != height {
            width = nextWidth
            height = nextHeight
            update(active: true, width: width, height: height)
        }
        encoder.encode(
            sampleBuffer: sampleBuffer,
            imageBuffer: imageBuffer,
            width: nextWidth,
            height: nextHeight,
            onFrame: { [weak self] data, sourceTimeS in
                guard let self else { return }
                self.frameCount += 1
                self.lastFrameAt = Date()
                if self.frameCount == 1 || self.frameCount % 60 == 0 {
                    self.update(active: true, width: self.width, height: self.height)
                }
                self.transportQueue.async { [weak self] in
                    self?.send(data, sourceTimeS: sourceTimeS)
                }
            },
            onError: { [weak self] error in
                BroadcastTrace.write("encoder error \(error)")
                self?.update(active: false, width: 0, height: 0)
            }
        )
    }

    func update(active: Bool, width: Int, height: Int) {
        let defaults = BroadcastSharedConfig.defaults
        defaults?.set(active, forKey: "screenBroadcastActive")
        defaults?.set(width, forKey: "screenBroadcastWidth")
        defaults?.set(height, forKey: "screenBroadcastHeight")
        defaults?.set(active ? Date().timeIntervalSince1970 : 0, forKey: "screenBroadcastLastSeenAt")
    }

    private func startStatusHeartbeat() {
        statusHeartbeat?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let recentlySentFrame = Date().timeIntervalSince(self.lastFrameAt) < 10
            self.update(active: self.width > 0 && self.height > 0 && recentlySentFrame, width: self.width, height: self.height)
        }
        statusHeartbeat = timer
        timer.resume()
    }

    private func send(_ data: Data, sourceTimeS: Double) {
        guard BroadcastSharedConfig.controlAllowed, desired, streamReady, !data.isEmpty,
              data.count <= 2 * 1024 * 1024 else { return }
        if streamBytes + data.count > 120 * 1024 * 1024 {
            finishStream()
            return
        }
        var sequence = streamSequence.bigEndian
        if timingAccepted, let socket {
            sendJson(["type": "stream.frame", "sequence": streamSequence,
                      "sourceTimeS": sourceTimeS.isFinite ? sourceTimeS as Any : NSNull(),
                      "capturedAtS": NSNull()], over: socket)
        }
        var frame = Data(bytes: &sequence, count: 4)
        frame.append(data)
        streamSequence += 1
        streamBytes += data.count
        streamHash.update(data: data)
        let activeSocket = socket
        activeSocket?.send(.data(frame)) { [weak self, weak activeSocket] error in
            guard let self, let activeSocket, let error else { return }
            self.transportQueue.async {
                guard self.socket === activeSocket else { return }
                self.scheduleReconnect("frame send failed: \(error.localizedDescription)")
            }
        }
    }

    private func openStream() {
        guard desired, BroadcastSharedConfig.controlAllowed else { return }
        guard let url = streamUrl(), let token = agentToken(), let agentId = agentId() else {
            BroadcastTrace.write("missing Controller URL or device credential; typed screen stream unavailable")
            update(active: false, width: 0, height: 0)
            return
        }
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        socket?.cancel(with: .goingAway, reason: nil)
        BroadcastTrace.write(
            "connecting typed stream \(url.absoluteString) deviceId=\(deviceId())"
        )
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(agentId, forHTTPHeaderField: "X-Agent-Id")
        request.setValue(deviceId(), forHTTPHeaderField: "X-Device-Id")
        let task = session.webSocketTask(with: request)
        socket = task
        streamId = "str_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        streamReady = false
        timingAccepted = false
        streamSequence = 0
        streamBytes = 0
        streamHash = SHA256()
        task.resume()
        sendJson(envelope(type: "stream.offer", body: [
            "streamId": streamId,
            "purpose": "screen",
            "direction": "agent-to-controller",
            "contentType": "video/h264",
            "maxFrameBytes": 2 * 1024 * 1024,
            "maxTotalBytes": 128 * 1024 * 1024,
            "metadata": ["codec": "h264-annexb", "frameTiming": "source-time.v1"]
        ]), over: task)
        receiveLoop(task)
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self, let task else { return }
            self.transportQueue.async {
                guard self.desired, self.socket === task else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message {
                        self.handle(text: text, from: task)
                }
                    if self.socket === task {
                        self.receiveLoop(task)
                    }
            case .failure(let error):
                    self.scheduleReconnect("receive failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func handle(text: String, from task: URLSessionWebSocketTask) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else {
            return
        }
        if type == "stream.ready" {
            timingAccepted = (message["frameTiming"] as? String) == "source-time.v1"
            streamReady = true
            BroadcastTrace.write("typed screen stream ready \(streamId)")
        } else if type == "stream.complete" {
            streamReady = false
            BroadcastTrace.write("typed screen stream completed \(streamId)")
            guard socket === task else { return }
            socket = nil
            task.cancel(with: .normalClosure, reason: nil)
            scheduleReconnect("rotating completed typed stream", delay: 0.2)
        }
    }

    private func scheduleReconnect(_ reason: String, delay: TimeInterval = 1) {
        guard desired else { return }
        BroadcastTrace.write("typed stream reconnect scheduled: \(reason)")
        streamReady = false
        let previous = socket
        socket = nil
        previous?.cancel(with: .goingAway, reason: nil)
        reconnectWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            self?.openStream()
        }
        reconnectWorkItem = item
        transportQueue.asyncAfter(deadline: .now() + delay, execute: item)
    }

    private func streamUrl() -> URL? {
        let envUrl = controllerUrlOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.controllerUrlKey))
            ?? ProcessInfo.processInfo.environment["MOBILE_AGENT_CONTROLLER_URL"]
        guard var value = envUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        if value.hasPrefix("http://") {
            value = "ws://" + value.dropFirst("http://".count)
        } else if value.hasPrefix("https://") {
            value = "wss://" + value.dropFirst("https://".count)
        } else if !value.hasPrefix("ws://") && !value.hasPrefix("wss://") {
            value = "ws://" + value
        }
        while value.hasSuffix("/") {
            value.removeLast()
        }
        return URL(string: "\(value)/agent/streams/live")
    }

    private func deviceId() -> String {
        if let deviceIdOverride, !deviceIdOverride.isEmpty {
            return deviceIdOverride
        }
        if let shared = nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.deviceIdKey)) {
            return shared
        }
        let vendor = UIDevice.current.identifierForVendor?.uuidString.lowercased() ?? UUID().uuidString.lowercased()
        #if targetEnvironment(simulator)
        return "ios-simulator-\(vendor)"
        #else
        return "ios-device-\(vendor)"
        #endif
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func agentToken() -> String? {
        agentTokenOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.agentTokenKey))
    }

    private func agentId() -> String? {
        agentIdOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.agentIdKey))
    }

    private func finishStream() {
        guard desired, streamReady, let activeSocket = socket else { return }
        streamReady = false
        let digest = streamHash.finalize().map { String(format: "%02x", $0) }.joined()
        sendJson(
            ["type": "stream.end", "totalBytes": streamBytes, "sha256": digest],
            over: activeSocket
        )
    }

    private func envelope(type: String, body: [String: Any]) -> [String: Any] {
        [
            "protocol": "gelato.v1",
            "type": type,
            "messageId": "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
            "deviceId": deviceId(),
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "body": body
        ]
    }

    private func sendJson(
        _ payload: [String: Any],
        over target: URLSessionWebSocketTask? = nil
    ) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        let activeSocket = target ?? socket
        activeSocket?.send(.string(text)) { [weak self, weak activeSocket] error in
            guard let self, let activeSocket, let error else { return }
            self.transportQueue.async {
                guard self.socket === activeSocket else { return }
                self.scheduleReconnect("JSON send failed: \(error.localizedDescription)")
            }
        }
    }

    private func wdaBaseUrl() -> String {
        wdaBaseUrlOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.wdaBaseUrlKey))
            ?? ProcessInfo.processInfo.environment["MOBILE_AGENT_WDA_URL"]
            ?? "http://127.0.0.1:8100"
    }

    private func targetBundleId() -> String {
        targetBundleIdOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.iosBundleIdKey))
            ?? ProcessInfo.processInfo.environment["MOBILE_AGENT_IOS_BUNDLE_ID"]
            ?? "dev.galatea.agent"
    }

    private func targetUdid() -> String? {
        targetUdidOverride
            ?? nonEmpty(BroadcastSharedConfig.defaults?.string(forKey: BroadcastSharedConfig.iosUdidKey))
            ?? ProcessInfo.processInfo.environment["MOBILE_AGENT_IOS_UDID"]
    }
}

final class BroadcastWdaClient {
    private let baseUrl: String
    private let targetBundleId: String
    private let targetUdid: String?
    private var sessionId: String?
    private var createFreshSession = false

    init(baseUrl: String, targetBundleId: String, targetUdid: String?) {
        self.baseUrl = baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.targetBundleId = targetBundleId
        self.targetUdid = targetUdid
    }

    func tap(x: Int, y: Int) async throws {
        _ = try await withValidSession { session in
            try await self.request(method: "POST", path: "/session/\(session)/actions", jsonBody: [
                "actions": [[
                    "type": "pointer",
                    "id": "finger1",
                    "parameters": ["pointerType": "touch"],
                    "actions": [
                        ["type": "pointerMove", "duration": 0, "x": x, "y": y, "origin": "viewport"],
                        ["type": "pointerDown", "button": 0],
                        ["type": "pause", "duration": 100],
                        ["type": "pointerUp", "button": 0]
                    ]
                ]]
            ])
        }
    }

    func swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, durationMs: Int) async throws {
        _ = try await withValidSession { session in
            try await self.request(method: "POST", path: "/session/\(session)/actions", jsonBody: [
                "actions": [[
                    "type": "pointer",
                    "id": "finger1",
                    "parameters": ["pointerType": "touch"],
                    "actions": [
                        ["type": "pointerMove", "duration": 0, "x": fromX, "y": fromY, "origin": "viewport"],
                        ["type": "pointerDown", "button": 0],
                        ["type": "pointerMove", "duration": durationMs, "x": toX, "y": toY, "origin": "viewport"],
                        ["type": "pointerUp", "button": 0]
                    ]
                ]]
            ])
        }
    }

    func typeText(_ text: String) async throws {
        _ = try await withValidSession { session in
            try await self.request(method: "POST", path: "/session/\(session)/wda/keys", jsonBody: [
                "text": text,
                "value": text.map { String($0) }
            ])
        }
    }

    func launchApp(_ bundleId: String) async throws {
        guard !bundleId.isEmpty else { throw BroadcastError.message("bundleId/appId is required") }
        _ = try await withValidSession { session in
            try await self.request(
                method: "POST",
                path: "/session/\(session)/wda/apps/activate",
                jsonBody: ["bundleId": bundleId]
            )
        }
        sessionId = nil
        createFreshSession = true
    }

    func screenshot() async throws -> String {
        let response = try await withValidSession { session in
            try await self.request(method: "GET", path: "/session/\(session)/screenshot", jsonBody: nil)
        }
        if let json = response.jsonObject(),
           let value = json["value"] as? String {
            return value
        }
        if response.contentType.lowercased().contains("image/") {
            return response.body.base64EncodedString()
        }
        throw BroadcastError.message("Screenshot response did not contain image data")
    }

    func source() async throws -> String {
        let response = try await withValidSession { session in
            try await self.request(method: "GET", path: "/session/\(session)/source", jsonBody: nil)
        }
        if let json = response.jsonObject() {
            if let value = json["value"] as? String {
                return value
            }
            let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted])
            return String(data: data, encoding: .utf8) ?? "{}"
        }
        return String(data: response.body, encoding: .utf8) ?? ""
    }

    func request(method: String, path: String, jsonBody: Any?) async throws -> BroadcastWdaResponse {
        guard let url = URL(string: baseUrl + (path.hasPrefix("/") ? path : "/\(path)")) else {
            throw BroadcastError.message("Invalid WDA URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 240
        if let jsonBody {
            guard JSONSerialization.isValidJSONObject(jsonBody) else {
                throw BroadcastError.message("WDA request body is not valid JSON")
            }
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw BroadcastError.message("No HTTP response from WDA")
        }
        if http.statusCode >= 400 {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw BroadcastError.message("WDA HTTP \(http.statusCode): \(text)")
        }
        return BroadcastWdaResponse(status: http.statusCode, headers: http.allHeaderFields, body: data)
    }

    private func withValidSession(_ operation: (String) async throws -> BroadcastWdaResponse) async throws -> BroadcastWdaResponse {
        let session = try await ensureSession()
        do {
            return try await operation(session)
        } catch {
            guard isInvalidSession(error) else { throw error }
            sessionId = nil
            createFreshSession = true
            let freshSession = try await ensureSession()
            return try await operation(freshSession)
        }
    }

    private func ensureSession() async throws -> String {
        if let sessionId {
            return sessionId
        }
        if !createFreshSession {
            if let existingSession = try await existingSessionId() {
                sessionId = existingSession
                return existingSession
            }
        }
        let body: [String: Any] = [
            "capabilities": [
                "alwaysMatch": [String: Any]()
            ]
        ]
        let response = try await request(method: "POST", path: "/session", jsonBody: body)
        guard let json = response.jsonObject() else {
            throw BroadcastError.message("WDA session response was not JSON")
        }
        if let value = json["value"] as? [String: Any],
           let id = value["sessionId"] as? String {
            sessionId = id
            createFreshSession = false
            return id
        }
        if let id = json["sessionId"] as? String {
            sessionId = id
            createFreshSession = false
            return id
        }
        throw BroadcastError.message("WDA did not return a session id")
    }

    private func existingSessionId() async throws -> String? {
        let response = try await request(method: "GET", path: "/status", jsonBody: nil)
        guard let json = response.jsonObject() else {
            return nil
        }
        if let sessionId = json["sessionId"] as? String, !sessionId.isEmpty {
            return sessionId
        }
        if let value = json["value"] as? [String: Any],
           let sessionId = value["sessionId"] as? String,
           !sessionId.isEmpty {
            return sessionId
        }
        return nil
    }

    private func isInvalidSession(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("invalid session id")
            || message.contains("session is either terminated or not started")
            || (message.contains("application under test")
                && message.contains("not running"))
    }
}

struct BroadcastWdaResponse {
    let status: Int
    let headers: [AnyHashable: Any]
    let body: Data

    var contentType: String {
        for (key, value) in headers {
            if String(describing: key).lowercased() == "content-type" {
                return String(describing: value)
            }
        }
        return "application/octet-stream"
    }

    func jsonObject() -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }

    func toCommandResult() -> [String: Any] {
        var normalizedHeaders: [String: String] = [:]
        for (key, value) in headers {
            normalizedHeaders[String(describing: key)] = String(describing: value)
        }
        return [
            "type": "wdaHttpResponse",
            "status": status,
            "headers": normalizedHeaders,
            "bodyBase64": body.base64EncodedString()
        ]
    }
}

final class BroadcastH264AnnexBEncoder {
    private var session: VTCompressionSession?
    private var width = 0
    private var height = 0
    private var frameSink: ((Data, Double) -> Void)?
    private var errorSink: ((String) -> Void)?

    func encode(
        sampleBuffer: CMSampleBuffer,
        imageBuffer: CVImageBuffer,
        width: Int,
        height: Int,
        onFrame: @escaping (Data, Double) -> Void,
        onError: @escaping (String) -> Void
    ) {
        frameSink = onFrame
        errorSink = onError
        do {
            try ensureSession(width: width, height: height)
            guard let session else { return }
            let status = VTCompressionSessionEncodeFrame(
                session,
                imageBuffer: imageBuffer,
                presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
                duration: .invalid,
                frameProperties: nil,
                sourceFrameRefcon: nil,
                infoFlagsOut: nil
            )
            if status != noErr {
                onError("VTCompressionSessionEncodeFrame failed: \(status)")
            }
        } catch {
            onError(error.localizedDescription)
        }
    }

    func invalidate() {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
        session = nil
        width = 0
        height = 0
    }

    private func ensureSession(width: Int, height: Int) throws {
        if session != nil && self.width == width && self.height == height {
            return
        }
        invalidate()
        self.width = width
        self.height = height
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: broadcastH264OutputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &created
        )
        guard status == noErr, let created else {
            throw BroadcastError.message("VTCompressionSessionCreate failed: \(status)")
        }
        session = created
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(created, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 30 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(created)
    }

    fileprivate func handleEncoded(status: OSStatus, sampleBuffer: CMSampleBuffer?) {
        guard status == noErr else {
            errorSink?("H.264 encode callback failed: \(status)")
            return
        }
        guard let sampleBuffer,
              CMSampleBufferDataIsReady(sampleBuffer),
              let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return
        }
        var frame = Data()
        if isKeyFrame(sampleBuffer) {
            appendParameterSets(from: sampleBuffer, to: &frame)
        }
        appendNalUnits(from: blockBuffer, to: &frame)
        if !frame.isEmpty {
            frameSink?(frame, CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds)
        }
    }

    private func isKeyFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
              let first = attachments.first else {
            return true
        }
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    private func appendParameterSets(from sampleBuffer: CMSampleBuffer, to frame: inout Data) {
        guard let format = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        var parameterSetCount = 0
        var nalHeaderLength: Int32 = 0
        for index in 0..<2 {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format,
                parameterSetIndex: index,
                parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size,
                parameterSetCountOut: &parameterSetCount,
                nalUnitHeaderLengthOut: &nalHeaderLength
            )
            guard status == noErr, let pointer, size > 0 else { continue }
            appendStartCode(to: &frame)
            frame.append(pointer, count: size)
        }
    }

    private func appendNalUnits(from blockBuffer: CMBlockBuffer, to frame: inout Data) {
        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == noErr, let dataPointer else { return }
        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, dataPointer.advanced(by: offset), 4)
            nalLength = CFSwapInt32BigToHost(nalLength)
            offset += 4
            let count = Int(nalLength)
            guard count > 0, offset + count <= totalLength else { break }
            appendStartCode(to: &frame)
            let nalPointer = UnsafeRawPointer(dataPointer.advanced(by: offset)).assumingMemoryBound(to: UInt8.self)
            frame.append(nalPointer, count: count)
            offset += count
        }
    }

    private func appendStartCode(to frame: inout Data) {
        frame.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
    }
}

private let broadcastH264OutputCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard let refcon else { return }
    let encoder = Unmanaged<BroadcastH264AnnexBEncoder>.fromOpaque(refcon).takeUnretainedValue()
    encoder.handleEncoded(status: status, sampleBuffer: sampleBuffer)
}

enum BroadcastError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value):
            return value
        }
    }
}

private func broadcastIntValue(_ value: Any?, defaultValue: Int = 0) -> Int {
    if let value = value as? Int { return value }
    if let value = value as? Double { return Int(value) }
    if let value = value as? String { return Int(value) ?? defaultValue }
    return defaultValue
}
