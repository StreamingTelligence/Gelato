import Foundation
import Network
import NetworkExtension
import CryptoKit
import UserNotifications
import Darwin
import dnssd
import os

private enum PacketTunnelSharedConfig {
    static let appGroup = (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    static let requiredUpdateBuildKey = "requiredUpdateBuild"
    static let updateManifestUrlKey = "updateManifestUrl"
    static let packetTunnelRemoteXpcStateKey = "packetTunnelRemoteXpcState"
    static let runningPacketTunnelBuildKey = "runningPacketTunnelBuild"
    static let stagedWdaPackageName = "GalateaWDA-PureLinux.ipa"
    static let pendingWdaPackageSha256Key = "pendingWdaPackageSha256"
    static let systemPairingPinNotificationIdKey = "systemPairingPinNotificationId"
}

/// A checksum-neutral address swap that makes an iPhone-owned TCP listener
/// reachable from the Packet Tunnel process itself. This is the same topology
/// used by LocalDevVPN: an app connects to 10.7.0.1, packetFlow swaps the two
/// endpoint addresses, and iOS receives the packet at its 10.7.0.0 tunnel
/// address. Swapping (rather than NATing only one endpoint) preserves the IPv4
/// and TCP pseudo-header sums.
private enum DeviceLoopback {
    static let localAddress = LocalDevVPNPacketRecycler.deviceAddress
    static let peerAddress = LocalDevVPNPacketRecycler.fakeAddress
}

final class PacketTunnelProvider: NEPacketTunnelProvider, URLSessionWebSocketDelegate {
    private let logger = Logger(subsystem: (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel", category: "PacketTunnel")
    private var isReadingPackets = false
    private var session: URLSession?
    private var webSocketTask: URLSessionWebSocketTask?
    private var pingTimer: DispatchSourceTimer?
    private var reconnectWorkItem: DispatchWorkItem?
    private var onDeviceWdaProbeTask: Task<Void, Never>?
    private var onDeviceWdaHealthTask: Task<Void, Never>?
    private var mainAppWdaProbeTask: Task<Void, Never>?
    private var persistentControlCommandTail: Task<Void, Never>?
    private var persistentControlTasks: [String: Task<Void, Never>] = [:]
    private var persistentTerminalCache: [String: [String: Any]] = [:]
    private var persistentUploads: [String: PacketTunnelPendingUpload] = [:]
    private var persistentUploadSockets: [String: URLSessionWebSocketTask] = [:]
    private var currentControllerUrl: String?
    private var currentDeviceId: String?
    private var currentAgentToken: String?
    private var currentAgentId: String?
    private var currentClientBuild = "unknown"
    private var currentConfigurationRevision = 0
    private var currentNetworkMode = "unknown"
    private var wdaClient: PacketTunnelWdaClient?
    private var currentPairingProxyState = "bonjourWaiting"
    private var currentPairingProxyPort: UInt16?
    private var currentPairableHostIdentifier: String?
    private var currentRemotePairingState = "browsing"
    private var currentOnDeviceRemoteXpcState = "waitingForPairRecord"
    private var currentRemotePairingService: RemotePairingServiceAdvertisement?
    private var currentVirtualInterfaceIndex: UInt32 = 0
    private var deviceLoopbackPacketsRecycled: UInt64 = 0
    private let pairRecordStateLock = NSLock()
    private var pairRecordReceived = false
    private var tunnelStopped = false
    private var pairingServiceProxy: PairingServiceProxy?
    private var remotePairingServiceBrowser: RemotePairingServiceBrowser?
    private var remotePairingWebSocketProxy: RemotePairingWebSocketProxy?
    private var binarySendQueue: [Data] = []
    private var binarySendQueueBytes = 0
    private var binarySendInFlight = false
    private let queue = DispatchQueue(label: "serverized.packet-tunnel")
    private var controlAllowed: Bool {
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.bool(forKey: "controlAllowed") == true
    }
    private lazy var localDevPacketRecycler = LocalDevVPNPacketRecycler(
        packetFlow: packetFlow
    )

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        guard UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.bool(forKey: "controlAllowed") == true else {
            completionHandler(PacketTunnelControlError.message("Device owner has paused remote control"))
            return
        }
        guard let protocolConfiguration = protocolConfiguration as? NETunnelProviderProtocol,
              let providerConfiguration = protocolConfiguration.providerConfiguration,
              let controllerUrl = providerConfiguration["controllerUrl"] as? String,
              let deviceId = providerConfiguration["deviceId"] as? String,
              let agentId = providerConfiguration["agentId"] as? String,
              let agentToken = providerConfiguration["agentToken"] as? String,
              !controllerUrl.isEmpty,
              !deviceId.isEmpty,
              !agentId.isEmpty,
              !agentToken.isEmpty else {
            completionHandler(PacketTunnelError.missingConfiguration)
            return
        }

        #if GALATEA_LOCALDEV_AB
        startExactLocalDevLoopback(completionHandler: completionHandler)
        return
        #endif

        currentControllerUrl = controllerUrl
        currentDeviceId = deviceId
        currentAgentId = agentId
        currentAgentToken = agentToken
        // The installed extension is authoritative. The provider configuration
        // survives an app update and may still contain the previous build,
        // which must not force the user through VPN authorization again.
        currentClientBuild = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            ?? providerConfiguration["clientBuild"] as? String
            ?? "unknown"
        currentConfigurationRevision = (providerConfiguration["configurationRevision"] as? NSNumber)?.intValue
            ?? providerConfiguration["configurationRevision"] as? Int
            ?? 0
        currentNetworkMode = providerConfiguration["networkMode"] as? String ?? "unknown"
        wdaClient = PacketTunnelWdaClient(
            baseUrl: providerConfiguration["wdaBaseUrl"] as? String ?? "http://127.0.0.1:8100",
            targetBundleId: providerConfiguration["targetBundleId"] as? String
                ?? "dev.galatea.agent",
            targetUdid: providerConfiguration["targetUdid"] as? String
        )
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(
            "idle",
            forKey: "mainAppRemoteXpcState"
        )
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(
            "waitingForPairRecord",
            forKey: PacketTunnelSharedConfig.packetTunnelRemoteXpcStateKey
        )
        tunnelStopped = false

        let settings = LocalDevVPNPacketRecycler.networkSettings()
        setTunnelNetworkSettings(settings) { [weak self] error in
            if let error {
                self?.logger.error("Packet tunnel settings failed: \(error.localizedDescription, privacy: .public)")
                completionHandler(error)
                return
            }
            let build = self?.currentClientBuild ?? "unknown"
            let revision = self?.currentConfigurationRevision ?? 0
            let mode = self?.currentNetworkMode ?? "unknown"
            self?.logger.info(
                "Packet tunnel started build=\(build, privacy: .public) revision=\(revision, privacy: .public) mode=\(mode, privacy: .public)"
            )
            if let self {
                UserDefaults(
                    suiteName: PacketTunnelSharedConfig.appGroup
                )?.set(
                    self.currentClientBuild,
                    forKey: PacketTunnelSharedConfig.runningPacketTunnelBuildKey
                )
                let deviceLoopbackInterface: NWInterface?
                if #available(iOS 18.0, *) {
                    deviceLoopbackInterface = self.virtualInterface
                } else {
                    deviceLoopbackInterface = nil
                }
                guard let deviceLoopbackInterface else {
                    completionHandler(PacketTunnelError.missingVirtualInterface)
                    return
                }
                self.currentVirtualInterfaceIndex = UInt32(
                    deviceLoopbackInterface.index
                )
                self.pairingServiceProxy = PairingServiceProxy(
                    queue: self.queue,
                    log: { [weak self] message in
                        self?.logger.info("\(message, privacy: .public)")
                    },
                    status: { [weak self] state, port in
                        self?.reportPairingProxyStatus(state: state, port: port)
                    }
                )
                self.remotePairingWebSocketProxy = RemotePairingWebSocketProxy(
                    queue: self.queue,
                    requiredInterface: deviceLoopbackInterface,
                    log: { [weak self] message in
                        self?.logger.info("\(message, privacy: .public)")
                    },
                    sendFrame: { [weak self] frame in
                        self?.sendPacket(frame)
                    }
                )
                let browser = RemotePairingServiceBrowser(
                    log: { [weak self] message in
                        self?.logger.info("\(message, privacy: .public)")
                    },
                    status: { [weak self] state, service in
                        self?.reportRemotePairingServiceStatus(
                            state: state,
                            service: service
                        )
                    }
                )
                self.remotePairingServiceBrowser = browser
                browser.start()
            }
            self?.connectWebSocket(controllerUrl: controllerUrl, deviceId: deviceId, agentToken: agentToken)
            self?.startReadingPackets()
            completionHandler(nil)
        }
    }

    /// Diagnostic control that deliberately contains no Controller socket,
    /// Bonjour browser, RemotePairing proxy, or WDA client. It isolates the
    /// packet recycler from every other NetworkExtension activity.
    private func startExactLocalDevLoopback(
        completionHandler: @escaping (Error?) -> Void
    ) {
        setTunnelNetworkSettings(
            LocalDevVPNPacketRecycler.networkSettings()
        ) { [weak self] error in
            guard error == nil else {
                completionHandler(error)
                return
            }
            self?.localDevPacketRecycler.startExclusiveLoop()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.removeObject(forKey: "packetTunnelControllerLastSeenAt")
        tunnelStopped = true
        isReadingPackets = false
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        pingTimer?.cancel()
        pingTimer = nil
        onDeviceWdaProbeTask?.cancel()
        onDeviceWdaProbeTask = nil
        onDeviceWdaHealthTask?.cancel()
        onDeviceWdaHealthTask = nil
        mainAppWdaProbeTask?.cancel()
        mainAppWdaProbeTask = nil
        persistentControlCommandTail?.cancel()
        persistentControlCommandTail = nil
        persistentControlTasks.values.forEach { $0.cancel() }
        persistentControlTasks.removeAll()
        persistentTerminalCache.removeAll()
        persistentUploadSockets.values.forEach {
            $0.cancel(with: .goingAway, reason: nil)
        }
        persistentUploadSockets.removeAll()
        persistentUploads.removeAll()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        binarySendQueue.removeAll(keepingCapacity: false)
        binarySendQueueBytes = 0
        binarySendInFlight = false
        session?.invalidateAndCancel()
        session = nil
        pairingServiceProxy?.stop()
        pairingServiceProxy = nil
        remotePairingServiceBrowser?.stop()
        remotePairingServiceBrowser = nil
        remotePairingWebSocketProxy?.stop()
        remotePairingWebSocketProxy = nil
        OnDeviceRemoteXPCBridge.shared.stop()
        wdaClient = nil
        logger.info("Packet tunnel stopped: \(String(describing: reason), privacy: .public)")
        completionHandler()
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        queue.async { [weak self] in
            guard let self else {
                completionHandler?(nil)
                return
            }
            if let message = try? JSONSerialization.jsonObject(
                with: messageData
            ) as? [String: Any], let type = message["type"] as? String {
                if type == "installStagedWda" {
                    self.restartOnDeviceWdaForStagedPackage()
                    completionHandler?(try? JSONSerialization.data(
                        withJSONObject: ["accepted": true]
                    ))
                    return
                }
                if type == "pauseControl" {
                    self.pausePersistentControl()
                    completionHandler?(try? JSONSerialization.data(
                        withJSONObject: ["accepted": true]
                    ))
                    return
                }
            }
            var status: [String: Any] = [
                "clientBuild": self.currentClientBuild,
                "configurationRevision": self.currentConfigurationRevision,
                "networkMode": self.currentNetworkMode,
                "pairingProxyState": self.currentPairingProxyState
            ]
            if let port = self.currentPairingProxyPort {
                status["pairingProxyPort"] = Int(port)
            }
            if let identifier = self.currentPairableHostIdentifier {
                status["pairableHostIdentifier"] = identifier
            }
            status["remotePairingState"] = self.currentRemotePairingState
            status["onDeviceRemoteXpcState"] = self.currentOnDeviceRemoteXpcState
            status["mainAppRemoteXpcState"] = UserDefaults(
                suiteName: PacketTunnelSharedConfig.appGroup
            )?.string(forKey: "mainAppRemoteXpcState") ?? "unknown"
            status["remotePairingTransport"] = "deviceLoopback"
            status["remotePairingLoopbackAddress"] = DeviceLoopback.peerAddress
            status["remotePairingLoopbackPackets"] = self.deviceLoopbackPacketsRecycled
            if let service = self.currentRemotePairingService {
                status["remotePairingIdentifier"] = service.identifier
                status["remotePairingPort"] = Int(service.port)
            }
            completionHandler?(try? JSONSerialization.data(withJSONObject: status))
        }
    }

    private func pausePersistentControl() {
        // Update this process's App Group view before any queued task or
        // snapshot can re-read an outdated cross-process preference value.
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(false, forKey: "controlAllowed")
        persistentControlCommandTail?.cancel()
        persistentControlCommandTail = nil
        for (commandId, task) in persistentControlTasks {
            task.cancel()
            sendPersistentTerminal(type: "command.error", commandId: commandId,
                body: ["error": "Device owner has paused remote control", "cancelled": true])
        }
        persistentControlTasks.removeAll()
        for upload in persistentUploads.values {
            sendPersistentTerminal(type: "command.error", commandId: upload.commandId,
                body: ["error": "Device owner has paused remote control", "cancelled": true])
        }
        persistentUploads.removeAll()
        persistentUploadSockets.values.forEach { $0.cancel(with: .goingAway, reason: nil) }
        persistentUploadSockets.removeAll()
        // Ask the Controller for a fresh snapshot while this socket still
        // exists. The shared consent bit was written by the containing app.
        if let deviceId = currentDeviceId {
            sendDeviceAgentPayload(["protocol": "gelato.v1", "type": "capabilities.changed",
                "messageId": "msg_\(Self.randomId())", "deviceId": deviceId,
                "sentAt": ISO8601DateFormatter().string(from: Date()), "body": [:]])
        }
    }

    private func startReadingPackets() {
        guard !isReadingPackets else { return }
        isReadingPackets = true
        readPackets()
    }

    private func readPackets() {
        guard isReadingPackets else { return }
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            for (index, packet) in packets.enumerated() {
                let protocolNumber = index < protocols.count
                    ? protocols[index]
                    : NSNumber(value: self.packetProtocol(packet))
                if !self.recycleDeviceLoopbackPacket(
                    packet,
                    protocolNumber: protocolNumber
                ) {
                    self.sendPacket(packet)
                }
            }
            self.readPackets()
        }
    }

    /// Returns true when the packet belongs to the device-local RemotePairing
    /// loop and has been reinjected locally instead of crossing the public
    /// packet overlay.
    private func recycleDeviceLoopbackPacket(
        _ packet: Data,
        protocolNumber: NSNumber
    ) -> Bool {
        guard localDevPacketRecycler.recycle(
            packet,
            protocolNumber: protocolNumber
        ) else {
            return false
        }
        deviceLoopbackPacketsRecycled &+= 1
        if deviceLoopbackPacketsRecycled == 1
            || deviceLoopbackPacketsRecycled.isMultiple(of: 32) {
            logger.info(
                "Device-loopback packet recycling active count=\(self.deviceLoopbackPacketsRecycled, privacy: .public)"
            )
            sendRemotePairingServiceStatus()
        }
        return true
    }

    private func connectWebSocket(controllerUrl: String, deviceId: String, agentToken: String) {
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        pingTimer?.cancel()
        pingTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        session?.invalidateAndCancel()
        session = nil

        guard let url = overlayWebSocketUrl(controllerUrl: controllerUrl, deviceId: deviceId) else {
            logger.error("Invalid overlay WebSocket URL from \(controllerUrl, privacy: .public)")
            cancelTunnelWithError(PacketTunnelError.invalidControllerUrl)
            return
        }
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 0
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue("Bearer \(agentToken)", forHTTPHeaderField: "Authorization")
        request.setValue(currentAgentId ?? "", forHTTPHeaderField: "X-Agent-Id")
        let task = session.webSocketTask(with: request)
        self.session = session
        webSocketTask = task
        task.resume()
        let endpoint = "\(url.host ?? "unknown")\(url.path)"
        logger.info("Packet overlay WebSocket connecting to \(endpoint, privacy: .public)")
        receiveWebSocket()
        startPingTimer()
    }

    private func sendPacket(_ packet: Data) {
        guard !packet.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, self.controlAllowed, self.webSocketTask != nil else { return }
            guard self.binarySendQueue.count < 8192,
                  self.binarySendQueueBytes + packet.count <= 64 * 1024 * 1024 else {
                self.logger.error("Packet overlay send queue exceeded its safety limit")
                self.scheduleReconnect(reason: "send queue overflow")
                return
            }
            self.binarySendQueue.append(packet)
            self.binarySendQueueBytes += packet.count
            self.sendNextBinaryFrame()
        }
    }

    private func sendNextBinaryFrame() {
        guard controlAllowed else {
            binarySendQueue.removeAll()
            binarySendQueueBytes = 0
            return
        }
        guard !binarySendInFlight,
              let task = webSocketTask,
              !binarySendQueue.isEmpty else {
            return
        }
        let packet = binarySendQueue.removeFirst()
        binarySendQueueBytes -= packet.count
        binarySendInFlight = true
        task.send(.data(packet)) { [weak self, weak task] error in
            guard let self, let task else { return }
            self.queue.async {
                guard task === self.webSocketTask else { return }
                self.binarySendInFlight = false
                if let error {
                    self.logger.error(
                        "Packet overlay send failed: \(error.localizedDescription, privacy: .public)"
                    )
                    self.scheduleReconnect(reason: "send failed")
                    return
                }
                self.sendNextBinaryFrame()
            }
        }
    }

    private func receiveWebSocket() {
        guard let task = webSocketTask else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    // Closing the VPN is asynchronous. Never process queued
                    // RemoteXPC traffic after the owner's switch is off.
                    guard self.controlAllowed else { return }
                    let targetPort = self.currentRemotePairingService?.port ?? 49152
                    if OnDeviceRemoteXPCBridge.shared.consumePairRecordFrame(
                        data,
                        port: targetPort,
                        interfaceIndex: self.currentVirtualInterfaceIndex,
                        sendFrame: { [weak self] frame in
                            self?.sendPacket(frame)
                        },
                        status: { [weak self] state in
                            self?.queue.async {
                                self?.acceptOnDeviceRemoteXpcState(state)
                            }
                        }
                    ) {
                        self.markPairRecordReceived()
                        self.sendPacket(
                            OnDeviceRemoteXPCBridge.pairRecordAcknowledgement
                        )
                        self.logger.info("Received on-device RemotePairing credentials")
                    } else if OnDeviceRemoteXPCBridge.shared
                        .handleRawTunnelFrame(
                            data,
                            sendFrame: { [weak self] frame in
                                self?.sendPacket(frame)
                            }
                        ) {
                        // Raw RemoteXPC IPv6 is terminated by the Linux TUN.
                    } else if self.remotePairingWebSocketProxy?.handleFrame(data) != true {
                        self.writePacketToFlow(data)
                    }
                case .string(let text):
                    if !self.handleOverlayControlMessage(text) {
                        self.logger.debug("Packet overlay control message received")
                    }
                @unknown default:
                    break
                }
                self.receiveWebSocket()
            case .failure(let error):
                self.logger.error("Packet overlay receive failed: \(error.localizedDescription, privacy: .public)")
                self.scheduleReconnect(reason: "receive failed")
            }
        }
    }

    private func handleOverlayControlMessage(_ text: String) -> Bool {
        guard let data = text.data(using: .utf8),
              let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else {
            return false
        }
        if message["protocol"] as? String == "gelato.v1" {
            if type == "device.snapshot.request",
               let body = message["body"] as? [String: Any],
               let revision = body["revision"] as? Int {
                sendPersistentSnapshot(revision: revision)
            } else if type == "command.request" {
                handleDeviceAgentCommand(message)
            } else if type == "reply.deliver",
                      message["deviceId"] as? String == currentDeviceId,
                      let body = message["body"] as? [String: Any],
                      let text = body["text"] as? String, !text.isEmpty, text.count <= 32_768,
                      let replyMessageId = message["messageId"] as? String,
                      let deviceId = currentDeviceId {
                UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(text, forKey: "lastReply")
                sendDeviceAgentPayload(["protocol": "gelato.v1", "type": "reply.ack",
                    "messageId": "msg_\(Self.randomId())", "deviceId": deviceId,
                    "sentAt": ISO8601DateFormatter().string(from: Date()),
                    "body": ["replyMessageId": replyMessageId]])
            } else if type == "stream.accept",
                      let body = message["body"] as? [String: Any],
                      let streamId = body["streamId"] as? String {
                beginPersistentUpload(streamId)
            } else if type == "command.cancel",
                      let commandId = message["commandId"] as? String
                        ?? (message["body"] as? [String: Any])?["commandId"] as? String {
                persistentControlTasks[commandId]?.cancel()
                // Capture tasks finish after offering a stream. Their upload
                // can still be active when the command's deadline expires.
                let uploads = persistentUploads.filter { $0.value.commandId == commandId }.map(\.key)
                for streamId in uploads {
                    persistentUploads.removeValue(forKey: streamId)
                    persistentUploadSockets.removeValue(forKey: streamId)?.cancel(with: .goingAway, reason: nil)
                }
                if !uploads.isEmpty {
                    sendPersistentTerminal(type: "command.error", commandId: commandId,
                        body: ["error": "Command cancelled", "cancelled": true])
                }
            }
            return true
        }
        return false
    }

    private func handleDeviceAgentCommand(_ message: [String: Any]) {
        guard let commandId = message["commandId"] as? String,
              let body = message["body"] as? [String: Any],
              let capability = body["capability"] as? String else { return }
        guard UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.bool(forKey: "controlAllowed") == true || capability == "device.describe" else {
            sendPersistentTerminal(type: "command.error", commandId: commandId,
                body: ["error": "Device owner has paused remote control", "cancelled": false])
            return
        }
        guard message["deviceId"] as? String == currentDeviceId,
              commandId.range(of: #"^cmd_[A-Za-z0-9_-]{10,80}$"#, options: .regularExpression) != nil else {
            return
        }
        if let cached = persistentTerminalCache[commandId] {
            sendDeviceAgentPayload(cached)
            return
        }
        if persistentControlTasks[commandId] != nil {
            return
        }
        let version = body["capabilityVersion"] as? Int ?? 1
        guard version == 1 else {
            sendPersistentTerminal(
                type: "command.error",
                commandId: commandId,
                body: ["error": "Capability is not advertised: \(capability)@\(version)", "cancelled": false]
            )
            return
        }
        if let deadlineText = body["deadline"] as? String,
           let deadline = Self.iso8601Date(deadlineText),
           deadline <= Date() {
            sendPersistentTerminal(
                type: "command.error",
                commandId: commandId,
                body: ["error": "Command deadline has expired", "cancelled": true]
            )
            return
        }
        let arguments = body["arguments"] as? [String: Any] ?? [:]
        sendDeviceAgentEnvelope(
            type: "command.progress",
            commandId: commandId,
            body: ["stage": "accepted", "progress": 0]
        )
        let previous = persistentControlCommandTail
        let task = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            defer {
                self.queue.async { [weak self] in
                    self?.persistentControlTasks.removeValue(forKey: commandId)
                }
            }
            guard !Task.isCancelled else {
                self.sendPersistentTerminal(
                    type: "command.error",
                    commandId: commandId,
                    body: ["error": "Command cancelled", "cancelled": true]
                )
                return
            }
            do {
                let command = try self.mapDeviceAgentCapability(capability, arguments: arguments)
                guard UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.bool(forKey: "controlAllowed") == true || capability == "device.describe" else {
                    throw PacketTunnelControlError.message("Device owner has paused remote control")
                }
                let result = try await self.executePersistentControlCommand(command, wdaClient: self.wdaClient)
                try Task.checkCancellation()
                if capability == "screen.capture",
                   let encoded = result["base64"] as? String,
                   let bytes = Data(base64Encoded: encoded) {
                    var metadata = result
                    metadata.removeValue(forKey: "base64")
                    self.offerPersistentUpload(
                        commandId: commandId,
                        purpose: "screen",
                        contentType: result["mimeType"] as? String ?? "image/png",
                        bytes: bytes,
                        result: metadata
                    )
                } else {
                    self.sendPersistentTerminal(
                        type: "command.result",
                        commandId: commandId,
                        body: ["result": result]
                    )
                }
            } catch is CancellationError {
                self.sendPersistentTerminal(
                    type: "command.error",
                    commandId: commandId,
                    body: ["error": "Command cancelled", "cancelled": true]
                )
            } catch {
                self.sendPersistentTerminal(
                    type: "command.error",
                    commandId: commandId,
                    body: ["error": error.localizedDescription, "cancelled": false]
                )
            }
        }
        persistentControlCommandTail = task
        persistentControlTasks[commandId] = task
    }

    private func mapDeviceAgentCapability(
        _ capability: String,
        arguments: [String: Any]
    ) throws -> [String: Any] {
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
        case "device.system-pairing.confirm": command["type"] = "confirmSystemPairing"
        case "device.system-pairing.pin.show": command["type"] = "showSystemPairingPin"
        case "agent.update.require": command["type"] = "requireAgentUpdate"
        default:
            throw PacketTunnelControlError.message(
                "Capability is unavailable through the Packet Tunnel driver: \(capability)"
            )
        }
        return command
    }

    /// The foreground app and Packet Tunnel share one device-side connection.
    /// Keep the background transport feature-complete for the
    /// portable control surface instead of advertising foreground-only
    /// capabilities that fail as soon as iOS suspends the app.
    private func offerPersistentUpload(
        commandId: String,
        purpose: String,
        contentType: String,
        bytes: Data,
        result: [String: Any]
    ) {
        guard controlAllowed else { return }
        let streamId = "str_\(Self.randomId())"
        persistentUploads[streamId] = PacketTunnelPendingUpload(
            commandId: commandId,
            purpose: purpose,
            contentType: contentType,
            bytes: bytes,
            result: result
        )
        sendDeviceAgentEnvelope(
            type: "stream.offer",
            commandId: commandId,
            body: [
                "streamId": streamId,
                "commandId": commandId,
                "purpose": purpose,
                "direction": "agent-to-controller",
                "contentType": contentType,
                "maxFrameBytes": 262_144,
                "maxTotalBytes": max(bytes.count, 1),
                "expectedBytes": bytes.count
            ]
        )
    }

    private func beginPersistentUpload(_ streamId: String) {
        guard controlAllowed, let pending = persistentUploads[streamId],
              persistentUploadSockets[streamId] == nil,
              let controllerUrl = currentControllerUrl,
              let agentToken = currentAgentToken,
              let agentId = currentAgentId,
              let url = streamWebSocketUrl(
                controllerUrl: controllerUrl,
                streamId: streamId
              ) else {
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(agentToken)", forHTTPHeaderField: "Authorization")
        request.setValue(agentId, forHTTPHeaderField: "X-Agent-Id")
        let socket = URLSession.shared.webSocketTask(with: request)
        persistentUploadSockets[streamId] = socket
        socket.resume()

        func receive() {
            socket.receive { [weak self] response in
                guard let self else { return }
                guard self.controlAllowed else { socket.cancel(with: .goingAway, reason: nil); return }
                switch response {
                case .failure(let error):
                    self.queue.async {
                        self.persistentUploadSockets.removeValue(forKey: streamId)
                        self.persistentUploads.removeValue(forKey: streamId)
                        self.sendPersistentTerminal(
                            type: "command.error",
                            commandId: pending.commandId,
                            body: [
                                "error": "Stream upload failed: \(error.localizedDescription)",
                                "cancelled": false
                            ]
                        )
                    }
                case .success(let message):
                    guard case .string(let text) = message,
                          let data = text.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: data)
                            as? [String: Any],
                          let type = json["type"] as? String else {
                        receive()
                        return
                    }
                    if type == "stream.ready" {
                        var sequence: UInt32 = 0
                        var offset = 0
                        while offset < pending.bytes.count {
                            guard self.controlAllowed else { socket.cancel(with: .goingAway, reason: nil); return }
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
                        self.queue.async {
                            self.persistentUploadSockets.removeValue(forKey: streamId)
                            self.persistentUploads.removeValue(forKey: streamId)
                            var result = pending.result
                            result["stream"] = [
                                "streamId": streamId,
                                "purpose": pending.purpose,
                                "contentType": pending.contentType,
                                "sizeBytes": pending.bytes.count,
                                "sha256": json["sha256"] as? String ?? ""
                            ]
                            self.sendPersistentTerminal(
                                type: "command.result",
                                commandId: pending.commandId,
                                body: ["result": result]
                            )
                            socket.cancel(with: .normalClosure, reason: nil)
                        }
                        return
                    }
                    receive()
                }
            }
        }
        receive()
    }

    private func sendDeviceAgentEnvelope(
        type: String,
        commandId: String,
        body: [String: Any]
    ) {
        guard let deviceId = currentDeviceId else { return }
        let payload: [String: Any] = [
            "protocol": "gelato.v1",
            "type": type,
            "messageId": "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
            "deviceId": deviceId,
            "commandId": commandId,
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "body": body
        ]
        sendDeviceAgentPayload(payload)
    }

    private func sendPersistentTerminal(
        type: String,
        commandId: String,
        body: [String: Any]
    ) {
        // A late URLSession completion must not overwrite cancellation.
        guard persistentTerminalCache[commandId] == nil else { return }
        guard let deviceId = currentDeviceId else { return }
        let payload: [String: Any] = [
            "protocol": "gelato.v1",
            "type": type,
            "messageId": "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
            "deviceId": deviceId,
            "commandId": commandId,
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "body": body
        ]
        persistentTerminalCache[commandId] = payload
        if persistentTerminalCache.count > 128, let oldest = persistentTerminalCache.keys.first {
            persistentTerminalCache.removeValue(forKey: oldest)
        }
        sendDeviceAgentPayload(payload)
    }

    private func sendDeviceAgentLease() {
        guard let deviceId = currentDeviceId else { return }
        sendDeviceAgentPayload([
            "protocol": "gelato.v1",
            "type": "lease.renew",
            "messageId": "msg_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
            "deviceId": deviceId,
            "sentAt": ISO8601DateFormatter().string(from: Date()),
            "body": [:]
        ])
    }

    private func sendPersistentSnapshot(revision: Int) {
        guard revision >= 0, let deviceId = currentDeviceId,
              let defaults = UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup),
              let data = defaults.data(forKey: "deviceAgentSnapshot"),
              var snapshot = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let version = ProcessInfo.processInfo.operatingSystemVersion
        snapshot["revision"] = revision
        snapshot["os"] = ["family": "ios", "version": "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"]
        let mainState = defaults.string(forKey: "mainAppRemoteXpcState") ?? ""
        let ready = controlAllowed && (currentOnDeviceRemoteXpcState == "wdaReady" || mainState == "wdaReady")
        snapshot["driver"] = ["id": "ios.wda-remotexpc", "version": "1", "location": "device",
            "state": ready ? "ready" : "degraded", "error": ready ? NSNull() : "WDA is not ready"] as [String: Any]
        var hardware = snapshot["hardware"] as? [String: Any] ?? [:]
        hardware["controlAllowed"] = controlAllowed
        hardware["present"] = true
        hardware["connected"] = true
        hardware["vpnState"] = "VPN_CONNECTED"
        hardware["remotePairingState"] = currentRemotePairingState
        hardware["pairingState"] = ready ? "PAIRING_COMPLETE" : "PAIRING_WAITING_FOR_PROXY"
        hardware["userAction"] = NSNull()
        snapshot["hardware"] = hardware
        sendDeviceAgentPayload(["protocol": "gelato.v1", "type": "device.snapshot",
            "messageId": "msg_\(Self.randomId())", "deviceId": deviceId,
            "sentAt": ISO8601DateFormatter().string(from: Date()), "body": snapshot])
    }

    private func sendDeviceAgentPayload(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocketTask?.send(.string(text)) { [weak self] error in
            if let error {
                self?.logger.error("Device result send failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func executePersistentControlCommand(
        _ command: [String: Any],
        wdaClient: PacketTunnelWdaClient?
    ) async throws -> [String: Any] {
        guard let type = command["type"] as? String else {
            throw PacketTunnelControlError.message("Missing command type")
        }
        switch type {
        case "status":
            let version = ProcessInfo.processInfo.operatingSystemVersion
            let osVersion = "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
            return [
                "snapshot": [
                    "kind": "apple.iphone",
                    "displayName": "iPhone",
                    "os": ["family": "ios", "version": osVersion],
                    "driver": [
                        "id": "ios.wda-remotexpc",
                        "version": "1",
                        "location": "device",
                        "state": currentOnDeviceRemoteXpcState == "wdaReady"
                            ? "ready" : "degraded"
                    ],
                    "hardware": [
                        "controlAllowed": UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.bool(forKey: "controlAllowed") == true,
                        "present": true,
                        "connected": true,
                        "vpnState": "VPN_CONNECTED",
                        "remotePairingState": currentRemotePairingState,
                        "userAction": NSNull()
                    ],
                    "transport": "ios-packet-tunnel",
                    "agentBuild": currentClientBuild
                ]
            ]
        case "stageWdaPackage":
            return try await stageWdaPackage(command)
        case "wdaHttpRequest":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            let method = command["method"] as? String ?? "GET"
            let path = command["path"] as? String ?? "/status"
            let rawBody = command["body"]
            let body = rawBody is NSNull ? nil : rawBody
            let response = try await wdaClient.request(
                method: method,
                path: path,
                jsonBody: body
            )
            return response.toCommandResult()
        case "tap":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            try await wdaClient.tap(
                x: packetTunnelIntValue(command["x"]),
                y: packetTunnelIntValue(command["y"])
            )
            return ["type": "tap", "output": "ok"]
        case "swipe":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            try await wdaClient.swipe(
                fromX: packetTunnelIntValue(command["fromX"]),
                fromY: packetTunnelIntValue(command["fromY"]),
                toX: packetTunnelIntValue(command["toX"]),
                toY: packetTunnelIntValue(command["toY"]),
                durationMs: packetTunnelIntValue(
                    command["durationMs"],
                    defaultValue: 450
                )
            )
            return ["type": "swipe", "output": "ok"]
        case "typeText":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            try await wdaClient.typeText(command["text"] as? String ?? "")
            return ["type": "typeText", "output": "ok"]
        case "launchApp":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            let appId = command["appId"] as? String
                ?? command["bundleId"] as? String
                ?? ""
            try await wdaClient.launchApp(appId)
            return ["type": "launchApp", "output": "ok"]
        case "getScreenshot":
            let base64: String
            if OnDeviceRemoteXPCBridge.shared.isReady {
                base64 = try await OnDeviceRemoteXPCBridge.shared
                    .screenshot()
                    .base64EncodedString()
            } else if let wdaClient {
                base64 = try await wdaClient.screenshot()
            } else {
                throw PacketTunnelControlError.message(
                    "Neither on-device RemoteXPC nor WDA is connected"
                )
            }
            return [
                "type": "screenshot",
                "mimeType": "image/png",
                "base64": base64
            ]
        case "getUiTree":
            guard let wdaClient else {
                throw PacketTunnelControlError.message("WDA is not connected")
            }
            let source = try await wdaClient.source()
            return ["type": "uitree", "output": source]
        case "showSystemPairingPin":
            try await showSystemPairingPin(command)
            return ["accepted": true]
        case "confirmSystemPairing":
            clearSystemPairingPinNotification()
            return ["accepted": true]
        case "requireAgentUpdate":
            guard let requiredBuild = command["requiredBuild"] as? String,
                  Int(requiredBuild) != nil,
                  let defaults = UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup) else {
                throw PacketTunnelControlError.message("Update policy is invalid")
            }
            defaults.set(requiredBuild, forKey: PacketTunnelSharedConfig.requiredUpdateBuildKey)
            if let manifestUrl = command["manifestUrl"] as? String {
                defaults.set(manifestUrl, forKey: PacketTunnelSharedConfig.updateManifestUrlKey)
            }
            defaults.synchronize()
            return ["accepted": true, "requiredBuild": requiredBuild]
        default:
            throw PacketTunnelControlError.message(
                "Unsupported persistent control command: \(type)"
            )
        }
    }

    private func stageWdaPackage(_ command: [String: Any]) async throws -> [String: Any] {
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
            throw PacketTunnelControlError.message("WDA package stream metadata is invalid")
        }
        guard let controllerUrl = currentControllerUrl,
              let agentToken = currentAgentToken,
              let agentId = currentAgentId,
              let deviceId = currentDeviceId,
              let base = URL(string: controllerUrl),
              let packageUrl = URL(string: path, relativeTo: base)?.absoluteURL,
              packageUrl.scheme == base.scheme,
              packageUrl.host == base.host,
              packageUrl.port == base.port,
              packageUrl.user == nil,
              packageUrl.password == nil,
              packageUrl.query == nil,
              packageUrl.fragment == nil else {
            throw PacketTunnelControlError.message("WDA package stream URL is invalid")
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
            throw PacketTunnelControlError.message("WDA package stream download failed")
        }
        let actualSha = SHA256.hash(data: bytes)
            .map { String(format: "%02x", $0) }
            .joined()
        guard actualSha == expectedSha else {
            throw PacketTunnelControlError.message("WDA package checksum mismatch")
        }
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: PacketTunnelSharedConfig.appGroup
        ) else {
            throw PacketTunnelControlError.message("App Group container is unavailable")
        }
        let package = container.appendingPathComponent(
            PacketTunnelSharedConfig.stagedWdaPackageName
        )
        try bytes.write(to: package, options: [.atomic])
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: package.path
        )
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(
            expectedSha,
            forKey: PacketTunnelSharedConfig.pendingWdaPackageSha256Key
        )
        restartOnDeviceWdaForStagedPackage()
        return [
            "type": "stageWdaPackage",
            "accepted": true,
            "sha256": expectedSha,
            "bytes": bytes.count
        ]
    }

    private func restartOnDeviceWdaForStagedPackage() {
        guard let port = currentRemotePairingService?.port else {
            acceptOnDeviceRemoteXpcState("wdaInstallWaitingForRemotePairing")
            return
        }
        acceptOnDeviceRemoteXpcState("wdaInstallRequested")
        OnDeviceRemoteXPCBridge.shared.restartForStagedWda(
            port: port,
            interfaceIndex: currentVirtualInterfaceIndex,
            status: { [weak self] state in
                self?.queue.async {
                    self?.acceptOnDeviceRemoteXpcState(state)
                }
            }
        )
    }

    private func showSystemPairingPin(_ message: [String: Any]) async throws {
        guard let pin = message["pin"] as? String,
              pin.count == 6,
              pin.allSatisfy(\.isNumber) else {
            throw PacketTunnelControlError.message("A six-digit pairing PIN is required")
        }
        let expiresAt: Double
        if let value = message["expiresAt"] as? Double {
            expiresAt = value
        } else if let value = message["expiresAt"] as? NSNumber {
            expiresAt = value.doubleValue
        } else {
            throw PacketTunnelControlError.message("Pairing PIN expiry is missing")
        }
        // The Controller already enforces the five-minute window. Comparing
        // its absolute deadline with the iPhone clock rejects a fresh PIN
        // when the two clocks differ even slightly.
        guard expiresAt.isFinite, expiresAt > 0 else {
            throw PacketTunnelControlError.message("Pairing PIN expiry is invalid")
        }

        let center = UNUserNotificationCenter.current()
        let defaults = UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)
        var previousIds = ["serverized-system-pairing-pin"]
        if let previousId = defaults?.string(
            forKey: PacketTunnelSharedConfig.systemPairingPinNotificationIdKey
        ) {
            previousIds.append(previousId)
        }
        center.removePendingNotificationRequests(withIdentifiers: previousIds)
        center.removeDeliveredNotifications(withIdentifiers: previousIds)
        defaults?.removeObject(forKey: PacketTunnelSharedConfig.systemPairingPinNotificationIdKey)
        let content = UNMutableNotificationContent()
        content.title = "iPhone 配对码"
        content.body = "\(pin) · 5 分钟内有效"
        content.sound = .default
        content.threadIdentifier = "serverized-system-pairing"
        let notificationId = "serverized-system-pairing-pin-\(UUID().uuidString)"
        try await center.add(
            UNNotificationRequest(identifier: notificationId, content: content, trigger: nil)
        )
        defaults?.set(notificationId, forKey: PacketTunnelSharedConfig.systemPairingPinNotificationIdKey)
        logger.info("Scheduled a system pairing PIN notification")
    }

    private func clearSystemPairingPinNotification() {
        let defaults = UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)
        var identifiers = ["serverized-system-pairing-pin"]
        if let notificationId = defaults?.string(
            forKey: PacketTunnelSharedConfig.systemPairingPinNotificationIdKey
        ) {
            identifiers.append(notificationId)
        }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
        defaults?.removeObject(forKey: PacketTunnelSharedConfig.systemPairingPinNotificationIdKey)
    }

    private func writePacketToFlow(_ packet: Data) {
        guard !packet.isEmpty else { return }
        if let advertisement = PairableHostMDNSParser.parse(packet) {
            currentPairableHostIdentifier = advertisement.identifier
            pairingServiceProxy?.update(advertisement)
        }
        let protocolNumber = packetProtocol(packet)
        packetFlow.writePackets([packet], withProtocols: [NSNumber(value: protocolNumber)])
    }

    private func reportPairingProxyStatus(state: String, port: UInt16?) {
        currentPairingProxyState = state
        currentPairingProxyPort = port
        sendPairingProxyStatus()
    }

    private func sendPairingProxyStatus() {
        guard let task = webSocketTask else { return }
        var payload: [String: Any] = [
            "type": "pairingProxyStatus",
            "state": currentPairingProxyState
        ]
        if let port = currentPairingProxyPort { payload["port"] = Int(port) }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        task.send(.string(text)) { [weak self] error in
            if let error {
                self?.logger.error("Pairing proxy status send failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func reportRemotePairingServiceStatus(
        state: String,
        service: RemotePairingServiceAdvertisement?
    ) {
        queue.async { [weak self] in
            guard let self else { return }
            self.currentRemotePairingState = state
            self.currentRemotePairingService = state == "ready" ? service : nil
            self.remotePairingWebSocketProxy?.update(
                self.currentRemotePairingService
            )
            if let port = self.currentRemotePairingService?.port {
                OnDeviceRemoteXPCBridge.shared.startIfAvailable(
                    port: port,
                    interfaceIndex: self.currentVirtualInterfaceIndex,
                    sendFrame: { [weak self] frame in
                        self?.sendPacket(frame)
                    },
                    status: { [weak self] bridgeState in
                        self?.queue.async {
                            self?.acceptOnDeviceRemoteXpcState(bridgeState)
                        }
                    }
                )
            }
            self.sendRemotePairingServiceStatus()
        }
    }

    private func acceptOnDeviceRemoteXpcState(_ state: String) {
        currentOnDeviceRemoteXpcState = state
        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(
            state,
            forKey: PacketTunnelSharedConfig.packetTunnelRemoteXpcStateKey
        )
        logger.info(
            "On-device RemoteXPC state=\(state, privacy: .public)"
        )
        if state == "wdaStarting" {
            startWdaReadinessProbe()
        }
        sendRemotePairingServiceStatus()
    }

    private func startWdaReadinessProbe() {
        onDeviceWdaProbeTask?.cancel()
        guard let wdaClient else {
            acceptOnDeviceRemoteXpcState("wdaProbeError:missingClient")
            return
        }
        onDeviceWdaProbeTask = Task { [weak self] in
            var lastError = "notReady"
            for attempt in 1...60 {
                guard !Task.isCancelled else { return }
                do {
                    try await wdaClient.probeStatus()
                    self?.queue.async {
                        guard let self,
                              self.currentOnDeviceRemoteXpcState
                                == "wdaStarting" else {
                            return
                        }
                        self.acceptOnDeviceRemoteXpcState("wdaReady")
                    }
                    return
                } catch {
                    if let runnerFailure =
                        OnDeviceRemoteXPCBridge.shared.wdaFailure() {
                        self?.queue.async {
                            guard let self,
                                  self.currentOnDeviceRemoteXpcState
                                    == "wdaStarting" else {
                                return
                            }
                            self.acceptOnDeviceRemoteXpcState(
                                "wdaStartError:\(runnerFailure)"
                            )
                        }
                        return
                    }
                    lastError = error.localizedDescription
                        .prefix(120)
                        .replacingOccurrences(of: "\n", with: " ")
                }
                if attempt < 60 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
            self?.queue.async {
                guard let self,
                      self.currentOnDeviceRemoteXpcState == "wdaStarting" else {
                    return
                }
                self.acceptOnDeviceRemoteXpcState(
                    "wdaNotReady:\(lastError)"
                )
            }
        }
    }

    private func sendRemotePairingServiceStatus() {
        guard let task = webSocketTask else { return }
        if !hasReceivedPairRecord() {
            task.send(.data(OnDeviceRemoteXPCBridge.capabilityHello)) {
                [weak self] error in
                if let error {
                    self?.logger.error(
                        "On-device RemoteXPC capability send failed: \(error.localizedDescription, privacy: .public)"
                    )
                }
            }
        }
        var payload: [String: Any] = [
            "type": "remotePairingServiceStatus",
            "state": currentRemotePairingState,
            "onDeviceRemoteXpcState": currentOnDeviceRemoteXpcState,
            "mainAppRemoteXpcState": UserDefaults(
                suiteName: PacketTunnelSharedConfig.appGroup
            )?.string(forKey: "mainAppRemoteXpcState") ?? "unknown",
            "transport": "deviceLoopback",
            "loopbackPackets": deviceLoopbackPacketsRecycled
        ]
        if let service = currentRemotePairingService {
            payload["identifier"] = service.identifier
            payload["port"] = Int(service.port)
            payload["txtBase64"] = service.txtRecord.base64EncodedString()
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        task.send(.string(text)) { [weak self] error in
            if let error {
                self?.logger.error(
                    "RemotePairing service status send failed: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }

    private func markPairRecordReceived() {
        pairRecordStateLock.lock()
        pairRecordReceived = true
        pairRecordStateLock.unlock()
    }

    private func hasReceivedPairRecord() -> Bool {
        pairRecordStateLock.lock()
        defer { pairRecordStateLock.unlock() }
        return pairRecordReceived
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        queue.async { [weak self] in
            guard let self, webSocketTask === self.webSocketTask else { return }
            UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(Date().timeIntervalSince1970, forKey: "packetTunnelControllerLastSeenAt")
            self.sendPairingProxyStatus()
            self.sendRemotePairingServiceStatus()
            OnDeviceRemoteXPCBridge.shared.resendRawSetup {
                [weak self] frame in
                self?.sendPacket(frame)
            }
        }
    }

    private func packetProtocol(_ packet: Data) -> Int32 {
        let first = packet[packet.startIndex]
        let version = first >> 4
        return version == 6 ? Int32(AF_INET6) : Int32(AF_INET)
    }

    private func startPingTimer() {
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 10, repeating: 10)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.sendDeviceAgentLease()
            self.sendPairingProxyStatus()
            self.refreshOnDeviceWdaReadiness()
            self.refreshMainAppWdaReadiness()
            self.sendRemotePairingServiceStatus()
            let activeSocket = self.webSocketTask
            activeSocket?.sendPing { error in
                if let error {
                    self.logger.error("Packet overlay ping failed: \(error.localizedDescription, privacy: .public)")
                    self.scheduleReconnect(reason: "ping failed")
                } else {
                    self.queue.async {
                        guard activeSocket === self.webSocketTask, self.controlAllowed else { return }
                        UserDefaults(suiteName: PacketTunnelSharedConfig.appGroup)?.set(Date().timeIntervalSince1970, forKey: "packetTunnelControllerLastSeenAt")
                    }
                }
            }
        }
        pingTimer = timer
        timer.resume()
    }

    private static func iso8601Date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// Keep checking the WDA instance owned by the Packet Tunnel after its
    /// initial launch. The startup probe used to stop permanently at
    /// `wdaReady`, which left the Controller with a stale ready state when iOS
    /// later killed or uninstalled WDA. This follows the same three-attempt
    /// health check already used for a main-app-owned WDA session.
    private func refreshOnDeviceWdaReadiness() {
        guard onDeviceWdaHealthTask == nil,
              currentOnDeviceRemoteXpcState == "wdaReady",
              let wdaClient else {
            return
        }
        onDeviceWdaHealthTask = Task { [weak self] in
            var lastError = "notReady"
            for attempt in 1...3 {
                guard !Task.isCancelled else { return }
                do {
                    try await wdaClient.probeStatus()
                    self?.queue.async {
                        self?.onDeviceWdaHealthTask = nil
                    }
                    return
                } catch {
                    lastError = error.localizedDescription
                        .prefix(120)
                        .replacingOccurrences(of: "\n", with: " ")
                }
                if attempt < 3 {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
            self?.queue.async {
                guard let self else { return }
                self.onDeviceWdaHealthTask = nil
                guard self.currentOnDeviceRemoteXpcState == "wdaReady" else {
                    return
                }
                self.acceptOnDeviceRemoteXpcState(
                    "wdaLost:\(lastError)"
                )
            }
        }
    }

    private func refreshMainAppWdaReadiness() {
        guard mainAppWdaProbeTask == nil,
              let defaults = UserDefaults(
                suiteName: PacketTunnelSharedConfig.appGroup
              ),
              let state = defaults.string(
                forKey: "mainAppRemoteXpcState"
              ),
              state == "wdaStarting" || state == "wdaReady",
              let wdaClient else {
            return
        }
        let attempts = state == "wdaStarting" ? 60 : 3
        mainAppWdaProbeTask = Task { [weak self] in
            var lastError = "notReady"
            for attempt in 1...attempts {
                guard !Task.isCancelled else { return }
                do {
                    try await wdaClient.probeStatus()
                    self?.queue.async {
                        guard let self else { return }
                        defaults.set(
                            "wdaReady",
                            forKey: "mainAppRemoteXpcState"
                        )
                        self.mainAppWdaProbeTask = nil
                        self.sendRemotePairingServiceStatus()
                    }
                    return
                } catch {
                    lastError = error.localizedDescription
                        .prefix(120)
                        .replacingOccurrences(of: "\n", with: " ")
                }
                if attempt < attempts {
                    try? await Task.sleep(nanoseconds: 1_000_000_000)
                }
            }
            self?.queue.async {
                guard let self else { return }
                let prefix = state == "wdaReady"
                    ? "wdaLost"
                    : "wdaNotReady"
                defaults.set(
                    "\(prefix):\(lastError)",
                    forKey: "mainAppRemoteXpcState"
                )
                self.mainAppWdaProbeTask = nil
                self.sendRemotePairingServiceStatus()
            }
        }
    }

    private func scheduleReconnect(reason: String) {
        queue.async { [weak self] in
            guard let self,
                  !self.tunnelStopped,
                  self.reconnectWorkItem == nil,
                  let controllerUrl = self.currentControllerUrl,
                  let deviceId = self.currentDeviceId,
                  let agentToken = self.currentAgentToken else {
                return
            }
            self.logger.info("Packet overlay scheduling reconnect after \(reason, privacy: .public)")
            self.pingTimer?.cancel()
            self.pingTimer = nil
            self.webSocketTask?.cancel(with: .goingAway, reason: nil)
            self.webSocketTask = nil
            self.remotePairingWebSocketProxy?.disconnect()
            self.session?.invalidateAndCancel()
            self.session = nil
            let workItem = DispatchWorkItem { [weak self] in
                guard let self, !self.tunnelStopped else { return }
                self.reconnectWorkItem = nil
                self.connectWebSocket(controllerUrl: controllerUrl, deviceId: deviceId, agentToken: agentToken)
            }
            self.reconnectWorkItem = workItem
            self.queue.asyncAfter(deadline: .now() + 2, execute: workItem)
        }
    }

    private func overlayWebSocketUrl(controllerUrl: String, deviceId: String) -> URL? {
        guard var components = URLComponents(string: controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return nil
        }
        if components.scheme == "https" {
            components.scheme = "wss"
        } else if components.scheme == "http" {
            components.scheme = "ws"
        } else if components.scheme == nil {
            components.scheme = "wss"
        }
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let encodedDeviceId = deviceId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? deviceId
        components.path = basePath.isEmpty
            ? "/packet-overlay/\(encodedDeviceId)"
            : "/\(basePath)/packet-overlay/\(encodedDeviceId)"
        components.queryItems = [
            URLQueryItem(name: "role", value: "ios"),
            URLQueryItem(name: "clientBuild", value: currentClientBuild),
            URLQueryItem(name: "configurationRevision", value: String(currentConfigurationRevision)),
            URLQueryItem(name: "networkMode", value: currentNetworkMode),
            URLQueryItem(name: "controlVersion", value: "1")
        ]
        return components.url
    }

    private func streamWebSocketUrl(
        controllerUrl: String,
        streamId: String
    ) -> URL? {
        guard var components = URLComponents(
            string: controllerUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        ) else {
            return nil
        }
        if components.scheme == "https" {
            components.scheme = "wss"
        } else if components.scheme == "http" {
            components.scheme = "ws"
        } else if components.scheme == nil {
            components.scheme = "wss"
        }
        let basePath = components.path.trimmingCharacters(
            in: CharacterSet(charactersIn: "/")
        )
        let encodedStreamId = streamId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? streamId
        components.path = basePath.isEmpty
            ? "/agent/streams/\(encodedStreamId)"
            : "/\(basePath)/agent/streams/\(encodedStreamId)"
        components.queryItems = nil
        return components.url
    }

    private static func randomId() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    private static func jsonText(_ value: [String: Any]) -> String {
        String(
            data: try! JSONSerialization.data(withJSONObject: value),
            encoding: .utf8
        )!
    }

    private static func sha256(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

private struct PacketTunnelPendingUpload {
    let commandId: String
    let purpose: String
    let contentType: String
    let bytes: Data
    let result: [String: Any]
}

private struct PairableHostAdvertisement: Equatable {
    let identifier: String
    let remotePort: UInt16
    let txtRecord: Data

    var key: String {
        "\(identifier):\(remotePort):\(txtRecord.base64EncodedString())"
    }
}

private enum PairableHostMDNSParser {
    private static let serviceSuffix = "._remotepairing-pairable-host._tcp.local"

    static func parse(_ packet: Data) -> PairableHostAdvertisement? {
        guard let dnsOffset = dnsPayloadOffset(packet) else { return nil }
        let dns = packet.subdata(in: dnsOffset..<packet.count)
        guard dns.count >= 12 else { return nil }
        let questionCount = Int(readUInt16(dns, 4))
        let recordCount = Int(readUInt16(dns, 6))
            + Int(readUInt16(dns, 8))
            + Int(readUInt16(dns, 10))
        var cursor = 12
        for _ in 0..<questionCount {
            guard readName(dns, cursor: &cursor) != nil, cursor + 4 <= dns.count else {
                return nil
            }
            cursor += 4
        }

        var ports: [String: UInt16] = [:]
        var txtRecords: [String: Data] = [:]
        for _ in 0..<recordCount {
            guard let recordName = readName(dns, cursor: &cursor),
                  cursor + 10 <= dns.count else {
                return nil
            }
            let type = readUInt16(dns, cursor)
            let dataLength = Int(readUInt16(dns, cursor + 8))
            cursor += 10
            guard dataLength >= 0, cursor + dataLength <= dns.count else { return nil }
            let dataStart = cursor
            let dataEnd = cursor + dataLength
            if type == 33, dataLength >= 6 {
                ports[recordName.lowercased()] = readUInt16(dns, dataStart + 4)
            } else if type == 16 {
                txtRecords[recordName.lowercased()] = dns.subdata(in: dataStart..<dataEnd)
            }
            cursor = dataEnd
        }

        for (recordName, port) in ports where port > 0 {
            guard recordName.hasSuffix(serviceSuffix),
                  let txtRecord = txtRecords[recordName],
                  let fields = parseTXT(txtRecord),
                  let identifier = fields["identifier"],
                  !identifier.isEmpty,
                  recordName == identifier.lowercased() + serviceSuffix,
                  fields["authTag"]?.isEmpty == false,
                  fields["model"]?.isEmpty == false else {
                continue
            }
            return PairableHostAdvertisement(
                identifier: identifier,
                remotePort: port,
                txtRecord: txtRecord
            )
        }
        return nil
    }

    private static func dnsPayloadOffset(_ packet: Data) -> Int? {
        guard packet.count >= 28 else { return nil }
        let version = packet[packet.startIndex] >> 4
        if version == 4 {
            let headerLength = Int(packet[packet.startIndex] & 0x0f) * 4
            guard headerLength >= 20,
                  packet.count >= headerLength + 8,
                  packet[packet.startIndex + 9] == UInt8(IPPROTO_UDP),
                  readUInt16(packet, headerLength + 2) == 5353 else {
                return nil
            }
            return headerLength + 8
        }
        if version == 6 {
            guard packet.count >= 48,
                  packet[packet.startIndex + 6] == UInt8(IPPROTO_UDP),
                  readUInt16(packet, 42) == 5353 else {
                return nil
            }
            return 48
        }
        return nil
    }

    private static func parseTXT(_ data: Data) -> [String: String]? {
        var result: [String: String] = [:]
        var cursor = 0
        while cursor < data.count {
            let length = Int(data[data.startIndex + cursor])
            cursor += 1
            guard length > 0, cursor + length <= data.count,
                  let field = String(
                    data: data.subdata(in: cursor..<(cursor + length)),
                    encoding: .utf8
                  ) else {
                return nil
            }
            cursor += length
            let parts = field.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            if parts.count == 2 {
                result[String(parts[0])] = String(parts[1])
            }
        }
        return result
    }

    private static func readName(_ data: Data, cursor: inout Int) -> String? {
        var labels: [String] = []
        var position = cursor
        var continuation = cursor
        var followedPointer = false
        var visited: Set<Int> = []
        for _ in 0..<64 {
            guard position < data.count, !visited.contains(position) else { return nil }
            visited.insert(position)
            let length = Int(data[data.startIndex + position])
            if length == 0 {
                if !followedPointer { continuation = position + 1 }
                cursor = continuation
                return labels.joined(separator: ".")
            }
            if length & 0xc0 == 0xc0 {
                guard position + 1 < data.count else { return nil }
                let pointer = ((length & 0x3f) << 8)
                    | Int(data[data.startIndex + position + 1])
                if !followedPointer { continuation = position + 2 }
                followedPointer = true
                position = pointer
                continue
            }
            guard length <= 63,
                  position + 1 + length <= data.count,
                  let label = String(
                    data: data.subdata(in: (position + 1)..<(position + 1 + length)),
                    encoding: .utf8
                  ) else {
                return nil
            }
            labels.append(label)
            position += 1 + length
            if !followedPointer { continuation = position }
        }
        return nil
    }

    private static func readUInt16(_ data: Data, _ offset: Int) -> UInt16 {
        (UInt16(data[data.startIndex + offset]) << 8)
            | UInt16(data[data.startIndex + offset + 1])
    }
}

private let pairingProxyRecordCallback: DNSServiceRegisterRecordReply = {
    _, _, _, _, _ in
}

private final class PairingServiceProxy {
    private let queue: DispatchQueue
    private let log: (String) -> Void
    private let status: (String, UInt16?) -> Void
    private var serviceRef: DNSServiceRef?
    private var recordConnection: DNSServiceRef?
    private var ipv4Record: DNSRecordRef?
    private var ipv6Record: DNSRecordRef?
    private var advertisementKey: String?
    private var activePort: UInt16?

    init(
        queue: DispatchQueue,
        log: @escaping (String) -> Void,
        status: @escaping (String, UInt16?) -> Void
    ) {
        self.queue = queue
        self.log = log
        self.status = status
    }

    func update(_ advertisement: PairableHostAdvertisement) {
        queue.async { [weak self] in
            self?.apply(advertisement)
        }
    }

    func stop() {
        queue.async { [weak self] in
            self?.stopRegistration()
        }
    }

    private func apply(_ advertisement: PairableHostAdvertisement) {
        guard advertisement.key != advertisementKey else { return }
        stopRegistration()
        advertisementKey = advertisement.key
        activePort = advertisement.remotePort
        status("bonjourStarting", nil)

        let hostName = advertisement.identifier + ".local."
        var recordConnection: DNSServiceRef?
        var error = DNSServiceCreateConnection(&recordConnection)
        guard error == kDNSServiceErr_NoError, let recordConnection else {
            fail("Could not create Bonjour proxy record connection", error)
            return
        }
        self.recordConnection = recordConnection
        error = DNSServiceSetDispatchQueue(recordConnection, queue)
        guard error == kDNSServiceErr_NoError else {
            fail("Could not schedule Bonjour proxy records", error)
            return
        }

        let ipv4 = [UInt8](arrayLiteral: 198, 18, 0, 1)
        error = hostName.withCString { name in
            ipv4.withUnsafeBytes { bytes in
                DNSServiceRegisterRecord(
                    recordConnection,
                    &ipv4Record,
                    DNSServiceFlags(kDNSServiceFlagsKnownUnique),
                    0,
                    name,
                    UInt16(kDNSServiceType_A),
                    UInt16(kDNSServiceClass_IN),
                    UInt16(bytes.count),
                    bytes.baseAddress,
                    120,
                    pairingProxyRecordCallback,
                    nil
                )
            }
        }
        guard error == kDNSServiceErr_NoError else {
            fail("Could not register Bonjour proxy IPv4 address", error)
            return
        }

        let ipv6: [UInt8] = [
            0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 1
        ]
        error = hostName.withCString { name in
            ipv6.withUnsafeBytes { bytes in
                DNSServiceRegisterRecord(
                    recordConnection,
                    &ipv6Record,
                    DNSServiceFlags(kDNSServiceFlagsKnownUnique),
                    0,
                    name,
                    UInt16(kDNSServiceType_AAAA),
                    UInt16(kDNSServiceClass_IN),
                    UInt16(bytes.count),
                    bytes.baseAddress,
                    120,
                    pairingProxyRecordCallback,
                    nil
                )
            }
        }
        guard error == kDNSServiceErr_NoError else {
            fail("Could not register Bonjour proxy IPv6 address", error)
            return
        }

        var serviceRef: DNSServiceRef?
        error = advertisement.identifier.withCString { serviceName in
            hostName.withCString { targetHost in
                advertisement.txtRecord.withUnsafeBytes { txt in
                    DNSServiceRegister(
                        &serviceRef,
                        0,
                        0,
                        serviceName,
                        "_remotepairing-pairable-host._tcp",
                        "local.",
                        targetHost,
                        advertisement.remotePort.bigEndian,
                        UInt16(txt.count),
                        txt.baseAddress,
                        nil,
                        nil
                    )
                }
            }
        }
        guard error == kDNSServiceErr_NoError, let serviceRef else {
            fail("Could not register remote Device Hub Bonjour service", error)
            return
        }
        self.serviceRef = serviceRef
        error = DNSServiceSetDispatchQueue(serviceRef, queue)
        guard error == kDNSServiceErr_NoError else {
            fail("Could not schedule remote Device Hub Bonjour service", error)
            return
        }
        log("Remote Device Hub Bonjour proxy registered for \(hostName):\(advertisement.remotePort)")
        status("bonjourReady", advertisement.remotePort)
    }

    private func fail(_ message: String, _ error: DNSServiceErrorType) {
        log("\(message): DNSService error \(error)")
        status("bonjourFailed", nil)
        advertisementKey = nil
        activePort = nil
        stopRegistration()
    }

    private func stopRegistration() {
        if let serviceRef {
            DNSServiceRefDeallocate(serviceRef)
            self.serviceRef = nil
        }
        if let recordConnection {
            DNSServiceRefDeallocate(recordConnection)
            self.recordConnection = nil
        }
        ipv4Record = nil
        ipv6Record = nil
        activePort = nil
        advertisementKey = nil
    }
}

private struct RemotePairingServiceAdvertisement: Equatable {
    let identifier: String
    let serviceName: String
    let port: UInt16
    let txtRecord: Data
    let targetHosts: [String]
}

/// Multiplexes RemotePairing TCP bytes inside the already long-lived Packet
/// Tunnel WebSocket. Binary stream frames use a non-IP magic prefix, so the
/// Controller can relay them alongside ordinary overlay IP packets without
/// parsing or persisting PairVerify/TLS contents.
private enum RemotePairingStreamFrame {
    enum Opcode: UInt8 {
        case open = 1
        case opened = 2
        case data = 3
        case close = 4
        case error = 5
    }

    static let magic = Data("SRVTCP01".utf8)
    static let headerSize = magic.count + 16 + 1
    static let maximumPayloadSize = 32 * 1024

    static func encode(
        streamId: UUID,
        opcode: Opcode,
        payload: Data = Data()
    ) -> Data? {
        guard payload.count <= maximumPayloadSize else { return nil }
        var result = magic
        var uuidBytes = streamId.uuid
        withUnsafeBytes(of: &uuidBytes) { bytes in
            result.append(contentsOf: bytes)
        }
        result.append(opcode.rawValue)
        result.append(payload)
        return result
    }

    static func decode(_ frame: Data) -> (UUID, Opcode, Data)? {
        guard frame.count >= headerSize,
              frame.starts(with: magic),
              let opcode = Opcode(rawValue: frame[magic.count + 16]) else {
            return nil
        }
        var uuidBytes: uuid_t = (
            0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0
        )
        withUnsafeMutableBytes(of: &uuidBytes) { destination in
            _ = frame.copyBytes(
                to: destination,
                from: magic.count..<(magic.count + 16)
            )
        }
        let payload = frame.subdata(in: headerSize..<frame.count)
        guard payload.count <= maximumPayloadSize else { return nil }
        return (UUID(uuid: uuidBytes), opcode, payload)
    }
}

private final class RemotePairingWebSocketProxy {
    private let queue: DispatchQueue
    private let requiredInterface: NWInterface
    private let log: (String) -> Void
    private let sendFrame: (Data) -> Void
    private var target: RemotePairingServiceAdvertisement?
    private var connections: [UUID: RemotePairingWebSocketConnection] = [:]

    init(
        queue: DispatchQueue,
        requiredInterface: NWInterface,
        log: @escaping (String) -> Void,
        sendFrame: @escaping (Data) -> Void
    ) {
        self.queue = queue
        self.requiredInterface = requiredInterface
        self.log = log
        self.sendFrame = sendFrame
    }

    func update(_ advertisement: RemotePairingServiceAdvertisement?) {
        queue.async { [weak self] in
            guard let self, self.target != advertisement else { return }
            let serviceChanged = self.target == nil
                || advertisement == nil
                || self.target?.identifier != advertisement?.identifier
                || self.target?.port != advertisement?.port
            if serviceChanged {
                self.closeAllOnQueue(notifyPeer: true)
            }
            self.target = advertisement
        }
    }

    func handleFrame(_ frame: Data) -> Bool {
        guard let decoded = RemotePairingStreamFrame.decode(frame) else {
            return false
        }
        queue.async { [weak self] in
            self?.handle(
                streamId: decoded.0,
                opcode: decoded.1,
                payload: decoded.2
            )
        }
        return true
    }

    func disconnect() {
        queue.async { [weak self] in
            self?.closeAllOnQueue(notifyPeer: false)
        }
    }

    func stop() {
        queue.async { [weak self] in
            self?.closeAllOnQueue(notifyPeer: false)
            self?.target = nil
        }
    }

    private func handle(
        streamId: UUID,
        opcode: RemotePairingStreamFrame.Opcode,
        payload: Data
    ) {
        switch opcode {
        case .open:
            open(streamId: streamId, initialData: payload)
        case .data:
            connections[streamId]?.send(payload)
        case .close:
            let connection = connections.removeValue(forKey: streamId)
            connection?.cancel(notifyPeer: false)
        case .opened, .error:
            break
        }
    }

    private func open(streamId: UUID, initialData: Data) {
        guard connections[streamId] == nil else {
            send(streamId: streamId, opcode: .error, message: "duplicate stream")
            return
        }
        guard target != nil else {
            send(
                streamId: streamId,
                opcode: .error,
                message: "RemotePairing service is unavailable"
            )
            return
        }
        guard initialData.count >= 2 else {
            send(
                streamId: streamId,
                opcode: .error,
                message: "missing RemotePairing target port"
            )
            return
        }
        let targetPort = (UInt16(initialData[initialData.startIndex]) << 8)
            | UInt16(initialData[initialData.startIndex + 1])
        guard targetPort > 0 else {
            send(
                streamId: streamId,
                opcode: .error,
                message: "invalid RemotePairing target port"
            )
            return
        }
        let forwardedData = initialData.subdata(in: 2..<initialData.count)
        let connection = RemotePairingWebSocketConnection(
            streamId: streamId,
            // Direct app/extension connections to loopback, Wi-Fi, or the
            // Bonjour-scoped RemotePairing endpoint are rejected by iOS
            // interface policy. The packetFlow address swap gives this
            // connection the same device-local path proven by LocalDevVPN and
            // StikDebug while Linux remains the RemotePairing protocol peer.
            targetHosts: [DeviceLoopback.peerAddress],
            targetPort: targetPort,
            requiredInterface: requiredInterface,
            queue: queue,
            onOpened: { [weak self] id in
                self?.send(streamId: id, opcode: .opened)
            },
            onData: { [weak self] id, data in
                self?.send(streamId: id, opcode: .data, payload: data)
            },
            onClosed: { [weak self] id, error in
                guard let self else { return }
                self.connections.removeValue(forKey: id)
                if let error {
                    self.log("Native RemotePairing stream failed: \(error)")
                    self.send(
                        streamId: id,
                        opcode: .error,
                        message: "native RemotePairing connection failed"
                    )
                } else {
                    self.send(streamId: id, opcode: .close)
                }
            }
        )
        connections[streamId] = connection
        connection.send(forwardedData)
        connection.start()
    }

    private func send(
        streamId: UUID,
        opcode: RemotePairingStreamFrame.Opcode,
        payload: Data = Data()
    ) {
        guard let frame = RemotePairingStreamFrame.encode(
            streamId: streamId,
            opcode: opcode,
            payload: payload
        ) else {
            return
        }
        sendFrame(frame)
    }

    private func send(
        streamId: UUID,
        opcode: RemotePairingStreamFrame.Opcode,
        message: String
    ) {
        send(
            streamId: streamId,
            opcode: opcode,
            payload: Data(message.prefix(256).utf8)
        )
    }

    private func closeAllOnQueue(notifyPeer: Bool) {
        let active = connections
        connections.removeAll()
        for connection in active.values {
            connection.cancel(notifyPeer: notifyPeer)
        }
    }
}

private final class RemotePairingWebSocketConnection {
    private let streamId: UUID
    private let targetHosts: [String]
    private let targetPort: UInt16
    private let requiredInterface: NWInterface
    private let queue: DispatchQueue
    private let onOpened: (UUID) -> Void
    private let onData: (UUID, Data) -> Void
    private let onClosed: (UUID, String?) -> Void
    private var connection: NWConnection?
    private var targetIndex = 0
    private var connectTimeoutWorkItem: DispatchWorkItem?
    private var pendingWrites: [Data] = []
    private var pendingBytes = 0
    private var preResponseWrites: [Data] = []
    private var sending = false
    private var opened = false
    private var reportedOpened = false
    private var closed = false

    init(
        streamId: UUID,
        targetHosts: [String],
        targetPort: UInt16,
        requiredInterface: NWInterface,
        queue: DispatchQueue,
        onOpened: @escaping (UUID) -> Void,
        onData: @escaping (UUID, Data) -> Void,
        onClosed: @escaping (UUID, String?) -> Void
    ) {
        self.streamId = streamId
        self.targetHosts = targetHosts
        self.targetPort = targetPort
        self.requiredInterface = requiredInterface
        self.queue = queue
        self.onOpened = onOpened
        self.onData = onData
        self.onClosed = onClosed
    }

    func start() {
        startNextTarget()
    }

    func send(_ data: Data) {
        guard !closed, !data.isEmpty else { return }
        guard data.count <= RemotePairingStreamFrame.maximumPayloadSize,
              pendingBytes + data.count <= 4 * 1024 * 1024 else {
            finish(error: "write buffer limit exceeded")
            return
        }
        if !reportedOpened {
            preResponseWrites.append(data)
        }
        pendingWrites.append(data)
        pendingBytes += data.count
        sendNext()
    }

    func cancel(notifyPeer: Bool) {
        finish(error: nil, notifyPeer: notifyPeer)
    }

    private func startNextTarget() {
        guard !closed else { return }
        guard targetIndex < targetHosts.count else {
            finish(error: "no reachable native RemotePairing endpoint")
            return
        }
        let targetHost = targetHosts[targetIndex]
        targetIndex += 1
        let parameters = NWParameters.tcp
        // In-provider networking must be explicitly scoped to the packet
        // tunnel's virtual interface. Merely adding an included route does not
        // guarantee that a connection created by the provider itself will
        // re-enter packetFlow.
        parameters.requiredInterface = requiredInterface
        parameters.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host(DeviceLoopback.localAddress),
            port: .any
        )
        let connection = NWConnection(
            host: NWEndpoint.Host(targetHost),
            port: NWEndpoint.Port(rawValue: targetPort)!,
            using: parameters
        )
        self.connection = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection, self.connection === connection else {
                return
            }
            self.handle(state, connection: connection)
        }
        let timeout = DispatchWorkItem { [weak self, weak connection] in
            guard let self, let connection, self.connection === connection,
                  !self.reportedOpened, !self.closed else {
                return
            }
            self.retryNextTarget(
                connection: connection,
                error: "native RemotePairing connection timed out"
            )
        }
        connectTimeoutWorkItem = timeout
        queue.asyncAfter(deadline: .now() + 4, execute: timeout)
        connection.start(queue: queue)
    }

    private func handle(
        _ state: NWConnection.State,
        connection: NWConnection
    ) {
        guard !closed, self.connection === connection else { return }
        switch state {
        case .ready:
            guard !opened else { return }
            opened = true
            sendNext()
            receive()
        case .failed(let error):
            if !reportedOpened {
                retryNextTarget(
                    connection: connection,
                    error: error.localizedDescription
                )
            } else {
                finish(error: error.localizedDescription)
            }
        case .cancelled:
            if self.connection === connection {
                if !reportedOpened {
                    retryNextTarget(
                        connection: connection,
                        error: "native RemotePairing connection cancelled"
                    )
                } else {
                    finish(error: nil)
                }
            }
        default:
            break
        }
    }

    private func sendNext() {
        guard opened, !closed, !sending, let data = pendingWrites.first else {
            return
        }
        sending = true
        guard let connection else { return }
        connection.send(content: data, completion: .contentProcessed {
            [weak self, weak connection] error in
            guard let self, let connection, !self.closed,
                  self.connection === connection else {
                return
            }
            self.sending = false
            if let error {
                if !self.reportedOpened {
                    self.retryNextTarget(
                        connection: connection,
                        error: error.localizedDescription
                    )
                } else {
                    self.finish(error: error.localizedDescription)
                }
                return
            }
            self.pendingWrites.removeFirst()
            self.pendingBytes -= data.count
            self.sendNext()
        })
    }

    private func receive() {
        guard opened, !closed else { return }
        guard let connection else { return }
        connection.receive(
            minimumIncompleteLength: 1,
            maximumLength: RemotePairingStreamFrame.maximumPayloadSize
        ) { [weak self, weak connection] data, _, isComplete, error in
            guard let self, let connection, !self.closed,
                  self.connection === connection else {
                return
            }
            if let data, !data.isEmpty {
                if !self.reportedOpened {
                    self.connectTimeoutWorkItem?.cancel()
                    self.connectTimeoutWorkItem = nil
                    self.reportedOpened = true
                    self.preResponseWrites.removeAll()
                    self.onOpened(self.streamId)
                }
                self.onData(self.streamId, data)
            }
            if let error {
                if !self.reportedOpened {
                    self.retryNextTarget(
                        connection: connection,
                        error: error.localizedDescription
                    )
                } else {
                    self.finish(error: error.localizedDescription)
                }
            } else if isComplete {
                if !self.reportedOpened {
                    self.retryNextTarget(
                        connection: connection,
                        error: "native RemotePairing closed before responding"
                    )
                } else {
                    self.finish(error: nil)
                }
            } else {
                self.receive()
            }
        }
    }

    private func retryNextTarget(
        connection: NWConnection,
        error: String
    ) {
        guard !closed, self.connection === connection else { return }
        connectTimeoutWorkItem?.cancel()
        connectTimeoutWorkItem = nil
        self.connection = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        opened = false
        sending = false
        pendingWrites = preResponseWrites
        pendingBytes = pendingWrites.reduce(0) { $0 + $1.count }
        if targetIndex < targetHosts.count {
            startNextTarget()
        } else {
            finish(error: error)
        }
    }

    private func finish(error: String?, notifyPeer: Bool = true) {
        guard !closed else { return }
        closed = true
        connectTimeoutWorkItem?.cancel()
        connectTimeoutWorkItem = nil
        connection?.stateUpdateHandler = nil
        connection?.cancel()
        connection = nil
        pendingWrites.removeAll()
        preResponseWrites.removeAll()
        pendingBytes = 0
        if notifyPeer {
            onClosed(streamId, error)
        }
    }
}

/// Discovers the iPhone-owned `_remotepairing._tcp` service inside the
/// long-lived Packet Tunnel process and reports its original service port.
/// The Linux host reaches that system listener through the packet overlay,
/// matching the previously verified no-wire WDA/CoreDevice transport.
private final class RemotePairingServiceBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
    private let log: (String) -> Void
    private let status: (String, RemotePairingServiceAdvertisement?) -> Void
    private var browser: NetServiceBrowser?
    private var services: [ObjectIdentifier: NetService] = [:]
    private var activeService: ObjectIdentifier?
    private var stopping = false

    init(
        log: @escaping (String) -> Void,
        status: @escaping (String, RemotePairingServiceAdvertisement?) -> Void
    ) {
        self.log = log
        self.status = status
    }

    func start() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.browser == nil else { return }
            self.stopping = false
            let browser = NetServiceBrowser()
            browser.delegate = self
            self.browser = browser
            self.status("browsing", nil)
            browser.searchForServices(ofType: "_remotepairing._tcp.", inDomain: "local.")
        }
    }

    func stop() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.stopping = true
            self.browser?.stop()
            self.browser?.delegate = nil
            self.browser = nil
            for service in self.services.values {
                service.stop()
                service.delegate = nil
            }
            self.services.removeAll()
            self.activeService = nil
        }
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didFind service: NetService,
        moreComing: Bool
    ) {
        let key = ObjectIdentifier(service)
        services[key] = service
        service.delegate = self
        service.resolve(withTimeout: 10)
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didRemove service: NetService,
        moreComing: Bool
    ) {
        let key = ObjectIdentifier(service)
        service.stop()
        service.delegate = nil
        services.removeValue(forKey: key)
        if activeService == key {
            activeService = nil
            status("unavailable", nil)
        }
    }

    func netServiceBrowser(
        _ browser: NetServiceBrowser,
        didNotSearch errorDict: [String: NSNumber]
    ) {
        log("RemotePairing Bonjour browse failed: \(errorDict)")
        status("failed", nil)
    }

    func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        if !stopping {
            status("unavailable", nil)
        }
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let normalized = sender.name.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard UUID(uuidString: normalized) != nil,
              sender.port > 0,
              sender.port <= Int(UInt16.max),
              !resolvedRemotePairingTargets(sender).isEmpty,
              let txt = sender.txtRecordData(),
              !txt.isEmpty else {
            log("Ignored incomplete RemotePairing Bonjour service \(sender.name)")
            return
        }
        let advertisement = RemotePairingServiceAdvertisement(
            identifier: normalized,
            serviceName: sender.name,
            port: UInt16(sender.port),
            txtRecord: txt,
            targetHosts: resolvedRemotePairingTargets(sender)
        )
        activeService = ObjectIdentifier(sender)
        log("RemotePairing service discovered on the iPhone tunnel endpoint:\(advertisement.port)")
        status("ready", advertisement)
    }

    private func resolvedRemotePairingTargets(_ service: NetService) -> [String] {
        var hosts = ["127.0.0.1", "::1"]
        hosts.append(
            contentsOf: (service.addresses ?? [])
                .compactMap(numericHost)
                .filter { !$0.isUnspecified }
                .sorted {
                    ($0.remotePairingRank, $0.lowercased())
                        < ($1.remotePairingRank, $1.lowercased())
                }
        )
        if let wifiAddress = wifiIPv4Address() {
            hosts.append(wifiAddress)
        }
        if let hostName = service.hostName, !hostName.isEmpty {
            hosts.append(hostName)
        }
        var seen = Set<String>()
        return hosts.filter { seen.insert($0.lowercased()).inserted }
    }

    private func wifiIPv4Address() -> String? {
        var interfaces: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&interfaces) == 0, let first = interfaces else {
            return nil
        }
        defer { freeifaddrs(interfaces) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = cursor {
            defer { cursor = interface.pointee.ifa_next }
            guard String(cString: interface.pointee.ifa_name) == "en0",
                  let address = interface.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET) else {
                continue
            }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                address,
                socklen_t(address.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
            if result == 0 {
                return String(cString: host)
            }
        }
        return nil
    }

    private func numericHost(_ address: Data) -> String? {
        guard !address.isEmpty else { return nil }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let result = address.withUnsafeBytes { bytes -> Int32 in
            guard let baseAddress = bytes.bindMemory(to: sockaddr.self).baseAddress else {
                return EAI_FAIL
            }
            return getnameinfo(
                baseAddress,
                socklen_t(address.count),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            )
        }
        guard result == 0 else { return nil }
        return String(cString: host)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        log("RemotePairing Bonjour resolve failed for \(sender.name): \(errorDict)")
    }
}

private extension String {
    var isUnspecified: Bool {
        let host = lowercased().split(separator: "%", maxSplits: 1).first.map(String.init) ?? ""
        return host == "::" || host == "0.0.0.0"
    }

    var isLoopbackOrUnspecified: Bool {
        let host = lowercased().split(separator: "%", maxSplits: 1).first.map(String.init) ?? ""
        return isUnspecified
            || host == "::1"
            || host.hasPrefix("127.")
    }

    var remotePairingRank: Int {
        let host = lowercased().split(separator: "%", maxSplits: 1).first.map(String.init) ?? ""
        let octets = host.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4 {
            if octets[0] == 10
                || (octets[0] == 172 && (16...31).contains(octets[1]))
                || (octets[0] == 192 && octets[1] == 168) {
                return 0
            }
            if octets[0] != 169 || octets[1] != 254 {
                return 1
            }
            return 3
        }
        if host.hasPrefix("fe80:") {
            return 2
        }
        return 4
    }
}

private func packetTunnelIntValue(
    _ value: Any?,
    defaultValue: Int = 0
) -> Int {
    if let value = value as? Int {
        return value
    }
    if let value = value as? NSNumber {
        return value.intValue
    }
    if let value = value as? Double {
        return Int(value)
    }
    return defaultValue
}

private final class PacketTunnelWdaClient {
    private let baseUrl: String
    private let targetBundleId: String
    private let targetUdid: String?
    private var sessionId: String?
    private var createFreshSession = false

    init(baseUrl: String, targetBundleId: String, targetUdid: String?) {
        self.baseUrl = baseUrl.trimmingCharacters(
            in: CharacterSet(charactersIn: "/")
        )
        self.targetBundleId = targetBundleId
        self.targetUdid = targetUdid
    }

    func tap(x: Int, y: Int) async throws {
        _ = try await withValidSession { session in
            try await self.request(
                method: "POST",
                path: "/session/\(session)/actions",
                jsonBody: [
                    "actions": [[
                        "type": "pointer",
                        "id": "finger1",
                        "parameters": ["pointerType": "touch"],
                        "actions": [
                            [
                                "type": "pointerMove",
                                "duration": 0,
                                "x": x,
                                "y": y,
                                "origin": "viewport"
                            ],
                            ["type": "pointerDown", "button": 0],
                            ["type": "pause", "duration": 100],
                            ["type": "pointerUp", "button": 0]
                        ]
                    ]]
                ]
            )
        }
    }

    func swipe(
        fromX: Int,
        fromY: Int,
        toX: Int,
        toY: Int,
        durationMs: Int
    ) async throws {
        _ = try await withValidSession { session in
            try await self.request(
                method: "POST",
                path: "/session/\(session)/actions",
                jsonBody: [
                    "actions": [[
                        "type": "pointer",
                        "id": "finger1",
                        "parameters": ["pointerType": "touch"],
                        "actions": [
                            [
                                "type": "pointerMove",
                                "duration": 0,
                                "x": fromX,
                                "y": fromY,
                                "origin": "viewport"
                            ],
                            ["type": "pointerDown", "button": 0],
                            [
                                "type": "pointerMove",
                                "duration": durationMs,
                                "x": toX,
                                "y": toY,
                                "origin": "viewport"
                            ],
                            ["type": "pointerUp", "button": 0]
                        ]
                    ]]
                ]
            )
        }
    }

    func typeText(_ text: String) async throws {
        _ = try await withValidSession { session in
            try await self.request(
                method: "POST",
                path: "/session/\(session)/wda/keys",
                jsonBody: [
                    "text": text,
                    "value": text.map { String($0) }
                ]
            )
        }
    }

    func launchApp(_ bundleId: String) async throws {
        guard !bundleId.isEmpty else {
            throw PacketTunnelControlError.message(
                "bundleId/appId is required"
            )
        }
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
            try await self.request(
                method: "GET",
                path: "/session/\(session)/screenshot",
                jsonBody: nil
            )
        }
        if let json = response.jsonObject(),
           let value = json["value"] as? String {
            return value
        }
        if response.contentType.lowercased().contains("image/") {
            return response.body.base64EncodedString()
        }
        throw PacketTunnelControlError.message(
            "Screenshot response did not contain image data"
        )
    }

    func source() async throws -> String {
        let response = try await withValidSession { session in
            try await self.request(
                method: "GET",
                path: "/session/\(session)/source",
                jsonBody: nil
            )
        }
        if let json = response.jsonObject() {
            if let value = json["value"] as? String {
                return value
            }
            let data = try JSONSerialization.data(
                withJSONObject: json,
                options: [.prettyPrinted]
            )
            return String(data: data, encoding: .utf8) ?? "{}"
        }
        return String(data: response.body, encoding: .utf8) ?? ""
    }

    func probeStatus() async throws {
        _ = try await request(
            method: "GET",
            path: "/status",
            jsonBody: nil,
            timeout: 3
        )
    }

    func request(
        method: String,
        path: String,
        jsonBody: Any?,
        timeout: TimeInterval = 240
    ) async throws -> PacketTunnelWdaResponse {
        guard let url = URL(
            string: baseUrl + (path.hasPrefix("/") ? path : "/\(path)")
        ) else {
            throw PacketTunnelControlError.message("Invalid WDA URL")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        if let jsonBody {
            guard JSONSerialization.isValidJSONObject(jsonBody) else {
                throw PacketTunnelControlError.message(
                    "WDA request body is not valid JSON"
                )
            }
            request.setValue(
                "application/json",
                forHTTPHeaderField: "content-type"
            )
            request.httpBody = try JSONSerialization.data(
                withJSONObject: jsonBody
            )
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PacketTunnelControlError.message(
                "No HTTP response from WDA"
            )
        }
        if http.statusCode >= 400 {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw PacketTunnelControlError.message(
                "WDA HTTP \(http.statusCode): \(text)"
            )
        }
        return PacketTunnelWdaResponse(
            status: http.statusCode,
            headers: http.allHeaderFields,
            body: data
        )
    }

    private func withValidSession(
        _ operation: (String) async throws -> PacketTunnelWdaResponse
    ) async throws -> PacketTunnelWdaResponse {
        let session = try await ensureSession()
        do {
            return try await operation(session)
        } catch {
            guard isInvalidSession(error) else { throw error }
            sessionId = nil
            createFreshSession = true
            return try await operation(try await ensureSession())
        }
    }

    private func ensureSession() async throws -> String {
        if let sessionId {
            return sessionId
        }
        if !createFreshSession {
            if let existing = try await existingSessionId() {
                sessionId = existing
                return existing
            }
        }
        let response = try await request(
            method: "POST",
            path: "/session",
            jsonBody: [
                "capabilities": [
                    "alwaysMatch": [String: Any]()
                ]
            ]
        )
        guard let json = response.jsonObject() else {
            throw PacketTunnelControlError.message(
                "WDA session response was not JSON"
            )
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
        throw PacketTunnelControlError.message(
            "WDA did not return a session id"
        )
    }

    private func existingSessionId() async throws -> String? {
        let response = try await request(
            method: "GET",
            path: "/status",
            jsonBody: nil
        )
        guard let json = response.jsonObject() else {
            return nil
        }
        if let id = json["sessionId"] as? String, !id.isEmpty {
            return id
        }
        if let value = json["value"] as? [String: Any],
           let id = value["sessionId"] as? String,
           !id.isEmpty {
            return id
        }
        return nil
    }

    private func isInvalidSession(_ error: Error) -> Bool {
        let message = error.localizedDescription.lowercased()
        return message.contains("invalid session id")
            || message.contains(
                "session is either terminated or not started"
            )
            || (message.contains("application under test")
                && message.contains("not running"))
    }
}

private struct PacketTunnelWdaResponse {
    let status: Int
    let headers: [AnyHashable: Any]
    let body: Data

    var contentType: String {
        for (key, value) in headers
        where String(describing: key).lowercased() == "content-type" {
            return String(describing: value)
        }
        return "application/octet-stream"
    }

    func jsonObject() -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    }

    func toCommandResult() -> [String: Any] {
        var normalizedHeaders: [String: String] = [:]
        for (key, value) in headers {
            normalizedHeaders[String(describing: key)] = String(
                describing: value
            )
        }
        return [
            "type": "wdaHttpResponse",
            "status": status,
            "headers": normalizedHeaders,
            "bodyBase64": body.base64EncodedString()
        ]
    }
}

private enum PacketTunnelControlError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            return message
        }
    }
}

enum PacketTunnelError: LocalizedError {
    case missingConfiguration
    case invalidControllerUrl
    case missingVirtualInterface

    var errorDescription: String? {
        switch self {
        case .missingConfiguration:
            return "Packet Tunnel is missing controllerUrl, deviceId, or agentToken"
        case .invalidControllerUrl:
            return "Packet Tunnel controller URL is invalid"
        case .missingVirtualInterface:
            return "Packet Tunnel virtual interface is unavailable"
        }
    }
}
