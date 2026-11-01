import SwiftUI
import UIKit
import ScreenCaptureKit
import CoreImage
import ImageIO
import Network
import NetworkExtension
import Security
import CryptoKit
@preconcurrency import UserNotifications
import os

private enum AgentSharedConfig {
    static let appGroup = (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    static let controllerUrlKey = "controllerUrl"
    static let deviceIdKey = "deviceId"
    static let displayNameKey = "displayName"
    static let pairingCodeKey = "pairingCode"
    static let agentIdKey = "agentId"
    static let agentTokenKey = "agentToken"
    static let installationIdKey = "installationId"
    static let wdaBaseUrlKey = "wdaBaseUrl"
    static let iosBundleIdKey = "iosBundleId"
    static let iosUdidKey = "iosUdid"
    static let requiredUpdateBuildKey = "requiredUpdateBuild"
    static let updateManifestUrlKey = "updateManifestUrl"
    static let vpnAutostartKey = "vpnAutostart"
    static let connectionEnabledKey = "connectionEnabled"
    static let runningPacketTunnelBuildKey = "runningPacketTunnelBuild"
    static let stagedWdaPackageName = "GalateaWDA-PureLinux.ipa"
    static let pendingWdaPackageSha256Key = "pendingWdaPackageSha256"
    static let systemPairingPinNotificationIdKey = "systemPairingPinNotificationId"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }
}

@available(iOS 27.0, *)
// Picker/stream ownership is on MainActor; capture callbacks use captureQueue;
// all socket state is confined to transportQueue.
final class LiveScreenCapture: NSObject, SCContentSharingPickerObserver, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    static let shared = LiveScreenCapture()

    private let captureQueue = DispatchQueue(label: "gelato.screen.capture")
    private let transportQueue = DispatchQueue(label: "gelato.screen.transport")
    private let context = CIContext()
    private var stream: SCStream?
    private var socket: URLSessionWebSocketTask?
    private var desired = false
    private var ready = false
    private var sending = false
    private var streamId = ""
    private var sequence: UInt32 = 0
    private var byteCount = 0
    private var digestState = SHA256()
    private var lastSampleAt = Date.distantPast
    private var lastPreviewJpeg: Data?
    private var captureGeneration: UInt64 = 0
    private var captureActive = false
    private var lastOrientationProbeAt = Date.distantPast
    private var orientationProbePending = false
    private var foregroundOrientation = "PORTRAIT"
    private var observerAdded = false
    private weak var runtime: AgentRuntime?

    @MainActor
    func start(runtime: AgentRuntime) {
        guard runtime.deviceControlAllowed else { return }
        self.runtime = runtime
        runtime.persistSharedConfig()
        let picker = SCContentSharingPicker.shared
        guard picker.isAvailable else {
            runtime.lastError = "System screen sharing is unavailable"
            return
        }
        if !observerAdded {
            picker.add(self)
            observerAdded = true
        }
        picker.isActive = true
        transportQueue.async { self.desired = true }
        runtime.log("Opening system screen-sharing picker")
        picker.present()
    }

    @MainActor
    func stop(runtime: AgentRuntime) {
        self.runtime = runtime
        SCContentSharingPicker.shared.isActive = false
        AgentSharedConfig.defaults?.set(false, forKey: "screenBroadcastActive")
        AgentSharedConfig.defaults?.set(true, forKey: "screenBroadcastStopRequested")
        let old = stream
        stream = nil
        Task { try? await old?.stopCapture() }
        captureQueue.async {
            self.captureGeneration &+= 1
            self.captureActive = false
            self.lastPreviewJpeg = nil
        }
        transportQueue.async {
            self.desired = false
            self.ready = false
            if let task = self.socket {
                let digest = self.digestState.finalize().map { String(format: "%02x", $0) }.joined()
                self.sendJson(["type": "stream.end", "totalBytes": self.byteCount, "sha256": digest], over: task)
                self.transportQueue.asyncAfter(deadline: .now() + 2) {
                    task.cancel(with: .normalClosure, reason: nil)
                }
            }
            self.socket = nil
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) {
        Task { @MainActor in
            picker.isActive = false
            self.runtime?.log("Screen sharing cancelled")
        }
    }

    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in
            do {
                if let old = self.stream { try? await old.stopCapture() }
                self.captureQueue.async {
                    self.captureGeneration &+= 1
                    let generation = self.captureGeneration
                    self.captureActive = true
                    self.lastSampleAt = .distantPast
                    self.lastPreviewJpeg = nil
                    self.repeatStillFrame(generation: generation)
                }
                let config = SCStreamConfiguration()
                let next = SCStream(filter: filter, configuration: config, delegate: self)
                try next.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.captureQueue)
                try await next.startCapture()
                self.stream = next
                AgentSharedConfig.defaults?.set(false, forKey: "screenBroadcastStopRequested")
                self.runtime?.log("ScreenCaptureKit stream started")
                self.transportQueue.async { self.openSocket() }
            } catch {
                self.captureQueue.async {
                    self.captureGeneration &+= 1
                    self.captureActive = false
                    self.lastPreviewJpeg = nil
                }
                self.runtime?.lastError = error.localizedDescription
                self.runtime?.log("Screen capture start failed: \(error.localizedDescription)")
            }
        }
    }

    func contentSharingPickerStartDidFailWithError(_ error: Error) {
        Task { @MainActor in
            SCContentSharingPicker.shared.isActive = false
            self.runtime?.lastError = error.localizedDescription
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        captureQueue.async {
            self.captureGeneration &+= 1
            self.captureActive = false
            self.lastPreviewJpeg = nil
        }
        Task { @MainActor in
            SCContentSharingPicker.shared.isActive = false
            AgentSharedConfig.defaults?.set(false, forKey: "screenBroadcastActive")
            self.runtime?.lastError = error.localizedDescription
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, captureActive, CMSampleBufferDataIsReady(sampleBuffer),
              AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true,
              AgentSharedConfig.defaults?.bool(forKey: "screenBroadcastStopRequested") != true,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let now = Date()
        guard now.timeIntervalSince(lastSampleAt) >= 1.0 else { return }
        if !orientationProbePending && now.timeIntervalSince(lastOrientationProbeAt) >= 2.0 {
            orientationProbePending = true
            lastOrientationProbeAt = now
            Task { @MainActor in
                let orientation = try? await self.runtime?.screenOrientation()
                self.captureQueue.async {
                    self.orientationProbePending = false
                    if let orientation { self.foregroundOrientation = orientation }
                }
            }
        }
        let source = CIImage(cvPixelBuffer: pixels)
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false)
            as? [[SCStreamFrameInfo: Any]]
        if let rawStatus = attachments?.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: rawStatus),
           status != .complete && status != .started && status != .idle { return }
        let orientation = (attachments?.first?[.videoOrientation] as? NSNumber)
            .flatMap { CGImagePropertyOrientation(rawValue: $0.uint32Value) }
        // iOS 27 beta may omit the orientation attachment while still delivering
        // portrait-shaped buffers for a landscape foreground app. WDA reports
        // that app's orientation through the already-paired wireless channel.
        let effectiveOrientation: CGImagePropertyOrientation =
            (orientation == nil || orientation == .up)
            && foregroundOrientation == "LANDSCAPE"
            && source.extent.height > source.extent.width
            ? .left : (orientation ?? .up)
        let image = source.oriented(effectiveOrientation)
        let scale = min(1, 960 / max(image.extent.width, image.extent.height))
        let preview = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let compression = CIImageRepresentationOption(
            rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = context.jpegRepresentation(of: preview,
            colorSpace: CGColorSpaceCreateDeviceRGB(), options: [compression: 0.35]),
            jpeg.count <= 2 * 1024 * 1024 else { return }
        lastSampleAt = now
        lastPreviewJpeg = jpeg
        transportQueue.async { self.sendFrame(jpeg) }
    }

    private func repeatStillFrame(generation: UInt64) {
        captureQueue.asyncAfter(deadline: .now() + 1) {
            guard self.captureActive, self.captureGeneration == generation else { return }
            let now = Date()
            if now.timeIntervalSince(self.lastSampleAt) >= 1,
               let jpeg = self.lastPreviewJpeg,
               AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true {
                self.lastSampleAt = now
                self.transportQueue.async { self.sendFrame(jpeg) }
            }
            self.repeatStillFrame(generation: generation)
        }
    }

    private func openSocket() {
        guard desired, socket == nil,
              let defaults = AgentSharedConfig.defaults,
              let controller = defaults.string(forKey: AgentSharedConfig.controllerUrlKey),
              let deviceId = defaults.string(forKey: AgentSharedConfig.deviceIdKey),
              let agentId = defaults.string(forKey: AgentSharedConfig.agentIdKey),
              let token = defaults.string(forKey: AgentSharedConfig.agentTokenKey),
              var url = URL(string: controller),
              let scheme = url.scheme else { return }
        url = url.appending(path: "agent/streams/live")
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.scheme = scheme == "https" ? "wss" : "ws"
        guard let streamUrl = parts?.url else { return }
        var request = URLRequest(url: streamUrl)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(agentId, forHTTPHeaderField: "X-Agent-Id")
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-Id")
        let next = URLSession.shared.webSocketTask(with: request)
        socket = next
        ready = false
        sending = false
        streamId = "str_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        sequence = 0
        byteCount = 0
        digestState = SHA256()
        next.resume()
        sendJson(["protocol": "gelato.v1", "type": "stream.offer",
                  "messageId": "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
                  "deviceId": deviceId,
                  "sentAt": ISO8601DateFormatter().string(from: Date()),
                  "body": ["streamId": streamId, "purpose": "screen",
                           "direction": "agent-to-controller", "contentType": "image/jpeg",
                           "maxFrameBytes": 2 * 1024 * 1024, "maxTotalBytes": 128 * 1024 * 1024,
                           "metadata": ["observationFraming": "image-per-message.v1",
                                        "transient": true]]], over: next)
        receive(on: next)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { result in
            self.transportQueue.async {
                guard self.socket === task else { return }
                switch result {
                case .failure:
                    self.reconnect(task)
                case .success(let message):
                    if case .string(let text) = message,
                       let data = text.data(using: .utf8),
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       let type = json["type"] as? String {
                        if type == "stream.ready" { self.ready = true }
                        if type == "stream.complete" { self.reconnect(task) }
                    }
                    if self.socket === task { self.receive(on: task) }
                }
            }
        }
    }

    private func sendFrame(_ jpeg: Data) {
        guard desired, ready, !sending, let task = socket,
              AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true else { return }
        if byteCount + jpeg.count > 100 * 1024 * 1024 {
            ready = false
            let digest = digestState.finalize().map { String(format: "%02x", $0) }.joined()
            sendJson(["type": "stream.end", "totalBytes": byteCount, "sha256": digest], over: task)
            return
        }
        var number = sequence.bigEndian
        var packet = Data(bytes: &number, count: 4)
        packet.append(jpeg)
        sequence += 1
        byteCount += jpeg.count
        digestState.update(data: jpeg)
        sending = true
        task.send(.data(packet)) { error in
            self.transportQueue.async {
                guard self.socket === task else { return }
                if error != nil { self.reconnect(task); return }
                // The send callback can fire before the peer has consumed a frame.
                // Wait for a pong behind that frame so slow uplinks cannot build a
                // minutes-long queue of stale screenshots.
                task.sendPing { pingError in
                    self.transportQueue.async {
                        guard self.socket === task else { return }
                        if pingError != nil { self.reconnect(task); return }
                        self.sending = false
                        AgentSharedConfig.defaults?.set(true, forKey: "screenBroadcastActive")
                        AgentSharedConfig.defaults?.set(Date().timeIntervalSince1970,
                            forKey: "screenBroadcastLastSeenAt")
                    }
                }
                self.transportQueue.asyncAfter(deadline: .now() + 5) {
                    if self.socket === task && self.sending { self.reconnect(task) }
                }
            }
        }
    }

    private func sendJson(_ payload: [String: Any], over task: URLSessionWebSocketTask) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { error in
            if error != nil { self.transportQueue.async { self.reconnect(task) } }
        }
    }

    private func reconnect(_ task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        socket = nil
        ready = false
        sending = false
        task.cancel(with: .goingAway, reason: nil)
        if desired { transportQueue.asyncAfter(deadline: .now() + 2) { self.openSocket() } }
    }
}

private enum AgentCredentialStore {
    private static let service =
        (Bundle.main.object(forInfoDictionaryKey: "GalateaCredentialService") as? String ?? "dev.galatea.agent.credentials")
    static let controllerUrlAccount = "controllerUrl"
    static let deviceIdAccount = "deviceId"
    static let agentIdAccount = "agentId"
    static let agentTokenAccount = "agentToken"
    static let installationIdAccount = "installationId"
    static let updateManifestUrlAccount = "updateManifestUrl"

    static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result)
                == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else {
            return nil
        }
        return value
    }

    static func write(_ value: String, account: String) {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              let data = normalized.data(using: .utf8) else {
            return
        }
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String:
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(
            identity as CFDictionary,
            attributes as CFDictionary
        )
        guard status == errSecItemNotFound else { return }
        var item = identity
        attributes.forEach { item[$0.key] = $0.value }
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(_ account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

@main
struct MobileAgentApp: App {
    @UIApplicationDelegateAdaptor(MobileAgentAppDelegate.self)
    private var appDelegate
    @StateObject private var runtime = AgentRuntime()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            DeviceAppView(runtime: runtime)
                .environmentObject(runtime)
                .onAppear {
                    runtime.bootstrapFromEnvironment()
                }
                .onOpenURL { url in
                    runtime.applyPairingUrl(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { runtime.refreshDeviceAppPermissions() }
                }
        }
    }
}

final class MobileAgentAppDelegate: NSObject, UIApplicationDelegate,
    UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [
            UIApplication.LaunchOptionsKey: Any
        ]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        return true
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (
            UNNotificationPresentationOptions
        ) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

private enum AgentTunnelError: LocalizedError {
    case stopTimedOut
    case providerSessionUnavailable
    case invalidProviderStatus

    var errorDescription: String? {
        switch self {
        case .stopTimedOut:
            return "The previous Packet Tunnel did not stop before the configuration update"
        case .providerSessionUnavailable:
            return "The Packet Tunnel provider session is unavailable"
        case .invalidProviderStatus:
            return "The Packet Tunnel returned an invalid status response"
        }
    }
}

@MainActor
final class AgentRuntime: ObservableObject {
    private static let tunnelConfigurationRevision = 18
    private static let tunnelNetworkMode = "ios27-devicehub-system-pairing"
    private let runtimeLogger = Logger(
        subsystem: "dev.galatea.agent",
        category: "AgentRuntime"
    )

    @Published var controllerUrl = ""
    @Published var pairingCode = ""
    @Published var displayName = UIDevice.current.name
    @Published var appState = "APP_OFFLINE"
    @Published var engineState = "WDA_DISCONNECTED"
    @Published var screenState = "REPLAYKIT_STOPPED"
    @Published var localNetworkState = "LOCAL_NETWORK_UNKNOWN"
    @Published private(set) var notificationState = "NOTIFICATION_UNKNOWN"
    @Published private(set) var activePermissionRequest: String?
    @Published var vpnState = "VPN_STOPPED"
    @Published var pairingState = "PAIRING_IDLE"
    @Published var remotePairingState = "REMOTE_PAIRING_WAITING"
    @Published private(set) var requiredUpdateBuild: String?
    @Published private(set) var updateInstallInProgress = false
    @Published var lastError = ""
    private var lastEngineFailure: String?
    @Published var logs: [String] = []

    @Published private(set) var deviceId: String
    let buildLabel: String
    let wdaBaseUrl: String
    let targetBundleId: String
    let targetUdid: String?

    private var controlClient: ControlClient?
    private var accountMutationBusy = false
    private let wdaClient: WdaClient
    private var tunnelManager: NETunnelProviderManager?
    private var tunnelStartTask: Task<Void, Never>?
    private var localNetworkBrowser: NWBrowser?
    private var localNetworkProbe: NWConnection?
    private var localNetworkProbeTimeout: Task<Void, Never>?
    private var updateInstallTask: Task<Void, Never>?
    private var pairingMonitorTask: Task<Void, Never>?
    private var heartbeatTimer: Timer?
    private var appOnline = false
    private var engineReady = false
    private var screenActive = false
    private var screenWidth = 0
    private var screenHeight = 0
    private var agentToken = ""
    private var agentId = ""
    private let installationId: String
    private var didBootstrap = false
    private var pairableHostIdentifier: String?
    private var pairableHostLastSeenAt: Date?
    private var openSystemPairingWhenReady = false
    private var updateManifestUrl: URL?
    private let currentBuild: String

    var systemPermissionRequestInFlight: Bool {
        activePermissionRequest != nil
    }

    init() {
        let shortVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let buildVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        currentBuild = buildVersion
        buildLabel = "\(shortVersion) (\(buildVersion))"
        let vendor = UIDevice.current.identifierForVendor?.uuidString.lowercased()
            ?? UUID().uuidString.lowercased()
        installationId = AgentCredentialStore.read(
            AgentCredentialStore.installationIdAccount
        ) ?? "inst_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        #if targetEnvironment(simulator)
        deviceId = "ios-simulator-\(vendor)"
        #else
        deviceId = AgentCredentialStore.read(
            AgentCredentialStore.deviceIdAccount
        ) ?? "ios-device-\(vendor)"
        #endif
        let env = ProcessInfo.processInfo.environment
        wdaBaseUrl = env["MOBILE_AGENT_WDA_URL"] ?? "http://127.0.0.1:8100"
        targetBundleId = env["MOBILE_AGENT_IOS_BUNDLE_ID"] ?? (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent")
        targetUdid = env["MOBILE_AGENT_IOS_UDID"]
        wdaClient = WdaClient(
            baseUrl: wdaBaseUrl,
            targetBundleId: targetBundleId,
            targetUdid: targetUdid
        )
        if let defaults = AgentSharedConfig.defaults {
            controllerUrl = defaults.string(
                forKey: AgentSharedConfig.controllerUrlKey
            ) ?? AgentCredentialStore.read(
                AgentCredentialStore.controllerUrlAccount
            ) ?? controllerUrl
            displayName = defaults.string(forKey: AgentSharedConfig.displayNameKey) ?? displayName
            pairingCode = defaults.string(forKey: AgentSharedConfig.pairingCodeKey) ?? pairingCode
            agentToken = defaults.string(
                forKey: AgentSharedConfig.agentTokenKey
            ) ?? AgentCredentialStore.read(
                AgentCredentialStore.agentTokenAccount
            ) ?? agentToken
            agentId = defaults.string(forKey: AgentSharedConfig.agentIdKey)
                ?? AgentCredentialStore.read(AgentCredentialStore.agentIdAccount)
                ?? agentId
            requiredUpdateBuild = defaults.string(
                forKey: AgentSharedConfig.requiredUpdateBuildKey
            )
            updateManifestUrl = Self.validUpdateManifestUrl(
                defaults.string(forKey: AgentSharedConfig.updateManifestUrlKey)
                    ?? AgentCredentialStore.read(
                        AgentCredentialStore.updateManifestUrlAccount
                    )
            )
        } else {
            controllerUrl = AgentCredentialStore.read(
                AgentCredentialStore.controllerUrlAccount
            ) ?? controllerUrl
            agentToken = AgentCredentialStore.read(
                AgentCredentialStore.agentTokenAccount
            ) ?? agentToken
            agentId = AgentCredentialStore.read(
                AgentCredentialStore.agentIdAccount
            ) ?? agentId
            updateManifestUrl = Self.validUpdateManifestUrl(
                AgentCredentialStore.read(
                    AgentCredentialStore.updateManifestUrlAccount
                )
            )
        }
    }

    func bootstrapFromEnvironment() {
        guard !didBootstrap else { return }
        didBootstrap = true
        let env = ProcessInfo.processInfo.environment
        if let url = env["MOBILE_AGENT_CONTROLLER_URL"], !url.isEmpty {
            controllerUrl = url
        }
        if let code = env["MOBILE_AGENT_PAIRING_CODE"], !code.isEmpty {
            pairingCode = code
        }
        if let token = env["MOBILE_AGENT_AGENT_TOKEN"], !token.isEmpty {
            agentToken = token
        }
        if let name = env["MOBILE_AGENT_DISPLAY_NAME"], !name.isEmpty {
            displayName = name
        }
        let hasSavedCredentials = !agentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // A stale pending link must not override the one-shot saved-session
        // check on launch. New links can be applied after boot if needed.
        if hasSavedCredentials { pairingCode = "" }
        let canAutostart = hasSavedCredentials && deviceConnectionEnabled
            && !controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        persistSharedConfig()
        refreshPairingNotificationPermission()
        if canAutostart {
            start(startupCredentialProbe: true)
        }
        // Local Network authorization is not queryable through a public API.
        // Re-run one serialized Network.framework check on every foreground
        // launch so an already-authorized installation immediately returns to
        // READY instead of displaying UNKNOWN until the user presses a button.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
            guard let self,
                  AgentSharedConfig.defaults?.bool(forKey: "localNetworkRequested") == true,
                  self.localNetworkState == "LOCAL_NETWORK_UNKNOWN" else {
                return
            }
            self.requestLocalNetworkPermission()
        }
        if env["MOBILE_AGENT_SCREEN_AUTOSTART"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.startScreen()
            }
        }
        // A saved NETunnelProvider configuration has already passed the only
        // system consent prompt. Restore that tunnel automatically after an
        // app relaunch instead of asking the user to press "Start VPN" again.
        // The Packet Tunnel maintains the durable device-side connection; the
        // foreground app provides setup and diagnostics UI.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.restoreSavedPacketTunnel()
        }
        #if targetEnvironment(simulator)
        if let identifier = env["MOBILE_AGENT_PAIRING_PROBE_HOST_ID"],
           UUID(uuidString: identifier) != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.startWirelessPairing(expectedIdentifier: identifier)
            }
        }
        #endif
    }

    func applyPairingUrl(_ url: URL) {
        guard url.scheme == "gelato", url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return
        }
        let items = Dictionary((components.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, new in new })
        if let version = items["protocol"], version != "gelato.v1" {
            lastError = "不支持的 Gelato 协议版本"
            return
        }
        if let kind = items["agentKind"], kind != "ios" { return }
        if let value = items["controllerUrl"], !value.isEmpty {
            guard let normalized = try? deviceAppOrigin(value) else {
                lastError = "配对链接中的控制服务地址无效"
                return
            }
            guard agentToken.isEmpty || normalized == (try? deviceAppOrigin(controllerUrl)) else {
                AgentSharedConfig.defaults?.set(normalized, forKey: "pendingControllerUrl")
                return
            }
            controllerUrl = normalized
        }
        if agentToken.isEmpty, let value = items["pairingCode"], !value.isEmpty {
            guard value.range(of: "^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$", options: .regularExpression) != nil else {
                lastError = "配对码格式无效"
                return
            }
            pairingCode = value
            AgentSharedConfig.defaults?.set(Date().timeIntervalSince1970, forKey: "pendingPairingAt")
        }
        if let value = items["updateManifestUrl"],
           let manifestUrl = Self.validUpdateManifestUrl(value) {
            updateManifestUrl = manifestUrl
        }
        if let value = items["requiredBuild"], Self.validBuild(value) {
            requiredUpdateBuild = value
        }
        let shouldStartVpn = flagValue(items["startVpn"]) || flagValue(items["vpnAutostart"])
        let shouldStartAgent = flagValue(items["autoStart"]) || flagValue(items["start"])
        if let identifier = items["pairableHostIdentifier"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .uppercased(),
           UUID(uuidString: identifier) != nil {
            pairableHostIdentifier = identifier
        }
        persistSharedConfig()
        log("Loaded Controller pairing link")
        if let code = items["guestJoin"], code.range(of: "^[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil {
            AgentSharedConfig.defaults?.set(code, forKey: "pendingGuestCode")
            AgentSharedConfig.defaults?.set(controllerUrl, forKey: "pendingGuestOrigin")
        }
        if !agentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && shouldStartAgent && deviceConnectionEnabled {
            start()
        }
        if shouldStartVpn {
            vpnState = "VPN_WAITING_FOR_USER"
            log("Pairing link requested VPN; waiting for explicit user confirmation")
        }
    }

    func start(startupCredentialProbe: Bool = false) {
        guard deviceConnectionEnabled else {
            appState = "APP_OFFLINE"
            return
        }
        if agentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           let blocker = deviceAppSetup().prePairingBlocker {
            lastError = "请先完成配对前准备：\(blocker)"
            return
        }
        guard !updateRequired else {
            appOnline = false
            appState = "APP_UPDATE_REQUIRED"
            lastError = "Controller requires Gelato Build \(requiredUpdateBuild ?? "newer")"
            return
        }
        guard !controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            lastError = "Controller URL is required"
            return
        }
        guard !agentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                || !pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            lastError = "Controller connection code is required for first pairing"
            return
        }
        appOnline = false
        appState = "APP_CONNECTING"
        engineReady = false
        engineState = "WDA_CHECKING"
        updateIdleTimer()
        lastError = ""
        persistSharedConfig()
        log("Starting iOS target against \(controllerUrl)")
        controlClient?.stop()
        let client = ControlClient(runtime: self)
        controlClient = client
        client.start(
            controllerUrl: controllerUrl,
            pairingCode: pairingCode,
            agentId: agentId,
            credential: agentToken,
            startupCredentialProbe: startupCredentialProbe
        )
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.sendStatus()
            }
        }
    }

    func stop() {
        appOnline = false
        engineReady = false
        appState = "APP_OFFLINE"
        engineState = "WDA_DISCONNECTED"
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        controlClient?.stop()
        controlClient = nil
        MainAppRemoteXPCBridge.shared.stop()
        stopScreen()
        updateIdleTimer()
        log("Stopped")
    }

    func startScreen() {
        guard deviceControlAllowed, appOnline else {
            lastError = "Open Gelato before starting screen sharing"
            return
        }
        LiveScreenCapture.shared.start(runtime: self)
    }

    func screenOrientation() async throws -> String {
        try await wdaClient.orientation()
    }

    func stopScreen() {
        LiveScreenCapture.shared.stop(runtime: self)
    }

    func startPacketTunnel() {
        guard deviceControlAllowed else {
            lastError = "请先开启允许接入控制"
            return
        }
        guard beginSystemPermissionRequest("VPN") else {
            lastError = "请先完成当前系统授权，再启动 VPN"
            return
        }
        guard localNetworkState != "LOCAL_NETWORK_DENIED" else {
            vpnState = "VPN_WAITING_FOR_LOCAL_NETWORK"
            lastError = "Local Network access was denied; allow it before starting VPN"
            finishSystemPermissionRequest("VPN")
            log("VPN start blocked by confirmed Local Network denial")
            return
        }
        guard notificationState != "NOTIFICATION_DENIED" else {
            vpnState = "VPN_WAITING_FOR_NOTIFICATIONS"
            lastError = "Notifications were denied; allow them so the pairing code is visible"
            finishSystemPermissionRequest("VPN")
            log("VPN start blocked by confirmed Notifications denial")
            return
        }
        let token = agentToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if token.isEmpty {
            vpnState = "VPN_WAITING_FOR_PAIRING"
            persistSharedConfig()
            lastError = "Controller pairing must complete before VPN starts"
            finishSystemPermissionRequest("VPN")
            log("VPN start blocked until Controller pairing completes")
            return
        }
        pairingMonitorTask?.cancel()
        pairingMonitorTask = nil
        WirelessPairingCoordinator.shared.stop()
        pairableHostIdentifier = nil
        pairableHostLastSeenAt = nil
        pairingState = "PAIRING_WAITING_FOR_PROXY"
        remotePairingState = "REMOTE_PAIRING_WAITING"
        vpnState = "VPN_CONFIGURING"
        lastError = ""
        persistSharedConfig()
        tunnelStartTask?.cancel()
        tunnelStartTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.finishSystemPermissionRequest("VPN") }
            await self.replaceAndStartPacketTunnel(staleRetryRemaining: 2)
        }
    }

    func requestLocalNetworkPermission() {
        AgentSharedConfig.defaults?.set(true, forKey: "localNetworkRequested")
        guard localNetworkState != "LOCAL_NETWORK_READY",
              localNetworkBrowser == nil,
              localNetworkProbe == nil else {
            return
        }
        guard beginSystemPermissionRequest("LOCAL_NETWORK") else {
            lastError = "请先完成当前系统授权，再请求本地网络"
            return
        }
        localNetworkState = "LOCAL_NETWORK_REQUESTING"
        lastError = ""
        let queue = DispatchQueue(label: "agent.local-network-permission")
        let browser = NWBrowser(
            for: .bonjour(type: "_remotepairing._tcp", domain: nil),
            using: .tcp
        )
        localNetworkBrowser = browser
        browser.stateUpdateHandler = { [weak self, weak browser] state in
            Task { @MainActor in
                guard let self, let browser,
                      self.localNetworkBrowser === browser else {
                    return
                }
                switch state {
                case .ready:
                    self.completeLocalNetworkPermissionCheck(
                        ready: true,
                        message: "Local Network permission ready via Bonjour"
                    )
                case .waiting(let error):
                    if self.isLocalNetworkPolicyDenied(error) {
                        self.completeLocalNetworkPermissionCheck(
                            ready: false,
                            denied: true,
                            message: "Local Network permission denied: \(error.localizedDescription)"
                        )
                    } else {
                        self.localNetworkState = "LOCAL_NETWORK_WAITING"
                        self.log(
                            "Local Network Bonjour waiting: \(error.localizedDescription)"
                        )
                    }
                case .failed(let error):
                    if self.isLocalNetworkPolicyDenied(error) {
                        self.completeLocalNetworkPermissionCheck(
                            ready: false,
                            denied: true,
                            message: "Local Network permission denied: \(error.localizedDescription)"
                        )
                    } else {
                        self.log(
                            "Local Network Bonjour failed; waiting for UDP probe: \(error.localizedDescription)"
                        )
                    }
                case .cancelled:
                    break
                case .setup:
                    break
                @unknown default:
                    break
                }
            }
        }
        browser.browseResultsChangedHandler = { _, _ in }
        browser.start(queue: queue)

        // A Bonjour browser is the canonical permission trigger, but on some
        // iOS 27 builds its state can remain waiting even after the user has
        // granted access.  An actual multicast UDP write independently proves
        // that the process may use the local network.
        let probe = NWConnection(
            host: NWEndpoint.Host("224.0.0.251"),
            port: NWEndpoint.Port(rawValue: 5353)!,
            using: .udp
        )
        localNetworkProbe = probe
        probe.stateUpdateHandler = { [weak self, weak probe] state in
            Task { @MainActor in
                guard let self, let probe,
                      self.localNetworkProbe === probe else {
                    return
                }
                switch state {
                case .ready:
                    probe.send(content: Data([0]), completion: .contentProcessed { error in
                        Task { @MainActor in
                            guard self.localNetworkProbe === probe else { return }
                            if let error {
                                if self.isLocalNetworkPolicyDenied(error) {
                                    self.completeLocalNetworkPermissionCheck(
                                        ready: false,
                                        denied: true,
                                        message: "Local Network permission denied: \(error.localizedDescription)"
                                    )
                                } else {
                                    self.log("Local Network UDP probe write failed: \(error.localizedDescription)")
                                }
                            } else {
                                self.completeLocalNetworkPermissionCheck(
                                    ready: true,
                                    message: "Local Network permission ready via multicast probe"
                                )
                            }
                        }
                    })
                case .waiting(let error), .failed(let error):
                    if self.isLocalNetworkPolicyDenied(error) {
                        self.completeLocalNetworkPermissionCheck(
                            ready: false,
                            denied: true,
                            message: "Local Network permission denied: \(error.localizedDescription)"
                        )
                    } else {
                        self.log("Local Network UDP probe waiting: \(error.localizedDescription)")
                    }
                case .setup, .preparing, .cancelled:
                    break
                @unknown default:
                    break
                }
            }
        }
        probe.start(queue: queue)

        localNetworkProbeTimeout?.cancel()
        localNetworkProbeTimeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let self,
                  self.localNetworkBrowser != nil || self.localNetworkProbe != nil else {
                return
            }
            self.completeLocalNetworkPermissionCheck(
                ready: false,
                denied: false,
                message: "Local Network permission check timed out; retry when Wi-Fi is available"
            )
        }
        log("Requesting Local Network permission")
    }

    private func isLocalNetworkPolicyDenied(_ error: NWError) -> Bool {
        switch error {
        case .dns(let code):
            return code == -65570
        case .posix(let code):
            return code == .EPERM || code == .EACCES
        default:
            return false
        }
    }

    private func completeLocalNetworkPermissionCheck(
        ready: Bool,
        denied: Bool = false,
        message: String
    ) {
        localNetworkProbeTimeout?.cancel()
        localNetworkProbeTimeout = nil
        let browser = localNetworkBrowser
        localNetworkBrowser = nil
        browser?.cancel()
        let probe = localNetworkProbe
        localNetworkProbe = nil
        probe?.cancel()
        if ready {
            localNetworkState = "LOCAL_NETWORK_READY"
            lastError = ""
        } else if denied {
            localNetworkState = "LOCAL_NETWORK_DENIED"
            lastError = "Allow Local Network access in iOS Settings"
        } else {
            localNetworkState = "LOCAL_NETWORK_UNKNOWN"
            lastError = message
        }
        finishSystemPermissionRequest("LOCAL_NETWORK")
        log(message)
    }

    func requestPairingNotificationPermission() {
        guard beginSystemPermissionRequest("NOTIFICATIONS") else {
            lastError = "请先完成当前系统授权，再请求通知"
            return
        }
        notificationState = "NOTIFICATION_REQUESTING"
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] settings in
            guard settings.authorizationStatus == .notDetermined else {
                Task { @MainActor [weak self] in
                    self?.applyNotificationSettings(settings)
                    self?.finishSystemPermissionRequest("NOTIFICATIONS")
                }
                return
            }
            center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, _ in
                center.getNotificationSettings { updatedSettings in
                    Task { @MainActor [weak self] in
                        self?.applyNotificationSettings(updatedSettings)
                        self?.finishSystemPermissionRequest("NOTIFICATIONS")
                    }
                }
            }
        }
    }

    private func refreshPairingNotificationPermission() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor [weak self] in
                self?.applyNotificationSettings(settings)
            }
        }
    }

    private func applyNotificationSettings(_ settings: UNNotificationSettings) {
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            notificationState = "NOTIFICATION_READY"
            lastError = ""
        case .denied:
            notificationState = "NOTIFICATION_DENIED"
            lastError = "Allow Notifications in iOS Settings to receive pairing codes"
        case .notDetermined:
            notificationState = "NOTIFICATION_NOT_REQUESTED"
        @unknown default:
            notificationState = "NOTIFICATION_UNKNOWN"
        }
    }

    private func beginSystemPermissionRequest(_ request: String) -> Bool {
        guard activePermissionRequest == nil else { return false }
        activePermissionRequest = request
        return true
    }

    private func finishSystemPermissionRequest(_ request: String) {
        guard activePermissionRequest == request else { return }
        activePermissionRequest = nil
    }

    func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            return
        }
        UIApplication.shared.open(url)
    }

    func stopPacketTunnel() {
        tunnelStartTask?.cancel()
        tunnelStartTask = nil
        finishSystemPermissionRequest("VPN")
        pairingMonitorTask?.cancel()
        pairingMonitorTask = nil
        WirelessPairingCoordinator.shared.stop()
        pairableHostIdentifier = nil
        pairableHostLastSeenAt = nil
        AgentSharedConfig.defaults?.set(
            false,
            forKey: AgentSharedConfig.vpnAutostartKey
        )
        tunnelManager?.connection.stopVPNTunnel()
        vpnState = "VPN_STOPPED"
        pairingState = "PAIRING_IDLE"
        remotePairingState = "REMOTE_PAIRING_WAITING"
        log("Packet Tunnel stop requested")
    }

    private func replaceAndStartPacketTunnel(
        staleRetryRemaining: Int
    ) async {
        do {
            let managers = try await loadTunnelManagers()
            try Task.checkCancellation()
            let manager = managers.first(where: { $0.localizedDescription == "Serverized Controller Overlay" })
                ?? NETunnelProviderManager()
            tunnelManager = manager
            if tunnelConfigurationMatches(manager),
               try await resumeMatchingPacketTunnel(
                   manager,
                   logMessage: "Existing Packet Tunnel configuration resumed"
               ) {
                return
            }
            try await stopTunnelBeforeReplacingConfiguration(manager)
            try Task.checkCancellation()

            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel"
            proto.serverAddress = controllerEndpoint().host ?? "gelato-controller"
            proto.providerConfiguration = [
                "controllerUrl": controllerUrl,
                "deviceId": deviceId,
                "agentId": agentId,
                "agentToken": agentToken,
                "clientBuild": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                "configurationRevision": Self.tunnelConfigurationRevision,
                "networkMode": Self.tunnelNetworkMode,
                "wdaBaseUrl": wdaBaseUrl,
                "targetBundleId": targetBundleId,
                "targetUdid": targetUdid ?? ""
            ]
            // Preserve LocalDevVPN's proven manager configuration. In
            // particular, do not force iOS 27 protocol route flags here:
            // those flags allow the outer CDTunnel handshake but prevent the
            // inner RSD TCP flow from returning through packetFlow.
            let localDevRule = NEOnDemandRuleEvaluateConnection()
            localDevRule.interfaceTypeMatch = .any
            localDevRule.connectionRules = [
                NEEvaluateConnectionRule(
                    matchDomains: ["10.7.0.0", "10.7.0.1"],
                    andAction: .connectIfNeeded
                )
            ]
            manager.onDemandRules = [localDevRule]
            manager.isOnDemandEnabled = true
            manager.localizedDescription = "Serverized Controller Overlay"
            manager.protocolConfiguration = proto
            manager.isEnabled = true
            try await saveTunnelManager(manager)
            try await reloadTunnelManager(manager)
            try Task.checkCancellation()
            try manager.connection.startVPNTunnel()
            AgentSharedConfig.defaults?.set(
                true,
                forKey: AgentSharedConfig.vpnAutostartKey
            )
            vpnState = "VPN_STARTING"
            lastError = ""
            pairingState = "PAIRING_WAITING_FOR_PROXY"
            monitorWirelessPairing(manager)
            log(
                "Packet Tunnel revision \(Self.tunnelConfigurationRevision) start requested"
            )
        } catch is CancellationError {
            return
        } catch {
            let nsError = error as NSError
            if staleRetryRemaining > 0,
               nsError.domain == NEVPNErrorDomain,
               nsError.code == NEVPNError.configurationStale.rawValue {
                tunnelManager = nil
                log("VPN configuration changed; reloading before retry")
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                await replaceAndStartPacketTunnel(
                    staleRetryRemaining: staleRetryRemaining - 1
                )
                return
            }
            vpnState = "VPN_ERROR"
            lastError = error.localizedDescription
            log("VPN replace/start error: \(error.localizedDescription)")
        }
    }

    private func tunnelConfigurationMatches(
        _ manager: NETunnelProviderManager
    ) -> Bool {
        guard manager.isEnabled,
              let proto = manager.protocolConfiguration
                as? NETunnelProviderProtocol,
              proto.providerBundleIdentifier
                == (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel",
              let configuration = proto.providerConfiguration else {
            return false
        }
        let revision = (configuration["configurationRevision"] as? NSNumber)?
            .intValue
            ?? configuration["configurationRevision"] as? Int
            ?? -1
        return configuration["controllerUrl"] as? String == controllerUrl
            && configuration["deviceId"] as? String == deviceId
            && configuration["agentId"] as? String == agentId
            && configuration["agentToken"] as? String == agentToken
            && revision == Self.tunnelConfigurationRevision
            && configuration["networkMode"] as? String
                == Self.tunnelNetworkMode
            && configuration["wdaBaseUrl"] as? String == wdaBaseUrl
            && configuration["targetBundleId"] as? String == targetBundleId
            && configuration["targetUdid"] as? String == (targetUdid ?? "")
    }

    private func restoreSavedPacketTunnel() {
        guard deviceControlAllowed, tunnelStartTask == nil,
              !controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !agentToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        tunnelStartTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.tunnelStartTask = nil }
            do {
                let managers = try await self.loadTunnelManagers()
                try Task.checkCancellation()
                guard let manager = managers.first(where: {
                    $0.localizedDescription == "Serverized Controller Overlay"
                        || ($0.protocolConfiguration as? NETunnelProviderProtocol)?
                            .providerBundleIdentifier
                            == (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel"
                }), self.tunnelConfigurationMatches(manager) else {
                    return
                }
                let defaults = AgentSharedConfig.defaults
                let hasExplicitIntent = defaults?.object(
                    forKey: AgentSharedConfig.vpnAutostartKey
                ) != nil
                let shouldRestore = hasExplicitIntent
                    ? (defaults?.bool(forKey: AgentSharedConfig.vpnAutostartKey) ?? false)
                    : true
                guard shouldRestore else { return }
                self.tunnelManager = manager
                _ = try await self.resumeMatchingPacketTunnel(
                    manager,
                    logMessage: "Saved Packet Tunnel restored after app launch"
                )
            } catch is CancellationError {
                return
            } catch {
                self.vpnState = "VPN_ERROR"
                self.lastError = error.localizedDescription
                self.log("Saved Packet Tunnel restore error: \(error.localizedDescription)")
            }
        }
    }

    private func resumeMatchingPacketTunnel(
        _ manager: NETunnelProviderManager,
        logMessage: String
    ) async throws -> Bool {
        guard tunnelConfigurationMatches(manager) else { return false }
        if manager.connection.status == .disconnecting {
            let deadline = Date().addingTimeInterval(15)
            while manager.connection.status == .disconnecting {
                try Task.checkCancellation()
                guard Date() < deadline else {
                    throw AgentTunnelError.stopTimedOut
                }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        let installedBuild = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? "unknown"
        let runningBuild = AgentSharedConfig.defaults?.string(
            forKey: AgentSharedConfig.runningPacketTunnelBuildKey
        )
        if manager.connection.status == .connected,
           runningBuild != installedBuild {
            log(
                "Restarting Packet Tunnel to load installed build \(installedBuild)"
            )
            try await stopTunnelBeforeReplacingConfiguration(manager)
            try Task.checkCancellation()
        }
        switch manager.connection.status {
        case .connected:
            vpnState = "VPN_CONNECTED"
        case .connecting, .reasserting:
            vpnState = "VPN_STARTING"
        case .disconnected:
            try manager.connection.startVPNTunnel()
            vpnState = "VPN_STARTING"
        case .invalid, .disconnecting:
            return false
        @unknown default:
            return false
        }
        AgentSharedConfig.defaults?.set(
            true,
            forKey: AgentSharedConfig.vpnAutostartKey
        )
        pairingState = "PAIRING_WAITING_FOR_PROXY"
        lastError = ""
        monitorWirelessPairing(manager)
        log(logMessage)
        return true
    }

    private func stopTunnelBeforeReplacingConfiguration(_ manager: NETunnelProviderManager) async throws {
        let inactive: Set<NEVPNStatus> = [.invalid, .disconnected]
        if inactive.contains(manager.connection.status) {
            return
        }
        vpnState = "VPN_RESTARTING"
        log("Stopping previous Packet Tunnel before configuration update")
        if manager.connection.status != .disconnecting {
            manager.connection.stopVPNTunnel()
        }
        let deadline = Date().addingTimeInterval(15)
        while !inactive.contains(manager.connection.status) {
            try Task.checkCancellation()
            guard Date() < deadline else {
                throw AgentTunnelError.stopTimedOut
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    private func loadTunnelManagers() async throws -> [NETunnelProviderManager] {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<[NETunnelProviderManager], Error>) in
            NETunnelProviderManager.loadAllFromPreferences { managers, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: managers ?? [])
                }
            }
        }
    }

    private func saveTunnelManager(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            manager.saveToPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func reloadTunnelManager(_ manager: NETunnelProviderManager) async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            manager.loadFromPreferences { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    private func markPairingHostUnavailableIfStale(_ proxyState: String) {
        guard !engineReady,
              !["PAIRING_AWAITING_DRIVER", "PAIRING_COMPLETE", "PAIRING_UNVERIFIED"]
                .contains(pairingState) else { return }
        if let pairableHostLastSeenAt,
           Date().timeIntervalSince(pairableHostLastSeenAt) < 15 { return }
        if pairableHostIdentifier != nil {
            WirelessPairingCoordinator.shared.stop()
            pairableHostIdentifier = nil
            self.pairableHostLastSeenAt = nil
        }
        pairingState = proxyState == "bonjourFailed"
            ? "PAIRING_PROXY_FAILED" : "PAIRING_WAITING_FOR_PROXY"
    }

    private func monitorWirelessPairing(_ manager: NETunnelProviderManager) {
        pairingMonitorTask?.cancel()
        pairingMonitorTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                if manager.connection.status == .connected {
                    vpnState = "VPN_CONNECTED"
                    do {
                        let status = try await packetTunnelStatus(manager)
                        let proxyState = status["pairingProxyState"] as? String ?? "bonjourWaiting"
                        let deviceServiceState = status["remotePairingState"] as? String ?? "browsing"
                        remotePairingState = deviceServiceState == "ready"
                            ? "REMOTE_PAIRING_READY"
                            : "REMOTE_PAIRING_WAITING"
                        if proxyState == "bonjourReady",
                           let identifier = status["pairableHostIdentifier"] as? String,
                           UUID(uuidString: identifier) != nil {
                            pairableHostLastSeenAt = Date()
                            if pairableHostIdentifier != identifier ||
                               ["PAIRING_WAITING_FOR_PROXY", "PAIRING_PROXY_FAILED"]
                                .contains(pairingState) {
                                pairableHostIdentifier = identifier
                                startWirelessPairing(expectedIdentifier: identifier)
                            }
                            if openSystemPairingWhenReady {
                                openSystemPairingWhenReady = false
                                WirelessPairingCoordinator.shared
                                    .openSystemPairingSettings()
                            }
                            try? await Task.sleep(nanoseconds: 500_000_000)
                            continue
                        }
                        markPairingHostUnavailableIfStale(proxyState)
                    } catch {
                        markPairingHostUnavailableIfStale("bonjourWaiting")
                    }
                } else {
                    markPairingHostUnavailableIfStale("bonjourWaiting")
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    private func packetTunnelStatus(_ manager: NETunnelProviderManager) async throws -> [String: Any] {
        guard let session = manager.connection as? NETunnelProviderSession else {
            throw AgentTunnelError.providerSessionUnavailable
        }
        let data: Data = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Data, Error>) in
            do {
                try session.sendProviderMessage(Data([0])) { data in
                    guard let data else {
                        continuation.resume(throwing: AgentTunnelError.invalidProviderStatus)
                        return
                    }
                    continuation.resume(returning: data)
                }
            } catch {
                continuation.resume(throwing: error)
            }
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AgentTunnelError.invalidProviderStatus
        }
        return value
    }

    private func requestPacketTunnelWdaInstall() async -> Bool {
        let managers: [NETunnelProviderManager]
        do {
            managers = try await loadTunnelManagers()
        } catch {
            log("WDA package staged; Packet Tunnel lookup failed: \(error.localizedDescription)")
            return false
        }
        guard let manager = managers.first(where: { candidate in
            (candidate.protocolConfiguration as? NETunnelProviderProtocol)?
                .providerBundleIdentifier
                == (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel"
        }),
        let session = manager.connection as? NETunnelProviderSession,
        manager.connection.status == .connected,
        let message = try? JSONSerialization.data(
            withJSONObject: ["type": "installStagedWda"]
        ) else {
            log("WDA package staged; Packet Tunnel will install it on next start")
            return false
        }
        do {
            let response: Data = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<Data, Error>) in
                do {
                    try session.sendProviderMessage(message) { data in
                        guard let data else {
                            continuation.resume(
                                throwing: AgentTunnelError.invalidProviderStatus
                            )
                            return
                        }
                        continuation.resume(returning: data)
                    }
                } catch {
                    continuation.resume(throwing: error)
                }
            }
            let payload = try JSONSerialization.jsonObject(with: response)
                as? [String: Any]
            return payload?["accepted"] as? Bool == true
        } catch {
            log("WDA package staged; Packet Tunnel notification failed: \(error.localizedDescription)")
            return false
        }
    }

    private func startWirelessPairing(expectedIdentifier: String) {
        let pairingLogger = Logger(
            subsystem: "dev.galatea.agent",
            category: "WirelessPairing"
        )
        pairingLogger.info("state=PAIRING_ENTRY")
        #if targetEnvironment(simulator)
        UserDefaults.standard.set("PAIRING_ENTRY", forKey: "pairingProbeState")
        #endif
        guard #available(iOS 27.0, *) else {
            pairingLogger.info("state=PAIRING_REQUIRES_IOS_27")
            #if targetEnvironment(simulator)
            UserDefaults.standard.set("PAIRING_REQUIRES_IOS_27", forKey: "pairingProbeState")
            #endif
            pairingState = "PAIRING_REQUIRES_IOS_27"
            log("System wireless pairing requires iOS 27 or later")
            return
        }
        pairingState = "PAIRING_SYSTEM_UI_STARTING"
        WirelessPairingCoordinator.shared.start(expectedIdentifier: expectedIdentifier) { [weak self] state, detail in
            Task { @MainActor in
                guard let self else { return }
                self.pairingState = state
                #if targetEnvironment(simulator)
                UserDefaults.standard.set(state, forKey: "pairingProbeState")
                if let detail, !detail.isEmpty {
                    UserDefaults.standard.set(detail, forKey: "pairingProbeDetail")
                } else {
                    UserDefaults.standard.removeObject(forKey: "pairingProbeDetail")
                }
                #endif
                if let detail, !detail.isEmpty {
                    self.log("Wireless pairing \(state): \(detail)")
                } else {
                    self.log("Wireless pairing \(state)")
                }
                if state.contains("FAILED")
                    || state.contains("UNAVAILABLE")
                    || state == "PAIRING_INVALID_HOST" {
                    self.lastError = detail ?? state
                } else if state == "PAIRING_SYSTEM_UI_OPENED" {
                    self.lastError = ""
                }
                self.sendStatus()
            }
        }
    }

    func openSystemPairingSettings() {
        guard let identifier = pairableHostIdentifier else {
            openSystemPairingWhenReady = true
            pairingState = "PAIRING_WAITING_FOR_PROXY"
            lastError = "Start the VPN and wait for the Linux pairing service"
            log(lastError)
            return
        }
        if pairingState == "PAIRING_IDLE" || pairingState == "PAIRING_WAITING_FOR_PROXY" {
            startWirelessPairing(expectedIdentifier: identifier)
        }
        openSystemPairingWhenReady = false
        WirelessPairingCoordinator.shared.openSystemPairingSettings()
    }

    func openDeveloperModeSettings() {
        WirelessPairingCoordinator.shared.openDeveloperModeSettings { [weak self] state, detail in
            Task { @MainActor in
                guard let self else { return }
                if let detail, !detail.isEmpty {
                    self.log("\(state): \(detail)")
                } else {
                    self.log(state)
                }
                if state.contains("UNAVAILABLE") {
                    self.lastError = detail ?? state
                }
            }
        }
    }

    func startBroadcast() {
        guard appOnline else {
            lastError = "Open Gelato before starting broadcast"
            return
        }
        startScreen()
    }

    func markConnected() {
        let wasConnected = appOnline && appState == "APP_ONLINE"
        appOnline = true
        appState = "APP_ONLINE"
        updateIdleTimer()
        if !wasConnected {
            engineReady = false
            engineState = "WDA_CHECKING"
            lastError = ""
            log("Controller channel connected")
        }
    }

    func markConnecting() {
        let wasConnecting = !appOnline && appState == "APP_CONNECTING"
        appOnline = false
        appState = "APP_CONNECTING"
        updateIdleTimer()
        if !wasConnecting {
            log("Controller channel connecting")
        }
    }

    func markDisconnected(_ error: String?) {
        appOnline = false
        appState = "RECOVERING"
        updateIdleTimer()
        if let error, !error.isEmpty {
            lastError = error
            log("Controller channel disconnected: \(error)")
        } else {
            log("Controller channel disconnected")
        }
    }

    func acceptPairing(agentId: String, deviceId: String, credential: String?) {
        self.agentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.deviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if let credential, !credential.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            agentToken = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        pairingCode = ""
        persistSharedConfig()
        log("Controller pairing accepted; device token stored")
        if vpnState == "VPN_WAITING_FOR_PAIRING" {
            vpnState = "VPN_WAITING_FOR_USER"
        }
    }

    func rejectPairing(_ error: String, clearCredential: Bool = true) {
        let hadAgentToken = !agentToken
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .isEmpty
        pairingCode = ""
        AgentSharedConfig.defaults?.removeObject(
            forKey: AgentSharedConfig.pairingCodeKey
        )
        if !clearCredential && hadAgentToken {
            lastError = error
            appOnline = false
            appState = "APP_CONNECTING"
            persistSharedConfig()
            log("Controller pairing code rejected; retrying saved device credential")
            controlClient?.retrySavedCredential()
            return
        }
        if clearCredential {
            agentToken = ""
            agentId = ""
            AgentSharedConfig.defaults?.set(false, forKey: "controlAllowed")
        }
        appOnline = false
        appState = "PAIRING_REQUIRED"
        engineReady = false
        engineState = "WDA_DISCONNECTED"
        lastError = error
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        controlClient?.stop()
        controlClient = nil
        if clearCredential && hadAgentToken {
            tunnelManager?.connection.stopVPNTunnel()
            vpnState = "VPN_WAITING_FOR_PAIRING"
        }
        if clearCredential {
            AgentSharedConfig.defaults?.removeObject(
                forKey: AgentSharedConfig.agentTokenKey
            )
            AgentCredentialStore.delete(AgentCredentialStore.agentTokenAccount)
            AgentCredentialStore.delete(AgentCredentialStore.agentIdAccount)
        }
        persistSharedConfig()
        log("Controller pairing rejected: \(error)")
    }

    func sendStatus() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.refreshEngineHealth()
            self.controlClient?.stateChanged()
        }
    }

    func currentAgentToken() -> String {
        agentToken
    }

    func currentAgentId() -> String {
        agentId
    }

    func setScreenActive(_ active: Bool, width: Int, height: Int, error: String?) {
        screenActive = active
        screenWidth = active ? width : 0
        screenHeight = active ? height : 0
        screenState = active ? "SCREEN_ACTIVE" : "REPLAYKIT_STOPPED"
        updateIdleTimer()
        if let error, !error.isEmpty {
            lastError = error
            log("Screen stream error: \(error)")
        } else if active {
            lastError = ""
            if width > 0 && height > 0 {
                log("Screen stream active \(width)x\(height)")
            } else {
                log("Screen stream active")
            }
        } else {
            log("Screen stream stopped")
        }
        sendStatus()
    }

    private func refreshEngineHealth() async {
        guard deviceControlAllowed else {
            engineReady = false
            engineState = "CONTROL_PAUSED"
            return
        }
        // The Packet Tunnel persists the Linux-issued RemotePairing record in
        // the shared App Group.  Start the RemoteXPC/WDA bootstrap from the
        // containing app process before probing WDA: on iOS 27 the same
        // connection can stall indefinitely when it originates inside the
        // Network Extension.  This call is idempotent and keeps retry/backoff
        // state inside MainAppRemoteXPCBridge.
        MainAppRemoteXPCBridge.shared.startIfAvailable()
        do {
            _ = try await wdaClient.request(method: "GET", path: "/status", jsonBody: nil)
            guard deviceControlAllowed else { return }
            engineReady = true
            engineState = "WDA_READY"
            pairingState = "PAIRING_COMPLETE"
            lastError = DeviceAppErrorRecovery.afterSuccessfulEngineProbe(
                current: lastError, recordedEngineFailure: lastEngineFailure
            )
            lastEngineFailure = nil
        } catch {
            guard deviceControlAllowed else { return }
            engineReady = false
            engineState = "WDA_DISCONNECTED"
            if pairingState == "PAIRING_COMPLETE" {
                pairingState = "PAIRING_UNVERIFIED"
            }
            lastEngineFailure = error.localizedDescription
            // WDA is expected to be unreachable before system pairing. Keep
            // this failure on the driver snapshot; it is not an error in the
            // Controller connection and must not create a repeating app alert.
        }
    }

    func deviceAgentDescriptor() -> [String: Any] {
        [
            "installationId": installationId,
            "agentKind": "ios",
            "hostPlatform": "ios",
            "deviceKind": "apple.iphone",
            "displayName": displayName,
            "agentVersion": buildLabel
        ]
    }

    func deviceAgentSnapshot(revision: Int) -> [String: Any] {
        let driverError: Any = engineReady
            ? NSNull()
            : (lastEngineFailure ?? "WDA is not ready")
        let snapshot: [String: Any] = [
            "revision": revision,
            "kind": "apple.iphone",
            "displayName": displayName,
            "os": ["family": "ios", "version": UIDevice.current.systemVersion],
            "driver": [
                "id": "ios.wda-remotexpc",
                "version": "1",
                "location": "device",
                "state": engineReady ? "ready" : "degraded",
                "error": driverError
            ],
            "hardware": [
                "controlAllowed": deviceControlAllowed,
                "present": true,
                "connected": appOnline,
                "stableKey": UIDevice.current.identifierForVendor?.uuidString ?? installationId,
                "vpnState": vpnState,
                "remotePairingState": remotePairingState,
                "pairingState": pairingState,
                "localNetworkState": localNetworkState,
                "notificationState": notificationState,
                "userAction": NSNull()
            ],
            "capabilities": deviceAgentCapabilities()
        ]
        // Descriptor/capabilities are shared with the extension, not copied
        // into a second implementation. The extension replaces all live state.
        AgentSharedConfig.defaults?.set(try? JSONSerialization.data(withJSONObject: snapshot), forKey: "deviceAgentSnapshot")
        return snapshot
    }

    func executeCapability(_ capability: String, arguments: [String: Any]) async throws -> [String: Any] {
        guard deviceControlAllowed || capability == "device.describe" else {
            throw AgentError.message("Device owner has paused remote control")
        }
        var command = arguments
        switch capability {
        case "device.describe": command["type"] = "status"
        case "input.tap": command["type"] = "tap"
        case "input.swipe": command["type"] = "swipe"
        case "text.type": command["type"] = "typeText"
        case "app.launch": command["type"] = "launchApp"
        case "screen.capture": command["type"] = "getScreenshot"
        case "ui.tree": command["type"] = "getUiTree"
        case "vendor.apple.wda-http": command["type"] = "wdaHttpRequest"
        case "vendor.apple.wda.ensure": command["type"] = "stageWdaPackage"
        case "network.tcp.probe": command["type"] = "tcpProbe"
        case "network.tcp.exchange": command["type"] = "tcpExchange"
        case "network.local-info": command["type"] = "localNetworkInfo"
        case "network.bonjour.browse": command["type"] = "bonjourBrowse"
        case "device.system-pairing.confirm": command["type"] = "confirmSystemPairing"
        case "device.system-pairing.pin.show":
            let pin = arguments["pin"] as? String ?? ""
            guard pin.count == 6, pin.allSatisfy(\.isNumber) else {
                throw AgentError.message("A six-digit pairing PIN is required")
            }
            let defaults = AgentSharedConfig.defaults
            let center = UNUserNotificationCenter.current()
            var previousIds = ["serverized-system-pairing-pin"]
            if let previousId = defaults?.string(
                forKey: AgentSharedConfig.systemPairingPinNotificationIdKey
            ) {
                previousIds.append(previousId)
            }
            center.removePendingNotificationRequests(withIdentifiers: previousIds)
            center.removeDeliveredNotifications(withIdentifiers: previousIds)
            defaults?.removeObject(forKey: AgentSharedConfig.systemPairingPinNotificationIdKey)
            let content = UNMutableNotificationContent()
            content.title = "iPhone 配对码"
            content.body = "\(pin) · 5 分钟内有效"
            content.sound = .default
            content.threadIdentifier = "serverized-system-pairing"
            let notificationId = "serverized-system-pairing-pin-\(UUID().uuidString)"
            try await center.add(
                UNNotificationRequest(identifier: notificationId, content: content, trigger: nil)
            )
            defaults?.set(notificationId, forKey: AgentSharedConfig.systemPairingPinNotificationIdKey)
            return ["accepted": true]
        case "agent.update.require": command["type"] = "requireAgentUpdate"
        default: throw AgentError.message("Capability is not implemented: \(capability)")
        }
        if capability == "device.describe" {
            return ["snapshot": deviceAgentSnapshot(revision: 0)]
        }
        return try await handle(command: command)
    }

    private func deviceAgentCapabilities() -> [[String: Any]] {
        [
            ["name": "device.describe", "version": 1],
            ["name": "input.tap", "version": 1, "consent": "developer-mode-control"],
            ["name": "input.swipe", "version": 1, "consent": "developer-mode-control"],
            ["name": "text.type", "version": 1, "consent": "developer-mode-control"],
            ["name": "app.launch", "version": 1, "consent": "developer-mode-control"],
            ["name": "screen.capture", "version": 1],
            ["name": "ui.tree", "version": 1],
            ["name": "vendor.apple.wda-http", "version": 1],
            ["name": "vendor.apple.wda.ensure", "version": 1, "consent": "developer-mode-control"],
            ["name": "network.tcp.probe", "version": 1],
            ["name": "network.tcp.exchange", "version": 1],
            ["name": "network.local-info", "version": 1],
            ["name": "network.bonjour.browse", "version": 1],
            ["name": "device.system-pairing.confirm", "version": 1, "consent": "system-pairing"],
            ["name": "device.system-pairing.pin.show", "version": 1, "consent": "notifications"],
            ["name": "agent.update.require", "version": 1, "consent": "software-update"]
        ]
    }

    func handle(command: [String: Any]) async throws -> [String: Any] {
        guard let type = command["type"] as? String else {
            throw AgentError.message("Missing command type")
        }
        if updateRequired && type != "requireAgentUpdate" {
            throw AgentError.message(
                "Gelato Build \(requiredUpdateBuild ?? "newer") is required"
            )
        }
        switch type {
        case "confirmSystemPairing":
            let defaults = AgentSharedConfig.defaults
            var notificationIds = ["serverized-system-pairing-pin"]
            if let notificationId = defaults?.string(
                forKey: AgentSharedConfig.systemPairingPinNotificationIdKey
            ) {
                notificationIds.append(notificationId)
            }
            let center = UNUserNotificationCenter.current()
            center.removePendingNotificationRequests(withIdentifiers: notificationIds)
            center.removeDeliveredNotifications(withIdentifiers: notificationIds)
            defaults?.removeObject(forKey: AgentSharedConfig.systemPairingPinNotificationIdKey)
            pairingState = "PAIRING_AWAITING_DRIVER"
            lastError = ""
            sendStatus()
            return ["type": "confirmSystemPairing", "accepted": true]
        case "wdaHttpRequest":
            let method = command["method"] as? String ?? "GET"
            let path = command["path"] as? String ?? "/status"
            let rawBody = command["body"]
            let body = rawBody is NSNull ? nil : rawBody
            let response = try await wdaClient.request(method: method, path: path, jsonBody: body)
            return response.toCommandResult()
        case "stageWdaPackage":
            return try await stageWdaPackage(command)
        case "tap":
            try await wdaClient.tap(
                x: intValue(command["x"]),
                y: intValue(command["y"])
            )
            return ["type": "tap", "output": "ok"]
        case "swipe":
            try await wdaClient.swipe(
                fromX: intValue(command["fromX"]),
                fromY: intValue(command["fromY"]),
                toX: intValue(command["toX"]),
                toY: intValue(command["toY"]),
                durationMs: intValue(command["durationMs"], defaultValue: 450)
            )
            return ["type": "swipe", "output": "ok"]
        case "typeText":
            try await wdaClient.typeText(command["text"] as? String ?? "")
            return ["type": "typeText", "output": "ok"]
        case "launchApp":
            let appId = command["appId"] as? String ?? command["bundleId"] as? String ?? ""
            guard !appId.isEmpty else { throw AgentError.message("bundleId/appId is required") }
            // Launching another app can suspend this host before it can report the command result.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000)
                do {
                    try await self?.wdaClient.launchApp(appId)
                } catch {
                    await MainActor.run {
                        self?.lastError = error.localizedDescription
                        self?.log("Launch app error: \(error.localizedDescription)")
                    }
                }
            }
            return ["type": "launchApp", "output": "accepted"]
        case "getScreenshot":
            let base64 = try await wdaClient.screenshot()
            return ["type": "screenshot", "mimeType": "image/png", "base64": base64]
        case "getUiTree":
            let source = try await wdaClient.source()
            return ["type": "uitree", "output": source]
        case "tcpProbe":
            let host = command["host"] as? String ?? "127.0.0.1"
            let port = intValue(command["port"], defaultValue: 32498)
            return try await TcpProbe.check(host: host, port: port, timeoutMs: intValue(command["timeoutMs"], defaultValue: 3000))
        case "tcpExchange":
            let host = command["host"] as? String ?? "127.0.0.1"
            let port = intValue(command["port"], defaultValue: 49152)
            let payload = tcpPayload(command)
            return try await TcpProbe.exchange(
                host: host,
                port: port,
                payload: payload,
                timeoutMs: intValue(command["timeoutMs"], defaultValue: 3000),
                maxBytes: intValue(command["maxBytes"], defaultValue: 4096)
            )
        case "localNetworkInfo":
            return ["type": "localNetworkInfo", "interfaces": localInterfaceAddresses()]
        case "bonjourBrowse":
            let serviceTypes = stringArray(command["serviceTypes"], defaultValue: ["_remotepairing._tcp.", "_apple-mobdev2._tcp."])
            return await BonjourDiscovery.browse(
                serviceTypes: serviceTypes,
                timeoutMs: intValue(command["timeoutMs"], defaultValue: 5000)
            )
        case "requireAgentUpdate":
            let requiredBuild = String(describing: command["requiredBuild"] ?? "")
            let manifestValue = command["manifestUrl"] as? String
            try applyRequiredUpdate(
                requiredBuild: requiredBuild,
                manifestUrl: manifestValue,
                openInstaller: false
            )
            return [
                "type": "requireAgentUpdate",
                "accepted": true,
                "requiredBuild": requiredBuild,
                "updateRequired": updateRequired
            ]
        default:
            throw AgentError.message("Unsupported iOS command: \(type)")
        }
    }

    private func stageWdaPackage(
        _ command: [String: Any]
    ) async throws -> [String: Any] {
        guard let stream = command["packageStream"] as? [String: Any],
              let streamId = stream["streamId"] as? String,
              streamId.range(
                of: #"^str_[A-Za-z0-9_-]{10,80}$"#,
                options: .regularExpression
              ) != nil,
              let path = stream["path"] as? String,
              path == "/agent/streams/\(streamId)/content",
              let expectedSha = stream["sha256"] as? String,
              expectedSha.range(
                of: #"^[0-9a-f]{64}$"#,
                options: .regularExpression
              ) != nil,
              let expectedBytes = (stream["sizeBytes"] as? NSNumber)?.intValue,
              expectedBytes > 0,
              expectedBytes <= 32 * 1024 * 1024 else {
            throw AgentError.message("WDA package stream metadata is invalid")
        }
        guard let base = URL(string: controllerUrl),
              let packageUrl = URL(string: path, relativeTo: base)?.absoluteURL,
              packageUrl.scheme == base.scheme,
              packageUrl.host == base.host,
              packageUrl.port == base.port,
              packageUrl.user == nil,
              packageUrl.password == nil,
              packageUrl.query == nil,
              packageUrl.fragment == nil else {
            throw AgentError.message("WDA package stream URL is invalid")
        }
        var request = URLRequest(url: packageUrl)
        request.setValue("Bearer \(agentToken)", forHTTPHeaderField: "Authorization")
        request.setValue(agentId, forHTTPHeaderField: "X-Agent-Id")
        request.setValue(deviceId, forHTTPHeaderField: "X-Device-Id")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 60
        let (bytes, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              http.statusCode == 200,
              bytes.count == expectedBytes else {
            throw AgentError.message("WDA package stream download failed")
        }
        let actualSha = SHA256.hash(data: bytes)
            .map { String(format: "%02x", $0) }
            .joined()
        guard actualSha == expectedSha else {
            throw AgentError.message("WDA package checksum mismatch")
        }
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AgentSharedConfig.appGroup
        ) else {
            throw AgentError.message("App Group container is unavailable")
        }
        let package = container.appendingPathComponent(
            AgentSharedConfig.stagedWdaPackageName
        )
        try bytes.write(to: package, options: [.atomic])
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: package.path
        )
        AgentSharedConfig.defaults?.set(
            expectedSha,
            forKey: AgentSharedConfig.pendingWdaPackageSha256Key
        )
        let providerNotified = await requestPacketTunnelWdaInstall()
        return [
            "type": "stageWdaPackage",
            "accepted": true,
            "sha256": expectedSha,
            "bytes": bytes.count,
            "providerNotified": providerNotified
        ]
    }

    func log(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        logs.append("\(formatter.string(from: Date()))  \(line)")
        runtimeLogger.info("\(line, privacy: .public)")
        if logs.count > 160 {
            logs.removeFirst(logs.count - 160)
        }
    }

    func persistSharedConfig() {
        let normalizedControllerUrl = controllerUrl.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        let normalizedAgentToken = agentToken.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        AgentCredentialStore.write(
            normalizedControllerUrl,
            account: AgentCredentialStore.controllerUrlAccount
        )
        AgentCredentialStore.write(
            deviceId,
            account: AgentCredentialStore.deviceIdAccount
        )
        AgentCredentialStore.write(
            agentId,
            account: AgentCredentialStore.agentIdAccount
        )
        AgentCredentialStore.write(
            installationId,
            account: AgentCredentialStore.installationIdAccount
        )
        AgentCredentialStore.write(
            normalizedAgentToken,
            account: AgentCredentialStore.agentTokenAccount
        )
        if let updateManifestUrl {
            AgentCredentialStore.write(
                updateManifestUrl.absoluteString,
                account: AgentCredentialStore.updateManifestUrlAccount
            )
        }
        guard let defaults = AgentSharedConfig.defaults else {
            log("App Group defaults unavailable")
            return
        }
        defaults.set(normalizedControllerUrl, forKey: AgentSharedConfig.controllerUrlKey)
        defaults.set(deviceId, forKey: AgentSharedConfig.deviceIdKey)
        defaults.set(agentId, forKey: AgentSharedConfig.agentIdKey)
        defaults.set(installationId, forKey: AgentSharedConfig.installationIdKey)
        defaults.set(displayName, forKey: AgentSharedConfig.displayNameKey)
        defaults.set(pairingCode.trimmingCharacters(in: .whitespacesAndNewlines), forKey: AgentSharedConfig.pairingCodeKey)
        defaults.set(normalizedAgentToken, forKey: AgentSharedConfig.agentTokenKey)
        defaults.set(wdaBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines), forKey: AgentSharedConfig.wdaBaseUrlKey)
        defaults.set(targetBundleId.trimmingCharacters(in: .whitespacesAndNewlines), forKey: AgentSharedConfig.iosBundleIdKey)
        defaults.set(targetUdid?.trimmingCharacters(in: .whitespacesAndNewlines), forKey: AgentSharedConfig.iosUdidKey)
        defaults.set(requiredUpdateBuild, forKey: AgentSharedConfig.requiredUpdateBuildKey)
        defaults.set(updateManifestUrl?.absoluteString, forKey: AgentSharedConfig.updateManifestUrlKey)
        defaults.synchronize()
    }

    var updateRequired: Bool {
        guard let requiredUpdateBuild,
              let required = Int(requiredUpdateBuild),
              let current = Int(currentBuild) else {
            return false
        }
        return current < required
    }

    var updateInstallerAvailable: Bool {
        updateManifestUrl != nil
    }

    func installRequiredUpdate() {
        guard updateRequired, let manifestUrl = updateManifestUrl else { return }
        guard updateInstallTask == nil else { return }
        var installer = URLComponents(string: "itms-services://")
        installer?.queryItems = [
            URLQueryItem(name: "action", value: "download-manifest"),
            URLQueryItem(name: "url", value: manifestUrl.absoluteString)
        ]
        guard let url = installer?.url else {
            lastError = "Could not create the system update URL"
            return
        }
        updateInstallInProgress = true
        lastError = ""
        updateInstallTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.updateInstallInProgress = false
                self.updateInstallTask = nil
            }
            do {
                self.log("Stopping the background Packet Tunnel before required update")
                let managers = try await self.loadTunnelManagers()
                let serverizedManagers = managers.filter { manager in
                    manager.localizedDescription == "Serverized Controller Overlay"
                        || (manager.protocolConfiguration as? NETunnelProviderProtocol)?
                            .providerBundleIdentifier
                            == (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel"
                }
                for manager in serverizedManagers {
                    try Task.checkCancellation()
                    try await self.stopTunnelBeforeReplacingConfiguration(manager)
                }
                self.vpnState = "VPN_STOPPED_FOR_UPDATE"
                self.log("Packet Tunnel stopped; opening the required Gelato update")
                _ = await UIApplication.shared.open(url)
            } catch is CancellationError {
                return
            } catch {
                self.vpnState = "VPN_UPDATE_STOP_ERROR"
                self.lastError = "更新前无法停止后台 VPN：\(error.localizedDescription)"
                self.log("Required update preparation failed: \(error.localizedDescription)")
            }
        }
    }

    private func applyRequiredUpdate(
        requiredBuild: String,
        manifestUrl: String?,
        openInstaller: Bool
    ) throws {
        guard Self.validBuild(requiredBuild) else {
            throw AgentError.message("requiredBuild must be a positive integer")
        }
        if let manifestUrl {
            guard let validated = Self.validUpdateManifestUrl(manifestUrl) else {
                throw AgentError.message("manifestUrl must be an HTTPS manifest.plist URL")
            }
            updateManifestUrl = validated
        }
        requiredUpdateBuild = requiredBuild
        persistSharedConfig()
        log("Controller requires Gelato Build \(requiredBuild)")
        if openInstaller && updateRequired && updateInstallerAvailable {
            installRequiredUpdate()
        }
    }

    private static func validBuild(_ value: String) -> Bool {
        guard let number = Int(value) else { return false }
        return number > 0 && value.count <= 10
    }

    private static func validUpdateManifestUrl(_ value: String?) -> URL? {
        guard let value,
              let url = URL(string: value),
              url.scheme?.lowercased() == "https",
              url.host != nil,
              url.user == nil,
              url.password == nil,
              url.fragment == nil,
              url.path.hasSuffix("/manifest.plist") else {
            return nil
        }
        return url
    }

    private func controllerEndpoint() -> (host: String?, addressClass: String, transport: String) {
        var value = controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            return (nil, "unknown", "unknown")
        }
        if value.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*://"#, options: .regularExpression) == nil {
            value = "ws://\(value)"
        }
        guard let url = URL(string: value) else {
            return (nil, "unknown", "unknown")
        }
        let scheme = url.scheme?.lowercased() ?? ""
        let transport = scheme == "https" || scheme == "wss" ? "tls" : "cleartext"
        let host = url.host?.lowercased()
        return (host, classifyHost(host), transport)
    }

    private func classifyHost(_ host: String?) -> String {
        guard let host, !host.isEmpty else { return "unknown" }
        if host == "localhost" || host.hasPrefix("127.") || host == "::1" {
            return "loopback"
        }
        if host.hasSuffix(".local") {
            return "private"
        }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4 {
            let first = parts[0]
            let second = parts[1]
            if first == 10 { return "private" }
            if first == 172 && second >= 16 && second <= 31 { return "private" }
            if first == 192 && second == 168 { return "private" }
            if first == 169 && second == 254 { return "private" }
            if first == 100 && second >= 64 && second <= 127 { return "private" }
            if first == 0 { return "private" }
        }
        if host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") {
            return "private"
        }
        return "public"
    }

    private func flagValue(_ value: String?) -> Bool {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !value.isEmpty else {
            return false
        }
        return ["1", "true", "yes", "y", "on"].contains(value)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = appOnline || screenActive
    }
}

private func tcpPayload(_ command: [String: Any]) -> Data {
    if let base64 = command["payloadBase64"] as? String,
       let data = Data(base64Encoded: base64) {
        return data
    }
    if let text = command["payload"] as? String {
        return Data(text.utf8)
    }
    return Data()
}

private enum TcpProbe {
    static func check(host: String, port: Int, timeoutMs: Int) async throws -> [String: Any] {
        let startedAt = Date()
        return try await withCheckedThrowingContinuation { continuation in
            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(rawValue: UInt16(clamping: port))!,
                using: .tcp
            )
            let queue = DispatchQueue(label: "agent.tcpProbe.\(UUID().uuidString)")
            var completed = false
            func finish(_ result: Result<[String: Any], Error>) {
                queue.async {
                    guard !completed else { return }
                    completed = true
                    connection.cancel()
                    continuation.resume(with: result)
                }
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                    finish(.success([
                        "type": "tcpProbe",
                        "host": host,
                        "port": port,
                        "connectable": true,
                        "elapsedMs": elapsed
                    ]))
                case .failed(let error):
                    let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                    finish(.success([
                        "type": "tcpProbe",
                        "host": host,
                        "port": port,
                        "connectable": false,
                        "elapsedMs": elapsed,
                        "error": error.localizedDescription
                    ]))
                default:
                    break
                }
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(max(timeoutMs, 1))) {
                let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                finish(.success([
                    "type": "tcpProbe",
                    "host": host,
                    "port": port,
                    "connectable": false,
                    "elapsedMs": elapsed,
                    "error": "timeout"
                ]))
            }
            connection.start(queue: queue)
        }
    }

    static func exchange(host: String, port: Int, payload: Data, timeoutMs: Int, maxBytes: Int) async throws -> [String: Any] {
        let startedAt = Date()
        return try await withCheckedThrowingContinuation { continuation in
            let connection = NWConnection(
                host: NWEndpoint.Host(host),
                port: NWEndpoint.Port(rawValue: UInt16(clamping: port))!,
                using: .tcp
            )
            let queue = DispatchQueue(label: "agent.tcpExchange.\(UUID().uuidString)")
            var completed = false
            func finish(_ result: Result<[String: Any], Error>) {
                queue.async {
                    guard !completed else { return }
                    completed = true
                    connection.cancel()
                    continuation.resume(with: result)
                }
            }
            func receive() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: max(maxBytes, 1)) { data, _, isComplete, error in
                    let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                    if let error {
                        finish(.success([
                            "type": "tcpExchange",
                            "host": host,
                            "port": port,
                            "connected": true,
                            "elapsedMs": elapsed,
                            "error": error.localizedDescription
                        ]))
                        return
                    }
                    let body = data ?? Data()
                    finish(.success([
                        "type": "tcpExchange",
                        "host": host,
                        "port": port,
                        "connected": true,
                        "elapsedMs": elapsed,
                        "complete": isComplete,
                        "bytesRead": body.count,
                        "base64": body.base64EncodedString(),
                        "text": String(data: body.prefix(2048), encoding: .utf8) ?? ""
                    ]))
                }
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if payload.isEmpty {
                        receive()
                    } else {
                        connection.send(content: payload, completion: .contentProcessed { error in
                            if let error {
                                let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                                finish(.success([
                                    "type": "tcpExchange",
                                    "host": host,
                                    "port": port,
                                    "connected": true,
                                    "elapsedMs": elapsed,
                                    "error": error.localizedDescription
                                ]))
                            } else {
                                receive()
                            }
                        })
                    }
                case .failed(let error):
                    let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                    finish(.success([
                        "type": "tcpExchange",
                        "host": host,
                        "port": port,
                        "connected": false,
                        "elapsedMs": elapsed,
                        "error": error.localizedDescription
                    ]))
                default:
                    break
                }
            }
            queue.asyncAfter(deadline: .now() + .milliseconds(max(timeoutMs, 1))) {
                let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
                finish(.success([
                    "type": "tcpExchange",
                    "host": host,
                    "port": port,
                    "connected": true,
                    "elapsedMs": elapsed,
                    "error": "timeout"
                ]))
            }
            connection.start(queue: queue)
        }
    }
}

private func localInterfaceAddresses() -> [[String: String]] {
    var pointer: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
    defer { freeifaddrs(pointer) }
    var results: [[String: String]] = []
    var cursor: UnsafeMutablePointer<ifaddrs>? = first
    while let item = cursor {
        defer { cursor = item.pointee.ifa_next }
        let flags = Int32(item.pointee.ifa_flags)
        guard flags & IFF_UP == IFF_UP, let address = item.pointee.ifa_addr else { continue }
        let family = address.pointee.sa_family
        guard family == UInt8(AF_INET) || family == UInt8(AF_INET6) else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let length: socklen_t = family == UInt8(AF_INET) ? socklen_t(MemoryLayout<sockaddr_in>.size) : socklen_t(MemoryLayout<sockaddr_in6>.size)
        if getnameinfo(address, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            results.append([
                "name": String(cString: item.pointee.ifa_name),
                "family": family == UInt8(AF_INET) ? "ipv4" : "ipv6",
                "address": String(cString: host)
            ])
        }
    }
    return results
}

private final class BonjourDiscovery: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private static var active: [BonjourDiscovery] = []

    private let serviceTypes: [String]
    private let timeoutMs: Int
    private let startedAt = Date()
    private var browsers: [NetServiceBrowser] = []
    private var services: [NetService] = []
    private var results: [String: [String: Any]] = [:]
    private var continuation: CheckedContinuation<[String: Any], Never>?
    private var finished = false

    init(serviceTypes: [String], timeoutMs: Int) {
        self.serviceTypes = serviceTypes.map(Self.normalizeServiceType)
        self.timeoutMs = max(timeoutMs, 250)
    }

    static func browse(serviceTypes: [String], timeoutMs: Int) async -> [String: Any] {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                let discovery = BonjourDiscovery(serviceTypes: serviceTypes, timeoutMs: timeoutMs)
                discovery.continuation = continuation
                active.append(discovery)
                discovery.start()
            }
        }
    }

    private func start() {
        for serviceType in serviceTypes {
            let browser = NetServiceBrowser()
            browser.delegate = self
            browsers.append(browser)
            browser.searchForServices(ofType: serviceType, inDomain: "local.")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { [weak self] in
            self?.finish()
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        for browser in browsers {
            browser.stop()
            browser.delegate = nil
        }
        for service in services {
            service.stop()
            service.delegate = nil
        }
        let services = results.values.sorted { left, right in
            String(describing: left["name"] ?? "") < String(describing: right["name"] ?? "")
        }
        let elapsed = Int(Date().timeIntervalSince(startedAt) * 1000)
        continuation?.resume(returning: [
            "type": "bonjourBrowse",
            "elapsedMs": elapsed,
            "serviceTypes": serviceTypes,
            "services": services
        ])
        continuation = nil
        Self.active.removeAll { $0 === self }
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        service.delegate = self
        services.append(service)
        update(service)
        service.resolve(withTimeout: max(Double(timeoutMs) / 1000.0, 1.0))
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        update(sender)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        update(sender, error: String(describing: errorDict))
    }

    private func update(_ service: NetService, error: String? = nil) {
        var record: [String: Any] = [
            "name": service.name,
            "serviceType": service.type,
            "domain": service.domain,
            "port": service.port
        ]
        if let hostName = service.hostName, !hostName.isEmpty {
            record["hostName"] = hostName
            record["host"] = hostName
        }
        if let data = service.txtRecordData() {
            let parsed = Self.txtRecord(from: data)
            record["txt"] = parsed.text
            record["txtBase64"] = parsed.base64
        }
        if let error {
            record["error"] = error
        }
        results["\(service.type)|\(service.name)|\(service.domain)"] = record
    }

    private static func txtRecord(from data: Data) -> (text: [String: String], base64: [String: String]) {
        let raw = NetService.dictionary(fromTXTRecord: data)
        var text: [String: String] = [:]
        var base64: [String: String] = [:]
        for (key, value) in raw {
            base64[key] = value.base64EncodedString()
            text[key] = String(data: value, encoding: .utf8) ?? value.base64EncodedString()
        }
        return (text, base64)
    }

    private static func normalizeServiceType(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.hasSuffix(".") ? trimmed : "\(trimmed)."
    }
}

final class ControlClient {
    private static let protocolName = "gelato.v1"
    private weak var runtime: AgentRuntime?
    private var task: URLSessionWebSocketTask?
    private var desired = false
    private var authenticated = false
    private var startupCredentialProbe = false
    private var startupProbeWorkItem: DispatchWorkItem?
    private var generation = 0
    private var reconnectAttempt = 0
    private var reconnectWorkItem: DispatchWorkItem?
    private var leaseWorkItem: DispatchWorkItem?
    private var controllerUrl = ""
    private var pairingCode = ""
    private var agentId = ""
    private var credential = ""
    private var deviceId = ""
    private var revision = 0
    private var running = [String: Task<Void, Never>]()
    private var terminalCache = [String: [String: Any]]()
    private var uploads = [String: PendingIOSUpload]()
    private var uploadSockets = [String: URLSessionWebSocketTask]()

    func pauseCommands() {
        running.values.forEach { $0.cancel() }
        running.removeAll()
        uploads.removeAll()
        uploadSockets.values.forEach { $0.cancel(with: .goingAway, reason: nil) }
        uploadSockets.removeAll()
    }

    init(runtime: AgentRuntime) {
        self.runtime = runtime
    }

    @MainActor
    func start(
        controllerUrl: String,
        pairingCode: String,
        agentId: String,
        credential: String,
        startupCredentialProbe: Bool
    ) {
        self.controllerUrl = controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        self.pairingCode = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines)
        self.agentId = agentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.credential = credential.trimmingCharacters(in: .whitespacesAndNewlines)
        self.startupCredentialProbe = startupCredentialProbe && self.pairingCode.isEmpty
            && !self.credential.isEmpty
        startupProbeWorkItem?.cancel()
        startupProbeWorkItem = nil
        self.deviceId = runtime?.deviceId ?? ""
        desired = true
        reconnectAttempt = 0
        connectNow()
    }

    func stop() {
        desired = false
        authenticated = false
        startupCredentialProbe = false
        startupProbeWorkItem?.cancel()
        startupProbeWorkItem = nil
        generation += 1
        reconnectWorkItem?.cancel()
        leaseWorkItem?.cancel()
        reconnectWorkItem = nil
        leaseWorkItem = nil
        running.values.forEach { $0.cancel() }
        running.removeAll()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    @MainActor
    func stateChanged() {
        sendSnapshot()
    }

    @MainActor
    func retrySavedCredential() {
        pairingCode = ""
        authenticated = false
        reconnectWorkItem?.cancel()
        leaseWorkItem?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connectNow()
    }

    @MainActor
    private func connectNow() {
        guard desired, !controllerUrl.isEmpty else { return }
        reconnectWorkItem?.cancel()
        leaseWorkItem?.cancel()
        generation += 1
        let activeGeneration = generation
        task?.cancel(with: .goingAway, reason: nil)
        let socket = URLSession.shared.webSocketTask(with: Self.websocketURL(controllerUrl, path: "/agent/control"))
        task = socket
        authenticated = false
        runtime?.markConnecting()
        socket.resume()
        if startupCredentialProbe {
            let item = DispatchWorkItem { [weak self] in
                guard let self, self.desired, !self.authenticated,
                      self.generation == activeGeneration else { return }
                self.failStartupCredentialProbe("旧凭据验证超时，已清除本机凭据，请重新配对")
            }
            startupProbeWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: item)
        }
        var body = runtime?.deviceAgentDescriptor() ?? [:]
        let deviceId: String?
        if !pairingCode.isEmpty {
            body["pairingCode"] = pairingCode
            deviceId = nil
            send(envelope("pairing.request", body: body))
        } else if !agentId.isEmpty && !credential.isEmpty {
            body["agentId"] = agentId
            body["credential"] = credential
            deviceId = self.deviceId
            send(envelope("session.hello", body: body, deviceId: deviceId))
        } else {
            Task { @MainActor in self.runtime?.rejectPairing("Pairing code or saved credential is required") }
            return
        }
        receiveLoop(socket, generation: activeGeneration)
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask, generation activeGeneration: Int) {
        socket.receive { [weak self] result in
            guard let self, self.desired, self.task === socket, self.generation == activeGeneration else { return }
            switch result {
            case .failure(let error):
                Task { @MainActor in self.disconnected(socket, generation: activeGeneration, error: error.localizedDescription) }
            case .success(let message):
                if case .string(let text) = message { self.handle(text) }
                self.receiveLoop(socket, generation: activeGeneration)
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              message["protocol"] as? String == Self.protocolName,
              let type = message["type"] as? String else {
            Task { @MainActor in self.runtime?.log("Invalid gelato.v1 Controller message") }
            return
        }
        let body = message["body"] as? [String: Any] ?? [:]
        switch type {
        case "pairing.accepted", "session.accepted":
            guard let acceptedAgentId = body["agentId"] as? String,
                  let deviceId = body["deviceId"] as? String else { return }
            let issuedCredential = body["credential"] as? String
            if let issuedCredential, !issuedCredential.isEmpty { credential = issuedCredential }
            agentId = acceptedAgentId
            self.deviceId = deviceId
            pairingCode = ""
            authenticated = true
            startupCredentialProbe = false
            startupProbeWorkItem?.cancel()
            startupProbeWorkItem = nil
            reconnectAttempt = 0
            revision = 0
            Task { @MainActor in
                self.runtime?.acceptPairing(agentId: acceptedAgentId, deviceId: deviceId, credential: issuedCredential)
                self.runtime?.markConnected()
                self.sendSnapshot()
                self.scheduleLease()
            }
        case "pairing.rejected":
            let error = body["error"] as? String ?? "Pairing rejected"
            desired = false
            pairingCode = ""
            Task { @MainActor in self.runtime?.rejectPairing(error, clearCredential: false) }
        case "session.rejected":
            let error = body["error"] as? String ?? "Saved device credential was rejected"
            desired = false
            startupCredentialProbe = false
            startupProbeWorkItem?.cancel()
            startupProbeWorkItem = nil
            agentId = ""
            credential = ""
            Task { @MainActor in
                self.runtime?.log("Saved credential rejected: \(error)")
                self.runtime?.rejectPairing("旧凭据被控制端拒绝，已清除本机凭据，请重新配对", clearCredential: true)
            }
        case "device.snapshot.request":
            Task { @MainActor in self.sendSnapshot() }
        case "command.request":
            handleCommand(message, body: body)
        case "command.cancel":
            let commandId = message["commandId"] as? String ?? body["commandId"] as? String ?? ""
            running[commandId]?.cancel()
        case "reply.deliver":
            guard message["deviceId"] as? String == deviceId,
                  let text = body["text"] as? String, !text.isEmpty, text.count <= 32_768,
                  let replyMessageId = message["messageId"] as? String else { return }
            AgentSharedConfig.defaults?.set(text, forKey: "lastReply")
            Task { @MainActor in self.runtime?.log("Gelato reply received") }
            send(envelope("reply.ack", body: ["replyMessageId": replyMessageId], deviceId: deviceId))
        case "stream.accept":
            if let streamId = body["streamId"] as? String { upload(streamId) }
        case "protocol.error":
            Task { @MainActor in self.runtime?.log(body["error"] as? String ?? "Controller protocol error") }
        default:
            break
        }
    }

    private func handleCommand(_ message: [String: Any], body: [String: Any]) {
        guard let commandId = message["commandId"] as? String ?? body["commandId"] as? String,
              let capability = body["capability"] as? String else { return }
        guard AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true || capability == "device.describe" else {
            sendError(commandId: commandId, error: "Device owner has paused remote control")
            return
        }
        if let cached = terminalCache[commandId] { send(cached); return }
        if running[commandId] != nil { return }
        let version = body["capabilityVersion"] as? Int ?? 1
        guard version == 1 else {
            sendError(commandId: commandId, error: "Unsupported capability version: \(capability)@\(version)")
            return
        }
        if let deadlineText = body["deadline"] as? String,
           let deadline = Self.iso8601Date(deadlineText),
           deadline <= Date() {
            sendError(commandId: commandId, error: "Command deadline has expired", cancelled: true)
            return
        }
        let arguments = body["arguments"] as? [String: Any] ?? [:]
        send(envelope("command.progress", body: ["stage": "accepted", "progress": 0], deviceId: deviceId, commandId: commandId))
        let operation = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.runtime?.executeCapability(capability, arguments: arguments) ?? [:]
                try Task.checkCancellation()
                if capability == "screen.capture",
                   let encoded = result["base64"] as? String,
                   let bytes = Data(base64Encoded: encoded) {
                    var metadata = result
                    metadata.removeValue(forKey: "base64")
                    self.offerUpload(commandId: commandId, purpose: "screen", contentType: result["mimeType"] as? String ?? "image/png", bytes: bytes, result: metadata)
                } else {
                    self.sendTerminal(commandId: commandId, result: result)
                }
            } catch is CancellationError {
                self.sendError(commandId: commandId, error: "Command cancelled", cancelled: true)
            } catch {
                self.sendError(commandId: commandId, error: error.localizedDescription)
            }
            self.running.removeValue(forKey: commandId)
        }
        running[commandId] = operation
    }

    private func offerUpload(commandId: String, purpose: String, contentType: String, bytes: Data, result: [String: Any]) {
        guard AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true else {
            sendError(commandId: commandId, error: "Device owner has paused remote control", cancelled: true)
            return
        }
        let streamId = "str_\(Self.randomId())"
        uploads[streamId] = PendingIOSUpload(commandId: commandId, purpose: purpose, contentType: contentType, bytes: bytes, result: result)
        send(envelope("stream.offer", body: [
            "streamId": streamId,
            "commandId": commandId,
            "purpose": purpose,
            "direction": "agent-to-controller",
            "contentType": contentType,
            "maxFrameBytes": 262_144,
            "maxTotalBytes": max(bytes.count, 1),
            "expectedBytes": bytes.count
        ], deviceId: deviceId, commandId: commandId))
    }

    private func upload(_ streamId: String) {
        guard AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true else { return }
        guard let pending = uploads[streamId], !credential.isEmpty, !agentId.isEmpty else { return }
        var request = URLRequest(url: Self.websocketURL(controllerUrl, path: "/agent/streams/\(streamId)"))
        request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        request.setValue(agentId, forHTTPHeaderField: "X-Agent-Id")
        let socket = URLSession.shared.webSocketTask(with: request)
        uploadSockets[streamId] = socket
        socket.resume()
        func receive() {
            socket.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .failure(let error):
                    self.uploads.removeValue(forKey: streamId)
                    self.uploadSockets.removeValue(forKey: streamId)
                    socket.cancel(with: .goingAway, reason: nil)
                    self.sendError(commandId: pending.commandId, error: "Stream upload failed: \(error.localizedDescription)")
                case .success(let message):
                    guard case .string(let text) = message,
                          let data = text.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let type = json["type"] as? String else { receive(); return }
                    if type == "stream.ready" {
                        var sequence: UInt32 = 0
                        var offset = 0
                        while offset < pending.bytes.count {
                            guard AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true else {
                                socket.cancel(with: .goingAway, reason: nil)
                                return
                            }
                            let end = min(offset + 262_144, pending.bytes.count)
                            var networkSequence = sequence.bigEndian
                            var frame = Data(bytes: &networkSequence, count: 4)
                            frame.append(pending.bytes.subdata(in: offset..<end))
                            socket.send(.data(frame)) { _ in }
                            sequence += 1
                            offset = end
                        }
                        socket.send(.string(Self.jsonText([
                            "type": "stream.end",
                            "totalBytes": pending.bytes.count,
                            "sha256": Self.sha256(pending.bytes)
                        ]))) { _ in }
                    } else if type == "stream.complete" {
                        self.uploads.removeValue(forKey: streamId)
                        self.uploadSockets.removeValue(forKey: streamId)
                        var result = pending.result
                        result["stream"] = [
                            "streamId": streamId,
                            "purpose": pending.purpose,
                            "contentType": pending.contentType,
                            "sizeBytes": pending.bytes.count,
                            "sha256": json["sha256"] as? String ?? ""
                        ]
                        self.sendTerminal(commandId: pending.commandId, result: result)
                        socket.cancel(with: .normalClosure, reason: nil)
                        return
                    }
                    receive()
                }
            }
        }
        receive()
    }

    @MainActor
    private func sendSnapshot() {
        guard authenticated else { return }
        revision += 1
        send(envelope("device.snapshot", body: runtime?.deviceAgentSnapshot(revision: revision) ?? [:], deviceId: deviceId))
    }

    @MainActor
    private func scheduleLease() {
        leaseWorkItem?.cancel()
        guard desired, authenticated else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.desired, self.authenticated else { return }
            self.send(self.envelope("lease.renew", body: ["revision": self.revision], deviceId: self.deviceId))
            Task { @MainActor in self.scheduleLease() }
        }
        leaseWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: item)
    }

    @MainActor
    private func disconnected(_ socket: URLSessionWebSocketTask, generation activeGeneration: Int, error: String) {
        guard desired, task === socket, generation == activeGeneration else { return }
        authenticated = false
        if startupCredentialProbe {
            runtime?.log("Startup credential authentication failed: \(error)")
            failStartupCredentialProbe("旧凭据验证失败，已清除本机凭据，请重新配对")
            return
        }
        runtime?.markDisconnected(error)
        reconnectAttempt = min(reconnectAttempt + 1, 6)
        let delay = min(pow(2.0, Double(reconnectAttempt - 1)), 30.0) + Double.random(in: 0...0.5)
        let item = DispatchWorkItem { [weak self] in Task { @MainActor in self?.connectNow() } }
        reconnectWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    @MainActor
    private func failStartupCredentialProbe(_ reason: String) {
        guard startupCredentialProbe, !authenticated else { return }
        startupCredentialProbe = false
        startupProbeWorkItem?.cancel()
        startupProbeWorkItem = nil
        desired = false
        runtime?.rejectPairing(reason, clearCredential: true)
    }

    private func sendTerminal(commandId: String, result: [String: Any]) {
        let message = envelope("command.result", body: ["result": result], deviceId: deviceId, commandId: commandId)
        terminalCache[commandId] = message
        if terminalCache.count > 128, let oldest = terminalCache.keys.first { terminalCache.removeValue(forKey: oldest) }
        send(message)
    }

    private func sendError(commandId: String, error: String, cancelled: Bool = false) {
        let message = envelope("command.error", body: ["error": error, "cancelled": cancelled], deviceId: deviceId, commandId: commandId)
        terminalCache[commandId] = message
        send(message)
    }

    private func send(_ payload: [String: Any]) {
        guard let task, JSONSerialization.isValidJSONObject(payload) else { return }
        task.send(.string(Self.jsonText(payload))) { _ in }
    }

    @MainActor
    func publishInput(text: String) throws -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return try publishInput(kind: "instruction", parts: [["type": "text", "text": value]])
    }

    @MainActor
    func publishInput(kind: String, parts: [[String: Any]]) throws -> String {
        guard authenticated, !deviceId.isEmpty,
              ["instruction", "observation"].contains(kind), (1...8).contains(parts.count) else {
            throw AgentError.message("设备未连接或内容无效")
        }
        for part in parts {
            switch part["type"] as? String {
            case "text":
                guard let text = part["text"] as? String,
                      !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      text.count <= 16_384, part.count == 2 else {
                    throw AgentError.message("文本内容无效")
                }
            case "media":
                guard let streamId = part["streamId"] as? String,
                      streamId.range(of: "^str_[A-Za-z0-9_-]{10,80}$", options: .regularExpression) != nil,
                      let mimeType = part["mimeType"] as? String, mimeType.count <= 200,
                      mimeType.range(of: "^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+$", options: .regularExpression) != nil,
                      part.count == 3 else {
                    throw AgentError.message("媒体引用无效")
                }
            default:
                throw AgentError.message("不支持的内容类型")
            }
        }
        let payload = envelope("input.publish", body: ["kind": kind, "parts": parts], deviceId: deviceId)
        send(payload)
        return payload["messageId"] as? String ?? ""
    }

    private func envelope(_ type: String, body: [String: Any], deviceId: String? = nil, commandId: String? = nil) -> [String: Any] {
        var value: [String: Any] = [
            "protocol": Self.protocolName,
            "type": type,
            "messageId": "msg_\(Self.randomId())",
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "body": body
        ]
        if let deviceId, !deviceId.isEmpty { value["deviceId"] = deviceId }
        if let commandId, !commandId.isEmpty { value["commandId"] = commandId }
        return value
    }

    private static func websocketURL(_ raw: String, path: String) -> URL {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("https://") { value = "wss://" + value.dropFirst(8) }
        else if value.hasPrefix("http://") { value = "ws://" + value.dropFirst(7) }
        else if !value.hasPrefix("ws://") && !value.hasPrefix("wss://") { value = "ws://" + value }
        while value.hasSuffix("/") { value.removeLast() }
        return URL(string: value + path)!
    }

    private static func randomId() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "") }
    private static func iso8601Date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
    private static func jsonText(_ value: [String: Any]) -> String {
        String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
    }
    private static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

private struct PendingIOSUpload {
    let commandId: String
    let purpose: String
    let contentType: String
    let bytes: Data
    let result: [String: Any]
}

final class WdaClient {
    private let baseUrl: String
    private let targetBundleId: String
    private let targetUdid: String?
    private var sessionId: String?

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
        guard !bundleId.isEmpty else { throw AgentError.message("bundleId/appId is required") }
        _ = try await withValidSession { session in
            try await self.request(
                method: "POST",
                path: "/session/\(session)/wda/apps/activate",
                jsonBody: ["bundleId": bundleId]
            )
        }
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
        throw AgentError.message("Screenshot response did not contain image data")
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

    func orientation() async throws -> String {
        let response = try await withValidSession { session in
            try await self.request(method: "GET", path: "/session/\(session)/orientation", jsonBody: nil)
        }
        guard let value = response.jsonObject()?["value"] as? String else {
            throw AgentError.message("WDA did not return an orientation")
        }
        return value
    }

    private func withValidSession(_ operation: (String) async throws -> WdaResponse) async throws -> WdaResponse {
        let session = try await ensureSession()
        do {
            return try await operation(session)
        } catch {
            guard isInvalidSession(error) else { throw error }
            sessionId = nil
            let freshSession = try await ensureSession()
            return try await operation(freshSession)
        }
    }

    private func isInvalidSession(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("invalid session id") || message.contains("session is either terminated or not started")
    }

    func request(method: String, path: String, jsonBody: Any?) async throws -> WdaResponse {
        guard let url = URL(string: baseUrl + (path.hasPrefix("/") ? path : "/\(path)")) else {
            throw AgentError.message("Invalid WDA URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 240
        if let jsonBody {
            guard JSONSerialization.isValidJSONObject(jsonBody) else {
                throw AgentError.message("WDA/Appium request body is not valid JSON")
            }
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: jsonBody)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AgentError.message("No HTTP response from WDA/Appium")
        }
        if http.statusCode >= 400 {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw AgentError.message("WDA/Appium HTTP \(http.statusCode): \(text)")
        }
        return WdaResponse(status: http.statusCode, headers: http.allHeaderFields, body: data)
    }

    private func ensureSession() async throws -> String {
        if let sessionId {
            return sessionId
        }
        if let existingSession = try await existingSessionId() {
            sessionId = existingSession
            return existingSession
        }
        let body: [String: Any] = [
            "capabilities": ["alwaysMatch": [String: Any]()]
        ]
        let response = try await request(method: "POST", path: "/session", jsonBody: body)
        guard let json = response.jsonObject() else {
            throw AgentError.message("Session response was not JSON")
        }
        if let value = json["value"] as? [String: Any],
           let id = value["sessionId"] as? String {
            sessionId = id
            return id
        }
        if let id = json["sessionId"] as? String {
            sessionId = id
            return id
        }
        throw AgentError.message("WDA/Appium did not return a session id")
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
}

struct WdaResponse {
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

// MARK: - Shared device app bridge (no account or device tokens cross into JavaScript)
@MainActor
extension AgentRuntime {
    var deviceControlAllowed: Bool { AgentSharedConfig.defaults?.bool(forKey: "controlAllowed") == true }
    var deviceConnectionEnabled: Bool {
        guard let defaults = AgentSharedConfig.defaults,
              defaults.object(forKey: AgentSharedConfig.connectionEnabledKey) != nil else { return true }
        return defaults.bool(forKey: AgentSharedConfig.connectionEnabledKey)
    }

    func deviceAppSetup() -> DeviceAppSetup {
        let defaults = AgentSharedConfig.defaults
        return DeviceAppSetup(
            notificationState: notificationState, localNetworkState: localNetworkState,
            vpnState: vpnState, pairingState: pairingState, engineReady: engineReady,
            packetTunnelRemoteXpcState: defaults?.string(forKey: "packetTunnelRemoteXpcState") ?? "",
            mainAppRemoteXpcState: defaults?.string(forKey: "mainAppRemoteXpcState") ?? "",
            activePermissionRequest: activePermissionRequest
        )
    }

    func refreshDeviceAppPermissions() {
        guard didBootstrap else { return }
        refreshPairingNotificationPermission()
        if AgentSharedConfig.defaults?.bool(forKey: "localNetworkRequested") == true,
           localNetworkState != "LOCAL_NETWORK_READY", !systemPermissionRequestInFlight {
            requestLocalNetworkPermission()
        }
    }

    func deviceAppRequest(_ args: [String: Any]) async throws -> [String: Any] {
        let operation = args["operation"] as? String ?? ""
        let mutation = !["snapshot", "devices"].contains(operation)
        if mutation && accountMutationBusy { throw AgentError.message("请等待当前操作完成") }
        if mutation { accountMutationBusy = true }
        defer { if mutation { accountMutationBusy = false } }
        switch operation {
        case "snapshot":
            refreshPairingNotificationPermission()
            let defaults = AgentSharedConfig.defaults
            screenActive = deviceControlAllowed && defaults?.bool(forKey: "screenBroadcastActive") == true
                && Date().timeIntervalSince1970 - (defaults?.double(forKey: "screenBroadcastLastSeenAt") ?? 0) < 15
            let steps = deviceAppSetup().steps
            var result: [String: Any] = ["platform": "ios", "deviceId": deviceId, "displayName": displayName,
                "controllerUrl": controllerUrl, "paired": !agentToken.isEmpty,
                "pairingVerified": appOnline && !agentToken.isEmpty,
                "connectionEnabled": deviceConnectionEnabled,
                "online": appOnline,
                "tunnelOnline": vpnState == "VPN_CONNECTED" &&
                    Date().timeIntervalSince1970 - (AgentSharedConfig.defaults?.double(forKey: "packetTunnelControllerLastSeenAt") ?? 0) < 30,
                "ready": engineReady, "controlAllowed": deviceControlAllowed,
                "screenSharing": screenActive,
                "lastReply": defaults?.string(forKey: "lastReply") ?? "",
                "steps": steps, "error": lastError, "version": buildLabel]
            let pendingAt = defaults?.double(forKey: "pendingPairingAt") ?? 0
            result["pendingPairing"] = agentToken.isEmpty && !pairingCode.isEmpty && pendingAt > 0
                && Date().timeIntervalSince1970 >= pendingAt && Date().timeIntervalSince1970 - pendingAt < 30 * 60
            result["pendingPairingExpired"] = agentToken.isEmpty && !pairingCode.isEmpty && pendingAt > 0
                && Date().timeIntervalSince1970 - pendingAt >= 30 * 60
            result["pendingControllerUrl"] = AgentSharedConfig.defaults?.string(forKey: "pendingControllerUrl") ?? ""
            return result
        case "configure":
            let normalized = try deviceAppOrigin(args["controllerUrl"] as? String ?? "")
            let changing = normalized != (try? deviceAppOrigin(controllerUrl))
            if !agentToken.isEmpty && changing && args["confirmMigration"] as? String != "on" {
                throw AgentError.message("请先确认你信任新的控制服务地址")
            }
            if changing {
                if !agentToken.isEmpty || deviceControlAllowed { await setDeviceAppAccess(false) }
                AgentCredentialStore.delete("accountSession")
            }
            controllerUrl = normalized; persistSharedConfig()
            AgentSharedConfig.defaults?.removeObject(forKey: "pendingControllerUrl")
            lastError = ""
            if !agentToken.isEmpty { start() }
        case "guest":
            guard deviceAppSession().isEmpty else { throw AgentError.message("请先退出当前账号，再确认访客连接") }
            guard let code = AgentSharedConfig.defaults?.string(forKey: "pendingGuestCode"),
                  code.range(of: "^[A-Za-z0-9_-]{32}$", options: .regularExpression) != nil,
                  AgentSharedConfig.defaults?.string(forKey: "pendingGuestOrigin") == controllerUrl else {
                throw AgentError.message("请从控制端重新打开匿名试用连接链接")
            }
            let session = try await deviceAppAPI("/guest/join", body: ["code": code], authenticated: false)
            await setDeviceAppAccess(false)
            try saveDeviceAppSession(session.merging(["origin": controllerUrl]) { _, new in new })
            AgentSharedConfig.defaults?.removeObject(forKey: "pendingGuestCode")
            AgentSharedConfig.defaults?.removeObject(forKey: "pendingGuestOrigin")
        case "login", "register":
            let session = try await deviceAppAPI("/" + operation, body: [
                "username": args["username"] as? String ?? "", "password": args["password"] as? String ?? "",
                "displayName": args["displayName"] as? String ?? ""
            ], authenticated: false)
            await setDeviceAppAccess(false)
            try saveDeviceAppSession(session.merging(["origin": controllerUrl]) { _, new in new })
        case "logout":
            await setDeviceAppAccess(false)
            AgentCredentialStore.delete("accountSession")
        case "devices":
            return try await deviceAppAPI("/devices")
        case "message":
            guard let client = controlClient else { throw AgentError.message("设备尚未连接") }
            return ["messageId": try client.publishInput(text: args["text"] as? String ?? "")]
        case "stagePairingCode":
            guard agentToken.isEmpty else { throw AgentError.message("本机已有配对凭据") }
            _ = try deviceAppOrigin(controllerUrl)
            let code = (args["code"] as? String ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard code.range(of: "^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$", options: .regularExpression) != nil else {
                throw AgentError.message("请输入控制端生成的 8 位一次性配对码")
            }
            pairingCode = code
            AgentSharedConfig.defaults?.set(Date().timeIntervalSince1970, forKey: "pendingPairingAt")
            persistSharedConfig()
            lastError = ""
        case "pair":
            if !agentToken.isEmpty { return [:] }
            if let blocker = deviceAppSetup().prePairingBlocker {
                throw AgentError.message("请先完成配对前准备：\(blocker)")
            }
            let pendingAt = AgentSharedConfig.defaults?.double(forKey: "pendingPairingAt") ?? 0
            guard !pairingCode.isEmpty, pendingAt > 0,
                  Date().timeIntervalSince1970 >= pendingAt,
                  Date().timeIntervalSince1970 - pendingAt < 30 * 60 else {
                pairingCode = ""
                AgentSharedConfig.defaults?.removeObject(forKey: "pendingPairingAt")
                persistSharedConfig()
                throw AgentError.message("配对链接已过期，请从控制端重新打开")
            }
            AgentSharedConfig.defaults?.set(true, forKey: AgentSharedConfig.connectionEnabledKey)
            start()
            let deadline = Date().addingTimeInterval(15)
            while agentToken.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 150_000_000) }
            guard !agentToken.isEmpty else { throw AgentError.message("配对仍在连接中，请检查网络后重试") }
            AgentSharedConfig.defaults?.removeObject(forKey: "pendingPairingAt")
            return [:]
        case "enroll":
            _ = try await deviceAppAPI("/me")
            if agentToken.isEmpty {
                if let blocker = deviceAppSetup().prePairingBlocker {
                    throw AgentError.message("请先完成配对前准备：\(blocker)")
                }
                let response = try await deviceAppAPI("/enroll", body: ["controllerUrl": controllerUrl,
                    "agentKind": "ios", "displayName": displayName])
                guard let session = response["session"] as? [String: Any], let code = session["code"] as? String else {
                    throw AgentError.message("控制端未返回有效配对信息")
                }
                pairingCode = code
                AgentSharedConfig.defaults?.set(true, forKey: AgentSharedConfig.connectionEnabledKey)
                start()
                let deadline = Date().addingTimeInterval(15)
                while agentToken.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 150_000_000) }
                guard !agentToken.isEmpty else { throw AgentError.message("配对仍在连接中，请检查网络后重试") }
            }
            _ = try await deviceAppAPI("/claim", body: ["agentId": agentId, "credential": agentToken])
            var session = deviceAppSession(); session["linkedDeviceId"] = deviceId
            try saveDeviceAppSession(session)
        case "access":
            let allowed = args["allowed"] as? Bool ?? false
            if allowed {
                guard appOnline, !agentToken.isEmpty else {
                    throw AgentError.message("请先完成控制端配对并等待本次连接验证")
                }
            }
            await setDeviceAppAccess(allowed)
        case "connection":
            let enabled = args["enabled"] as? Bool ?? false
            if enabled {
                guard !agentToken.isEmpty else { throw AgentError.message("请先完成首次配对") }
                _ = try deviceAppOrigin(controllerUrl)
                AgentSharedConfig.defaults?.set(true, forKey: AgentSharedConfig.connectionEnabledKey)
                start()
            } else {
                AgentSharedConfig.defaults?.set(false, forKey: AgentSharedConfig.connectionEnabledKey)
                stopPacketTunnel()
                stopScreen()
                stop()
            }
        case "forget":
            // This is an explicit, local-only reset. Server-side revocation is
            // separate; never infer it from a missing or stale local record.
            await setDeviceAppAccess(false)
            stop()
            let recordURL = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: AgentSharedConfig.appGroup
            )?.appendingPathComponent("remote-pairing.plist")
            if let recordURL, FileManager.default.fileExists(atPath: recordURL.path) {
                try FileManager.default.removeItem(at: recordURL)
            }
            agentToken = ""
            agentId = ""
            pairingCode = ""
            controllerUrl = ""
            AgentCredentialStore.delete(AgentCredentialStore.agentTokenAccount)
            AgentCredentialStore.delete(AgentCredentialStore.agentIdAccount)
            AgentCredentialStore.delete(AgentCredentialStore.controllerUrlAccount)
            AgentCredentialStore.delete("accountSession")
            let defaults = AgentSharedConfig.defaults
            defaults?.removeObject(forKey: AgentSharedConfig.connectionEnabledKey)
            for key in ["pendingPairingAt", "pendingControllerUrl", "pendingGuestCode", "pendingGuestOrigin", "lastReply"] {
                defaults?.removeObject(forKey: key)
            }
            persistSharedConfig()
            lastError = ""
        case "action":
            let action = args["action"] as? String ?? ""
            switch action {
            case "notifications": requestPairingNotificationPermission()
            case "network": requestLocalNetworkPermission()
            case "vpn": startPacketTunnel()
            case "pairing": openSystemPairingSettings()
            case "developer": openDeveloperModeSettings()
            case "wda-check": await refreshEngineHealth(); sendStatus()
            case "settings": openAppSettings()
            case "screen-start":
                guard deviceControlAllowed else { throw AgentError.message("请先开启允许接入控制") }
                startScreen()
            case "screen-stop": stopScreen()
            case "reconnect":
                AgentSharedConfig.defaults?.set(true, forKey: AgentSharedConfig.connectionEnabledKey)
                start()
                if deviceControlAllowed && localNetworkState != "LOCAL_NETWORK_DENIED" &&
                    notificationState != "NOTIFICATION_DENIED" { startPacketTunnel() }
            default: throw AgentError.message("不支持的系统操作")
            }
        default: throw AgentError.message("不支持的操作")
        }
        return [:]
    }

    private func setDeviceAppAccess(_ allowed: Bool) async {
        AgentSharedConfig.defaults?.set(allowed, forKey: "controlAllowed")
        AgentSharedConfig.defaults?.synchronize()
        if !allowed {
            engineReady = false
            engineState = "CONTROL_PAUSED"
            lastError = ""
            controlClient?.pauseCommands()
            // Publish revoked consent before awaiting VPN manager discovery.
            // A running Controller automation must not see stale permission.
            controlClient?.stateChanged()
            if let session = tunnelManager?.connection as? NETunnelProviderSession,
               let message = try? JSONSerialization.data(withJSONObject: ["type": "pauseControl"]) {
                try? session.sendProviderMessage(message) { _ in }
            }
            stopPacketTunnel()
            MainAppRemoteXPCBridge.shared.stop()
            stopScreen()
            // A restored manager may not yet be loaded in the foreground runtime.
            // Stop only our extension; do not touch other VPN configurations.
            if let managers = try? await NETunnelProviderManager.loadAllFromPreferences() {
                for manager in managers where (manager.protocolConfiguration as? NETunnelProviderProtocol)?
                    .providerBundleIdentifier == (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel" {
                    manager.connection.stopVPNTunnel()
                }
            }
        } else {
            if !appOnline { start() }
            controlClient?.stateChanged()
        }
    }

    private func deviceAppOrigin(_ raw: String) throws -> String {
        guard let value = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              value.scheme == "https", let host = value.host, !host.isEmpty,
              value.user == nil, value.password == nil, value.query == nil, value.fragment == nil,
              value.path.isEmpty || value.path == "/" else {
            throw AgentError.message("请输入完整的 HTTPS 控制服务地址，不含路径或登录信息")
        }
        return "https://" + host.lowercased() + (value.port == nil || value.port == 443 ? "" : ":\(value.port!)")
    }

    private func deviceAppSession() -> [String: Any] {
        guard let text = AgentCredentialStore.read("accountSession"), let data = text.data(using: .utf8),
              let session = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              session["origin"] as? String == controllerUrl else { return [:] }
        if let expires = session["expiresAt"] as? String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let date = formatter.date(from: expires) ?? ISO8601DateFormatter().date(from: expires)
            if date == nil || date! <= Date() {
                if (session["user"] as? [String: Any])?["mode"] as? String == "guest" {
                    lastError = "20 分钟匿名试用已结束，请注册或登录后继续"
                }
                return [:]
            }
        }
        return session
    }

    private func saveDeviceAppSession(_ session: [String: Any]) throws {
        let text = String(data: try JSONSerialization.data(withJSONObject: session), encoding: .utf8)!
        AgentCredentialStore.write(text, account: "accountSession")
        guard AgentCredentialStore.read("accountSession") == text else { throw AgentError.message("无法安全保存账号，请重试") }
    }

    private func deviceAppAPI(_ path: String, body: [String: Any]? = nil, authenticated: Bool = true) async throws -> [String: Any] {
        let origin = try deviceAppOrigin(controllerUrl)
        var request = URLRequest(url: URL(string: origin + "/account" + path)!)
        request.timeoutInterval = 18
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated {
            guard let token = deviceAppSession()["token"] as? String, !token.isEmpty else {
                throw AgentError.message("请先登录账号")
            }
            request.setValue("Token \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let session = URLSession(configuration: .ephemeral, delegate: DeviceAppNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 1024 * 1024 else { throw AgentError.message("控制服务响应过大") }
            data.append(byte)
        }
        guard let response = response as? HTTPURLResponse,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AgentError.message("控制服务暂时无法访问，请稍后重试")
        }
        guard (200..<300).contains(response.statusCode) else {
            if response.statusCode == 401 && authenticated {
                AgentCredentialStore.delete("accountSession")
            }
            throw AgentError.message(value["error"] as? String ?? "账号服务暂时不可用")
        }
        return value
    }
}

private final class DeviceAppNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum AgentError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let value):
            return value
        }
    }
}

private func intValue(_ value: Any?, defaultValue: Int = 0) -> Int {
    if let value = value as? Int { return value }
    if let value = value as? Double { return Int(value) }
    if let value = value as? String { return Int(value) ?? defaultValue }
    return defaultValue
}

private func stringArray(_ value: Any?, defaultValue: [String]) -> [String] {
    if let values = value as? [String] {
        let normalized = values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return normalized.isEmpty ? defaultValue : normalized
    }
    if let values = value as? [Any] {
        let normalized = values.map { String(describing: $0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return normalized.isEmpty ? defaultValue : normalized
    }
    if let value = value as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return [value.trimmingCharacters(in: .whitespacesAndNewlines)]
    }
    return defaultValue
}
