import Foundation
import Darwin
import os

#if GALATEA_IDEVICE_REQUIRED && !targetEnvironment(simulator)
#if !canImport(idevice)
#error("PacketTunnel device builds require the generated idevice module")
#endif
#endif

#if canImport(idevice)
import idevice
#endif

final class OnDeviceRemoteXPCBridge: @unchecked Sendable {
    static let shared = OnDeviceRemoteXPCBridge()
    static let capabilityHello = Data("SRVHELLO1".utf8)
    static let pairRecordMagic = Data("SRVPAIR1".utf8)
    static let pairRecordAcknowledgement = Data("SRVACK01".utf8)
    static let rawTunnelMagic = Data("SRVRPX1".utf8)
    static let rawTunnelSetup: UInt8 = 1
    static let rawTunnelPacket: UInt8 = 2
    static let rawTunnelResync: UInt8 = 3
    static let wdaRunnerBundleId =
        (Bundle.main.object(forInfoDictionaryKey: "GalateaWdaRunnerBundleIdentifier") as? String ?? "dev.galatea.wda.xctrunner")
    private static let appGroup =
        (Bundle.main.object(forInfoDictionaryKey: "GalateaAppGroup") as? String ?? "group.dev.galatea.agent")
    private static let pairRecordFileName = "remote-pairing.plist"
    private static let stagedWdaPackageName = "GalateaWDA-PureLinux.ipa"
    private static let pendingWdaPackageSha256Key = "pendingWdaPackageSha256"

    private let queue = DispatchQueue(label: "serverized.on-device-remotexpc")
    private let logger = Logger(
        subsystem: (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel",
        category: "RawRemoteXPC"
    )
    private var pairRecord: Data?
    private var running = false
    private var rawPacketsFromLinux: UInt64 = 0

#if canImport(idevice)
    private var rawTunnel: OpaquePointer?
    private var rawPacketSink: UnsafeMutableRawPointer?
    private var rawSetupFrame: Data?
    private var adapter: OpaquePointer?
    private var handshake: OpaquePointer?
    private var remoteServer: OpaquePointer?
    private var screenshotClient: OpaquePointer?
#if GALATEA_IDEVICE_XCTEST
    private var wdaRun: OpaquePointer?
#endif
#endif

    private init() {}

    func consumePairRecordFrame(
        _ frame: Data,
        port: UInt16,
        interfaceIndex: UInt32,
        sendFrame: @escaping (Data) -> Void,
        status: @escaping (String) -> Void
    ) -> Bool {
        guard frame.count > Self.pairRecordMagic.count,
              frame.starts(with: Self.pairRecordMagic) else {
            return false
        }
        let record = frame.dropFirst(Self.pairRecordMagic.count)
        guard record.count <= 4096 else {
            status("recordTooLarge")
            return true
        }
        queue.async {
            self.pairRecord = Data(record)
            do {
                try self.persistPairRecord(Data(record))
                self.startLocalWdaOnQueue(
                    port: port,
                    interfaceIndex: interfaceIndex,
                    status: status
                )
            } catch {
                self.running = false
                status("recordStoreError:\(error.localizedDescription)")
            }
        }
        return true
    }

    func startIfAvailable(
        port: UInt16,
        interfaceIndex: UInt32,
        sendFrame: @escaping (Data) -> Void,
        status: @escaping (String) -> Void
    ) {
        _ = sendFrame
        queue.async {
            guard UserDefaults(suiteName: Self.appGroup)?.bool(
                forKey: "controlAllowed"
            ) == true else { return }
            // A controller reconnect must not be required to resend a private
            // system-pairing record. The device owns this persisted driver
            // credential, independently of the application-level controller.
            if self.pairRecord == nil {
                do {
                    self.pairRecord = try self.loadPersistedPairRecord()
                } catch {
                    status("recordLoadError:invalidOrUnavailableRecord")
                    return
                }
            }
            self.startLocalWdaOnQueue(
                port: port,
                interfaceIndex: interfaceIndex,
                status: status
            )
        }
    }

    func restartForStagedWda(
        port: UInt16,
        interfaceIndex: UInt32,
        status: @escaping (String) -> Void
    ) {
        queue.async {
#if canImport(idevice) && GALATEA_IDEVICE_XCTEST
            if let wdaRun = self.wdaRun {
                xctest_wda_run_free(wdaRun)
                self.wdaRun = nil
            }
#endif
            self.running = false
            self.startLocalWdaOnQueue(
                port: port,
                interfaceIndex: interfaceIndex,
                status: status
            )
        }
    }

    func stop() {
        queue.sync {
#if canImport(idevice)
            if let rawTunnel {
                raw_tunnel_free(rawTunnel)
                self.rawTunnel = nil
            }
            if let rawPacketSink {
                Unmanaged<RawTunnelPacketSink>
                    .fromOpaque(rawPacketSink)
                    .release()
                self.rawPacketSink = nil
            }
            rawSetupFrame = nil
            rawPacketsFromLinux = 0
#if GALATEA_IDEVICE_XCTEST
            if let wdaRun {
                xctest_wda_run_free(wdaRun)
                self.wdaRun = nil
            }
#endif
            if let screenshotClient {
                screenshot_client_free(screenshotClient)
                self.screenshotClient = nil
            }
            if let remoteServer {
                remote_server_free(remoteServer)
                self.remoteServer = nil
            }
            if let handshake {
                rsd_handshake_free(handshake)
                self.handshake = nil
            }
            if let adapter {
                adapter_free(adapter)
                self.adapter = nil
            }
#endif
            running = false
            // Reload from the protected App Group file on the next start. A
            // local reset may have removed it while this extension was alive.
            pairRecord = nil
        }
    }

    func resendRawSetup(sendFrame: @escaping (Data) -> Void) {
        queue.async {
#if canImport(idevice)
            if let frame = self.rawSetupFrame {
                sendFrame(frame)
            }
#endif
        }
    }

    func handleRawTunnelFrame(
        _ frame: Data,
        sendFrame: @escaping (Data) -> Void
    ) -> Bool {
        guard frame.count > Self.rawTunnelMagic.count,
              frame.starts(with: Self.rawTunnelMagic) else {
            return false
        }
        let opcodeIndex = Self.rawTunnelMagic.count
        if frame[opcodeIndex] == Self.rawTunnelResync {
            queue.async {
#if canImport(idevice)
                if let setup = self.rawSetupFrame {
                    sendFrame(setup)
                } else {
                    sendFrame(Self.capabilityHello)
                }
#else
                sendFrame(Self.capabilityHello)
#endif
            }
            return true
        }
        guard frame[opcodeIndex] == Self.rawTunnelPacket else {
            return true
        }
        let packet = frame.dropFirst(opcodeIndex + 1)
        guard packet.count >= 40, packet.first.map({ $0 >> 4 == 6 }) == true else {
            return true
        }
        queue.async {
#if canImport(idevice)
            guard let rawTunnel = self.rawTunnel else { return }
            let error = packet.withUnsafeBytes { bytes in
                raw_tunnel_send_packet(
                    rawTunnel,
                    bytes.bindMemory(to: UInt8.self).baseAddress,
                    UInt(bytes.count)
                )
            }
            if let error {
                let detail = self.message(error)
                self.logger.error(
                    "Raw RemoteXPC write failed: \(detail, privacy: .public)"
                )
                idevice_error_free(error)
            } else {
                self.rawPacketsFromLinux += 1
                if self.rawPacketsFromLinux == 1
                    || self.rawPacketsFromLinux.isMultiple(of: 16) {
                    self.logger.info(
                        "Raw RemoteXPC packets Linux-to-iPhone=\(self.rawPacketsFromLinux, privacy: .public)"
                    )
                }
            }
#endif
        }
        return true
    }

    var isReady: Bool {
        queue.sync {
#if canImport(idevice)
            return screenshotClient != nil
#else
            return false
#endif
        }
    }

    func wdaFailure() -> String? {
        queue.sync {
#if canImport(idevice) && GALATEA_IDEVICE_XCTEST
            guard let wdaRun,
                  let error = xctest_wda_run_error(wdaRun) else {
                return nil
            }
            let detail = message(error)
            idevice_error_free(error)
            return detail
#else
            return nil
#endif
        }
    }

    func screenshot() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
#if canImport(idevice)
                guard let screenshotClient = self.screenshotClient else {
                    continuation.resume(
                        throwing: OnDeviceRemoteXPCError.notReady
                    )
                    return
                }
                var bytes: UnsafeMutablePointer<UInt8>?
                var length: UInt = 0
                let error = screenshot_client_take_screenshot(
                    screenshotClient,
                    &bytes,
                    &length
                )
                if let error {
                    let detail = self.message(error)
                    idevice_error_free(error)
                    continuation.resume(
                        throwing: OnDeviceRemoteXPCError.operation(detail)
                    )
                    return
                }
                guard let bytes, length > 0, length <= 32 * 1024 * 1024 else {
                    if let bytes {
                        idevice_data_free(bytes, length)
                    }
                    continuation.resume(
                        throwing: OnDeviceRemoteXPCError.invalidScreenshot
                    )
                    return
                }
                let data = Data(bytes: bytes, count: Int(length))
                idevice_data_free(bytes, length)
                continuation.resume(returning: data)
#else
                continuation.resume(
                    throwing: OnDeviceRemoteXPCError.unavailable
                )
#endif
            }
        }
    }

    private func startOnQueue(
        port: UInt16,
        interfaceIndex: UInt32,
        sendFrame: @escaping (Data) -> Void,
        status: @escaping (String) -> Void
    ) {
        guard !running, let pairRecord else { return }
        running = true
        status("connecting")

#if canImport(idevice)
        var pairingFile: OpaquePointer?
        let parseError = pairRecord.withUnsafeBytes { bytes in
            rp_pairing_file_from_bytes(
                bytes.bindMemory(to: UInt8.self).baseAddress,
                UInt(bytes.count),
                &pairingFile
            )
        }
        if let parseError {
            status("recordError:\(message(parseError))")
            idevice_error_free(parseError)
            running = false
            return
        }
        guard let pairingFile else {
            status("recordError:missingHandle")
            running = false
            return
        }
        defer { rp_pairing_file_free(pairingFile) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        guard "10.7.0.1".withCString({
            inet_pton(AF_INET, $0, &address.sin_addr)
        }) == 1 else {
            status("addressError")
            running = false
            return
        }

        let sink = Unmanaged.passRetained(
            RawTunnelPacketSink(sendFrame: sendFrame)
        )
        let sinkPointer = sink.toOpaque()
        var newRawTunnel: OpaquePointer?
        let tunnelError = "ServerizedMobileAgent".withCString { hostname in
            withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(
                    to: sockaddr.self,
                    capacity: 1
                ) { socketAddress in
                    tunnel_create_rppairing_raw(
                        socketAddress,
                        socklen_t(MemoryLayout<sockaddr_in>.stride),
                        interfaceIndex,
                        hostname,
                        pairingFile,
                        nil,
                        nil,
                        { data, length, context in
                            guard let data, let context, length >= 40 else {
                                return
                            }
                            let sink = Unmanaged<RawTunnelPacketSink>
                                .fromOpaque(context)
                                .takeUnretainedValue()
                            var frame = OnDeviceRemoteXPCBridge.rawTunnelMagic
                            frame.append(OnDeviceRemoteXPCBridge.rawTunnelPacket)
                            frame.append(data, count: Int(length))
                            sink.send(frame)
                        },
                        sinkPointer,
                        &newRawTunnel
                    )
                }
            }
        }
        if let tunnelError {
            status("tunnelError:\(message(tunnelError))")
            idevice_error_free(tunnelError)
            sink.release()
            running = false
            return
        }
        guard let newRawTunnel else {
            status("tunnelError:missingHandle")
            sink.release()
            running = false
            return
        }
        var clientAddress = [CChar](repeating: 0, count: 64)
        var serverAddress = [CChar](repeating: 0, count: 64)
        var mtu: UInt16 = 0
        var rsdPort: UInt16 = 0
        let infoError = clientAddress.withUnsafeMutableBufferPointer { client in
            serverAddress.withUnsafeMutableBufferPointer { server in
                raw_tunnel_get_info(
                    newRawTunnel,
                    client.baseAddress,
                    UInt(client.count),
                    server.baseAddress,
                    UInt(server.count),
                    &mtu,
                    &rsdPort
                )
            }
        }
        if let infoError {
            status("tunnelInfoError:\(message(infoError))")
            idevice_error_free(infoError)
            raw_tunnel_free(newRawTunnel)
            sink.release()
            running = false
            return
        }
        let client = String(cString: clientAddress)
        let server = String(cString: serverAddress)
        let metadata: [String: Any] = [
            "clientAddress": client,
            "serverAddress": server,
            "mtu": Int(mtu),
            "rsdPort": Int(rsdPort)
        ]
        guard JSONSerialization.isValidJSONObject(metadata),
              let payload = try? JSONSerialization.data(withJSONObject: metadata) else {
            raw_tunnel_free(newRawTunnel)
            sink.release()
            status("tunnelInfoError:invalidMetadata")
            running = false
            return
        }
        var setup = Self.rawTunnelMagic
        setup.append(Self.rawTunnelSetup)
        setup.append(payload)
        rawTunnel = newRawTunnel
        rawPacketSink = sinkPointer
        rawSetupFrame = setup
        sendFrame(setup)
        sink.takeUnretainedValue().activate()
        status("rawTunnelReady")
#else
        status("ideviceUnavailable")
        running = false
#endif
    }

    private func loadPersistedPairRecord() throws -> Data? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else { return nil }
        let url = container.appendingPathComponent(Self.pairRecordFileName)
        return try Self.readPersistedPairRecord(at: url)
    }

    static func readPersistedPairRecord(at url: URL) throws -> Data? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber,
              size.intValue > 0, size.intValue <= 4096 else {
            throw OnDeviceRemoteXPCError.operation("Invalid saved pairing record")
        }
        let record = try Data(contentsOf: url)
        guard !record.isEmpty, record.count <= 4096,
              let fields = try PropertyListSerialization.propertyList(
                from: record, options: [], format: nil
              ) as? [String: Any],
              (fields["public_key"] as? Data)?.count == 32,
              (fields["private_key"] as? Data)?.count == 32,
              (fields["alt_irk"] as? Data)?.count == 16,
              let identifier = fields["identifier"] as? String,
              !identifier.isEmpty else {
            throw OnDeviceRemoteXPCError.operation("Invalid saved pairing record")
        }
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600,
             .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
        return record
    }

    private func persistPairRecord(_ record: Data) throws {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroup
        ) else {
            throw OnDeviceRemoteXPCError.operation(
                "App Group container is unavailable"
            )
        }
        let url = container.appendingPathComponent(
            Self.pairRecordFileName
        )
        try record.write(to: url, options: [.atomic])
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600, .protectionKey:
                FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
    }

#if !(canImport(idevice) && GALATEA_IDEVICE_XCTEST)
    // UI-only simulator builds cannot host the physical RemoteXPC driver.
    private func startLocalWdaOnQueue(port: UInt16, interfaceIndex: UInt32, status: @escaping (String) -> Void) {
        running = false
        status("unavailable:physical-device-driver-required")
    }
#endif
#if canImport(idevice)
#if GALATEA_IDEVICE_XCTEST
    private func startLocalWdaOnQueue(
        port: UInt16,
        interfaceIndex: UInt32,
        status: @escaping (String) -> Void
    ) {
        guard !running, let pairRecord else { return }
        running = true
        status("connecting")

        var pairingFile: OpaquePointer?
        let parseError = pairRecord.withUnsafeBytes { bytes in
            rp_pairing_file_from_bytes(
                bytes.bindMemory(to: UInt8.self).baseAddress,
                UInt(bytes.count),
                &pairingFile
            )
        }
        if let parseError {
            let detail = message(parseError)
            idevice_error_free(parseError)
            failLocalWdaOnQueue("recordError:\(detail)", status: status)
            return
        }
        guard let pairingFile else {
            failLocalWdaOnQueue(
                "recordError:missingHandle",
                status: status
            )
            return
        }
        defer { rp_pairing_file_free(pairingFile) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.stride)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        guard "10.7.0.1".withCString({
            inet_pton(AF_INET, $0, &address.sin_addr)
        }) == 1 else {
            failLocalWdaOnQueue("addressError", status: status)
            return
        }

        var newAdapter: OpaquePointer?
        var newHandshake: OpaquePointer?
        let tunnelError = "ServerizedMobileAgent".withCString { hostname in
            withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(
                    to: sockaddr.self,
                    capacity: 1
                ) { socketAddress in
                    tunnel_create_rppairing(
                        socketAddress,
                        socklen_t(MemoryLayout<sockaddr_in>.stride),
                        interfaceIndex,
                        hostname,
                        pairingFile,
                        nil,
                        nil,
                        &newAdapter,
                        &newHandshake
                    )
                }
            }
        }
        if let tunnelError {
            let detail = message(tunnelError)
            idevice_error_free(tunnelError)
            failLocalWdaOnQueue("tunnelError:\(detail)", status: status)
            return
        }
        guard newAdapter != nil, newHandshake != nil else {
            if let newHandshake {
                rsd_handshake_free(newHandshake)
            }
            if let newAdapter {
                adapter_free(newAdapter)
            }
            failLocalWdaOnQueue(
                "tunnelError:missingHandle",
                status: status
            )
            return
        }
        defer {
            if let newHandshake {
                rsd_handshake_free(newHandshake)
            }
            if let newAdapter {
                adapter_free(newAdapter)
            }
        }
        guard installStagedWdaIfNeeded(
            adapter: newAdapter,
            handshake: newHandshake,
            status: status
        ) else {
            running = false
            return
        }
        startWdaOnQueue(
            adapter: &newAdapter,
            handshake: &newHandshake,
            status: status
        )
        if wdaRun == nil {
            running = false
        }
    }

    private func startWdaOnQueue(
        adapter: inout OpaquePointer?,
        handshake: inout OpaquePointer?,
        status: @escaping (String) -> Void
    ) {
        guard wdaRun == nil, adapter != nil, handshake != nil else { return }
        let majorVersion =
            ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        guard majorVersion >= 17, majorVersion <= Int(UInt8.max) else {
            status("wdaStartError:unsupportedIOSVersion")
            return
        }

        var newWdaRun: OpaquePointer?
        let startError = Self.wdaRunnerBundleId.withCString { bundleId in
            xctest_wda_start_rsd(
                &adapter,
                &handshake,
                bundleId,
                UInt8(majorVersion),
                &newWdaRun
            )
        }
        if let startError {
            status("wdaStartError:\(message(startError))")
            idevice_error_free(startError)
            return
        }
        guard let newWdaRun else {
            status("wdaStartError:missingHandle")
            return
        }
        wdaRun = newWdaRun
        status("wdaStarting")
    }

    private func installStagedWdaIfNeeded(
        adapter: OpaquePointer?,
        handshake: OpaquePointer?,
        status: @escaping (String) -> Void
    ) -> Bool {
        guard let defaults = UserDefaults(suiteName: Self.appGroup),
              defaults.string(
                forKey: Self.pendingWdaPackageSha256Key
              ) != nil else {
            return true
        }
        guard let adapter, let handshake,
              let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: Self.appGroup
              ) else {
            status("wdaInstallError:missingState")
            return false
        }
        let package = container.appendingPathComponent(
            Self.stagedWdaPackageName
        )
        guard FileManager.default.fileExists(atPath: package.path) else {
            defaults.removeObject(forKey: Self.pendingWdaPackageSha256Key)
            status("wdaInstallError:missingPackage")
            return false
        }
        status("wdaInstalling")
        let installError = package.path.withCString { path in
            xctest_wda_install_rsd(adapter, handshake, path)
        }
        if let installError {
            let detail = message(installError)
            idevice_error_free(installError)
            status("wdaInstallError:\(detail)")
            return false
        }
        defaults.removeObject(forKey: Self.pendingWdaPackageSha256Key)
        try? FileManager.default.removeItem(at: package)
        status("wdaInstalled")
        return true
    }

    private func failLocalWdaOnQueue(
        _ state: String,
        status: @escaping (String) -> Void
    ) {
        releaseLocalWdaHandlesOnQueue()
        running = false
        status(state)
    }

    private func releaseLocalWdaHandlesOnQueue() {
        if let handshake {
            rsd_handshake_free(handshake)
            self.handshake = nil
        }
        if let adapter {
            adapter_free(adapter)
            self.adapter = nil
        }
    }
#endif

    private func message(_ error: UnsafeMutablePointer<IdeviceFfiError>) -> String {
        guard let pointer = error.pointee.message,
              let value = String(validatingUTF8: pointer) else {
            return "code\(error.pointee.code)"
        }
        return value.prefix(160).replacingOccurrences(of: "\n", with: " ")
    }
#endif
}

private enum OnDeviceRemoteXPCError: LocalizedError {
    case unavailable
    case notReady
    case invalidScreenshot
    case operation(String)

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "On-device RemoteXPC support is not linked"
        case .notReady:
            return "On-device RemoteXPC is not ready"
        case .invalidScreenshot:
            return "On-device screenshot service returned invalid data"
        case .operation(let detail):
            return "On-device screenshot failed: \(detail)"
        }
    }
}

private final class RawTunnelPacketSink {
    private let logger = Logger(
        subsystem: (Bundle.main.object(forInfoDictionaryKey: "GalateaBaseBundleIdentifier") as? String ?? "dev.galatea.agent") + ".PacketTunnel",
        category: "RawRemoteXPC"
    )
    private let sendFrame: (Data) -> Void
    private let lock = NSLock()
    private var active = false
    private var pendingFrames: [Data] = []
    private var pendingBytes = 0
    private var packetsFromIPhone: UInt64 = 0

    init(sendFrame: @escaping (Data) -> Void) {
        self.sendFrame = sendFrame
    }

    func send(_ frame: Data) {
        lock.lock()
        if !active {
            if pendingFrames.count < 128
                && pendingBytes + frame.count <= 4 * 1024 * 1024 {
                pendingFrames.append(frame)
                pendingBytes += frame.count
            }
            lock.unlock()
            return
        }
        lock.unlock()
        deliver(frame)
    }

    func activate() {
        lock.lock()
        guard !active else {
            lock.unlock()
            return
        }
        active = true
        let frames = pendingFrames
        pendingFrames.removeAll(keepingCapacity: false)
        pendingBytes = 0
        for frame in frames {
            deliver(frame)
        }
        lock.unlock()
    }

    private func deliver(_ frame: Data) {
        packetsFromIPhone += 1
        if packetsFromIPhone == 1 || packetsFromIPhone.isMultiple(of: 16) {
            logger.info(
                "Raw RemoteXPC packets iPhone-to-Linux=\(self.packetsFromIPhone, privacy: .public)"
            )
        }
        sendFrame(frame)
    }
}
